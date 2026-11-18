import { realpath, stat, readdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, basename, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  openTransport,
  type CodexTransport,
  type WireParams,
} from '../../../packages/codex-transport/index.ts';
import type {
  Chat,
  Entry,
  Snapshot,
  HostInfo,
  PendingRequest,
  Delivery,
  QueuedMessage,
  AccountUsage,
} from '../../../packages/types.ts';
import { Store, PocketError } from './store.ts';
import { LocalChats, nativeEntryId } from './local-chats.ts';
import { DesktopSessions } from './desktop-sessions.ts';

export interface AgentTransport {
  request<T = WireParams>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
}
type Resolver = { resolve: (answer: unknown) => void; reject: (error: Error) => void };
const active = (c: Chat) =>
  ['running', 'waiting_approval', 'waiting_input', 'stopping'].includes(c.status);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class PocketService {
  transport: AgentTransport | null = null;
  ready = false;
  error: string | null = null;
  roots: string[] = [];
  models: Array<{ id: string; name: string }> = [];
  usage: AccountUsage = {
    accountType: null,
    plan: null,
    buckets: [],
    updatedAt: null,
    error: null,
  };
  private usageRefresh?: Promise<AccountUsage>;
  local: LocalChats;
  desktop: DesktopSessions;
  private continuing = new Set<string>();
  private loaded = new Set<string>();
  private liveRequests = new Map<string, Resolver>();
  private deltas = new Map<string, Entry>();
  private deltaTimer?: ReturnType<typeof setTimeout>;
  private draining = false;
  private closing = false;
  constructor(
    public store: Store,
    public host: HostInfo,
  ) {
    this.local = new LocalChats(store, () => this.agent());
    this.desktop = new DesktopSessions(
      store,
      (path) => this.directory(path),
      () => void this.drain(),
    );
    for (const chat of store.chats())
      if (chat.source === 'codex')
        store.putChat({
          ...chat,
          control: 'history',
          desktopConnected: false,
          status: 'history',
          turnId: null,
        });
    this.markUncertainSends();
    for (const c of store.chats())
      if (active(c))
        store.patchChat(c.id, {
          status: 'interrupted',
          turnId: null,
          error: '主机服务曾重启。请核对结果后再继续。',
        });
    for (const r of store.requests())
      if (r.status === 'pending') store.putRequest({ ...r, status: 'expired' });
    store.db
      .prepare(
        "UPDATE operations SET status='uncertain',error='服务重启，执行结果需要确认' WHERE status='pending'",
      )
      .run();
    // Queued messages were never sent. They remain visible, but require an explicit resend after a restart.
    for (const row of store.db.prepare('SELECT * FROM queue').all() as any[]) {
      try {
        store.patchChat(row.chat_id, {
          status: 'interrupted',
          error: '重启前排队的消息未自动发送，请确认后重新发送。',
        });
      } catch {}
      const entry = store.entry(`user:${row.operation_id}`);
      if (entry) store.putEntry({ ...entry, status: 'cancelled' });
    }
    store.db.prepare('DELETE FROM queue').run();
  }
  private markUncertainSends() {
    const rows = this.store.db
      .prepare(
        "SELECT body FROM entries WHERE json_extract(body,'$.kind')='user' AND json_extract(body,'$.status')='sending'",
      )
      .all() as { body: string }[];
    for (const row of rows) this.store.putEntry({ ...JSON.parse(row.body), status: 'uncertain' });
  }
  async start(roots: string[], factory = openTransport) {
    this.roots = await Promise.all(roots.map((r) => realpath(resolve(r))));
    this.transport = await factory({
      notification: (m, p) => {
        try {
          this.notification(m, p);
        } catch (e) {
          this.error = errorText(e);
        }
      },
      request: (m, p) => this.agentRequest(m, p),
      terminated: (e) => this.terminated(e),
    });
    try {
      await this.transport.request('initialize', {
        clientInfo: { name: 'codex_pocket', title: 'Codex Pocket', version: '0.1.0' },
        capabilities: { experimentalApi: false },
      });
      await this.transport.notify('initialized');
      const result = await this.transport.request('model/list', { limit: 100 });
      this.models = (result.data ?? []).map((m: any) => ({
        id: m.id,
        name: m.displayName ?? m.id,
      }));
      this.ready = true;
      this.error = null;
      this.store.emit('status');
    } catch (e) {
      this.error = errorText(e);
      await this.transport.close();
      this.transport = null;
      throw e;
    }
  }
  snapshot(): Snapshot {
    return {
      host: this.host,
      chats: this.store.chats(),
      requests: this.store.requests().filter((r) => r.status === 'pending'),
      cursor: this.store.cursor(),
      ready:
        this.ready || this.store.chats().some((c) => c.control === 'desktop' && c.desktopConnected),
      error: this.error,
      queue: this.queued(),
      favorites: this.favorites(),
      usage: this.usage,
    };
  }
  favorites(): string[] {
    return JSON.parse(this.store.meta('favorites') ?? '[]');
  }
  async favorite(path: string, saved: boolean) {
    // Removal must work even if a previously valid directory has disappeared.
    const actual = saved ? await this.directory(path) : path;
    const next = this.favorites().filter((p) => p !== actual);
    if (saved) next.push(actual);
    if (next.length > 50) throw new PocketError(400, '最多收藏 50 个目录');
    this.store.batch(() => {
      this.store.setMeta('favorites', JSON.stringify(next));
      this.store.publish('favorites', next);
    });
    return next;
  }
  organize(id: string, patch: { title?: string; pinned?: boolean }) {
    if (patch.title !== undefined && (!patch.title.trim() || patch.title.length > 120))
      throw new PocketError(400, '聊天名称需要 1 至 120 个字符');
    return this.store.patchChat(id, {
      ...(patch.title !== undefined ? { title: patch.title.trim(), customTitle: true } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
    });
  }
  queued(): QueuedMessage[] {
    return (this.store.db.prepare('SELECT * FROM queue ORDER BY position').all() as any[]).map(
      (r) => ({
        id: r.operation_id,
        chatId: r.chat_id,
        text: r.text,
        createdAt: this.store.entry(`user:${r.operation_id}`)?.createdAt ?? 0,
      }),
    );
  }
  cancelQueued(id: string) {
    const row = this.queued().find((r) => r.id === id);
    if (!row) throw new PocketError(409, '消息已开始发送或已移出队列，请检查聊天记录');
    this.store.batch(() => {
      this.store.db.prepare('DELETE FROM queue WHERE operation_id=?').run(id);
      const e = this.store.entry(`user:${id}`);
      if (e) this.store.putEntry({ ...e, status: 'cancelled' });
      const chat = this.store.chat(row.chatId);
      if (chat.status === 'queued' && !this.queued().some((r) => r.chatId === chat.id))
        this.store.patchChat(chat.id, { status: 'idle' });
      this.store.publish('queue', this.queued());
    });
    return { cancelled: true };
  }
  private applyLimits(result: any, replaceAll = true) {
    const previous = this.usage.buckets;
    const source =
      result.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === 'object'
        ? Object.values(result.rateLimitsByLimitId)
        : result.rateLimits
          ? [result.rateLimits]
          : [];
    this.usage = {
      ...this.usage,
      updatedAt: Date.now(),
      error: null,
      buckets: source
        .filter((b: any) => b && typeof b === 'object')
        .map((b: any) => ({
          id: String(b.limitId ?? 'codex'),
          name: String(b.limitName ?? b.limitId ?? 'Codex'),
          plan: typeof b.planType === 'string' ? b.planType : null,
          windows: [b.primary, b.secondary]
            .filter((w) => w && Number.isFinite(w.usedPercent))
            .map((w) => ({
              usedPercent: w.usedPercent,
              durationMins: Number.isFinite(w.windowDurationMins) ? w.windowDurationMins : null,
              resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt : null,
            })),
        })),
    };
    if (!replaceAll) {
      const updated = new Set(this.usage.buckets.map((b) => b.id));
      this.usage.buckets = [...previous.filter((b) => !updated.has(b.id)), ...this.usage.buckets];
    }
    this.store.publish('usage', this.usage);
  }
  refreshUsage(): Promise<AccountUsage> {
    if (this.usageRefresh) return this.usageRefresh;
    this.usageRefresh = (async () => {
      const agent = this.agent();
      const [account, limits] = await Promise.allSettled([
        agent.request('account/read', { refreshToken: false }),
        agent.request('account/rateLimits/read'),
      ]);
      if (this.closing) return this.usage;
      // Only display account metadata; credentials and email are never forwarded.
      if (account.status === 'fulfilled')
        this.usage = {
          ...this.usage,
          accountType: account.value.account?.type ?? null,
          plan: account.value.account?.planType ?? null,
        };
      if (limits.status === 'fulfilled') this.applyLimits(limits.value);
      else {
        this.usage = { ...this.usage, error: '当前账号未返回额度，或暂时无法读取。' };
        this.store.publish('usage', this.usage);
      }
      return this.usage;
    })().finally(() => {
      this.usageRefresh = undefined;
    });
    return this.usageRefresh;
  }
  private allowed(path: string) {
    return this.roots.some((root) => {
      const rel = relative(root, path);
      return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
    });
  }
  async directory(path: string) {
    const actual = await realpath(resolve(path));
    if (!this.allowed(actual)) throw new PocketError(403, '工作目录不在允许的项目范围内');
    if (!(await stat(actual)).isDirectory()) throw new PocketError(400, '请选择一个目录');
    return actual;
  }
  async directories(path?: string) {
    if (!path) return this.roots.map((path) => ({ name: basename(path), path }));
    const actual = await this.directory(path);
    const children = await readdir(actual, { withFileTypes: true });
    return children
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .slice(0, 200)
      .map((d) => ({ name: d.name, path: resolve(actual, d.name) }));
  }
  private agent() {
    if (!this.ready || !this.transport) throw new PocketError(503, this.error ?? 'Codex 尚未连接');
    return this.transport;
  }
  async operation(id: string, input: unknown, fn: () => Promise<unknown>) {
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(id)) throw new PocketError(400, '缺少有效的操作标识');
    const existing = this.store.beginOperation(id, input);
    if (existing) {
      if (existing.status === 'done') return existing.result;
      throw new PocketError(
        409,
        existing.status === 'pending'
          ? '该操作仍在处理中，请查看任务状态'
          : '该操作结果待确认，请检查聊天记录后再决定',
      );
    }
    try {
      const result = await fn();
      this.store.completeOperation(id, result);
      return result;
    } catch (e) {
      this.store.failOperation(id, errorText(e));
      throw e;
    }
  }
  async create(title: string, cwd: string, model: string | null) {
    const agent = this.agent();
    const path = await this.directory(cwd);
    if (model && !this.models.some((m) => m.id === model)) throw new PocketError(400, '模型不可用');
    const result = await agent.request('thread/start', {
      cwd: path,
      model: model || undefined,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    });
    if (typeof result.thread?.id !== 'string') throw new Error('Codex 没有返回聊天标识');
    const now = Date.now();
    const chat: Chat = {
      id: randomUUID(),
      nativeId: result.thread.id,
      title: title.trim().slice(0, 120) || '新聊天',
      cwd: path,
      model,
      status: 'idle',
      turnId: null,
      createdAt: now,
      updatedAt: now,
      error: null,
    };
    this.loaded.add(chat.id);
    this.store.putChat(chat);
    return chat;
  }
  async continueLocal(id: string) {
    const chat = this.store.chat(id);
    if (chat.control === 'desktop')
      throw new PocketError(409, '此聊天正在桌面同步，无需切换执行进程');
    if (chat.source !== 'codex') throw new PocketError(400, '请选择本机已有聊天');
    if (this.continuing.has(id)) throw new PocketError(409, '聊天正在连接，请稍后');
    if (chat.control === 'pocket' && this.loaded.has(id)) return chat;
    if (chat.acceptsInput === false) throw new PocketError(409, '此聊天不接受直接输入');
    this.continuing.add(id);
    try {
      const cwd = await this.directory(chat.cwd);
      const metadata = await this.agent().request('thread/read', { threadId: chat.nativeId });
      if (metadata.thread.cwd !== chat.cwd)
        throw new PocketError(409, '工作目录已改变，请刷新聊天列表');
      if (
        metadata.thread.canAcceptDirectInput === false ||
        metadata.thread.status?.type === 'active'
      )
        throw new PocketError(409, '聊天仍在其他客户端执行，请先在原端结束任务');
      const result = await this.agent().request('thread/resume', {
        threadId: chat.nativeId,
        excludeTurns: true,
        cwd,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
      });
      if (result.thread?.id !== chat.nativeId) throw new Error('恢复聊天标识不一致');
      this.loaded.add(id);
      this.local.invalidate(id);
      return this.store.patchChat(id, {
        control: 'pocket',
        cwd,
        status: 'idle',
        turnId: null,
        error: null,
        model: result.model ?? chat.model,
      });
    } catch (e) {
      if (/active writer|already.*loaded|already.*running/i.test(errorText(e)))
        throw new PocketError(
          409,
          '聊天被桌面端或其他进程占用，请在原端结束任务并释放聊天后重试；必要时退出原端应用',
        );
      throw e;
    } finally {
      this.continuing.delete(id);
    }
  }
  async releaseLocal(id: string) {
    const chat = this.store.chat(id);
    if (chat.control === 'desktop') throw new PocketError(409, '请使用断开桌面同步');
    if (chat.source !== 'codex') throw new PocketError(400, '请选择本机已有聊天');
    if (active(chat) || this.queued().some((row) => row.chatId === id) || this.continuing.has(id))
      throw new PocketError(409, '请先停止当前任务并清空排队消息');
    this.continuing.add(id);
    try {
      if (this.loaded.has(id)) {
        await this.agent().request('thread/unsubscribe', { threadId: chat.nativeId });
        // Unsubscribe acknowledges removal of the subscription, not release of its writer lock.
        const deadline = Date.now() + 10000;
        for (;;) {
          const loaded = await this.agent().request('thread/loaded/list', {});
          if (!loaded.data?.includes(chat.nativeId)) break;
          if (Date.now() >= deadline) throw new PocketError(409, '聊天仍在释放中，请稍后重试');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      this.loaded.delete(id);
      this.local.invalidate(id);
      return this.store.patchChat(id, {
        control: 'history',
        status: 'history',
        turnId: null,
        error: null,
      });
    } catch (error) {
      // An unsubscribe may already have succeeded. Never leave an apparently
      // controllable chat whose subscription and writer ownership are uncertain.
      this.loaded.delete(id);
      this.store.patchChat(id, {
        control: 'history',
        status: 'history',
        turnId: null,
        error: errorText(error),
      });
      throw error;
    } finally {
      this.continuing.delete(id);
    }
  }
  private async load(chat: Chat) {
    if (!this.loaded.has(chat.id)) {
      try {
        await this.agent().request('thread/resume', {
          threadId: chat.nativeId ?? chat.id,
          excludeTurns: true,
          cwd: chat.cwd,
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
        });
      } catch (e) {
        const durable = this.store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM entries WHERE chat_id=? AND (json_extract(body,'$.kind')!='user' OR json_extract(body,'$.status') IN ('sent','uncertain'))",
          )
          .get(chat.id) as { n: number };
        // Codex does not persist an empty native thread before its first turn.
        // Recreate only a genuinely unused thread, preserving our app chat ID.
        if (durable.n || !errorText(e).includes('no rollout found')) throw e;
        const result = await this.agent().request('thread/start', {
          cwd: chat.cwd,
          model: chat.model ?? undefined,
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
        });
        if (typeof result.thread?.id !== 'string') throw new Error('空聊天恢复失败');
        this.store.patchChat(chat.id, { nativeId: result.thread.id });
      }
      this.loaded.add(chat.id);
    }
  }
  async message(
    id: string,
    text: string,
    operationId: string,
    delivery: Delivery = 'queue',
    expectedTurnId?: string,
  ) {
    let chat = this.store.chat(id);
    if (chat.control === 'desktop') chat = await this.desktop.refresh(chat);
    else this.agent();
    if (
      chat.source === 'codex' &&
      chat.control !== 'desktop' &&
      (chat.control !== 'pocket' || !this.loaded.has(id) || this.continuing.has(id))
    )
      throw new PocketError(409, '请先选择在 Pocket 中继续此聊天');
    if (!this.allowed(chat.cwd)) throw new PocketError(403, '工作目录不在允许的项目范围内');
    if (delivery === 'steer' && (!chat.turnId || !active(chat) || chat.status === 'stopping'))
      throw new PocketError(409, '当前没有可追加指令的任务，请改为发送新任务');
    if (delivery === 'steer' && expectedTurnId !== undefined && expectedTurnId !== chat.turnId)
      throw new PocketError(409, '执行轮次已经改变，请确认当前任务后再补充指令');
    const entry: Entry = {
      id: `user:${operationId}`,
      chatId: id,
      turnId: delivery === 'steer' ? chat.turnId : null,
      kind: 'user',
      title: '你',
      text,
      status: delivery === 'steer' ? 'sending' : 'queued',
      createdAt: Date.now(),
    };
    if (delivery === 'steer') {
      this.store.putEntry(entry);
      try {
        const result =
          chat.control === 'desktop'
            ? await this.desktop.send(chat, text, operationId, chat.turnId!)
            : await this.agent().request('turn/steer', {
                threadId: chat.nativeId ?? chat.id,
                expectedTurnId: chat.turnId,
                input: [{ type: 'text', text, text_elements: [] }],
              });
        if (result.turnId !== chat.turnId) throw new Error('追加指令的执行标识未确认');
        this.store.putEntry({ ...entry, status: 'steered' });
        return { steered: true };
      } catch (e) {
        this.store.putEntry({ ...entry, status: 'uncertain' });
        throw e;
      }
    }
    this.store.batch(() => {
      this.store.putEntry(entry);
      // Persist the visible message, queue and metadata together before publishing.
      this.store.db
        .prepare('INSERT INTO queue(operation_id,chat_id,text) VALUES(?,?,?)')
        .run(operationId, id, text);
      if (!active(chat)) this.store.patchChat(id, { status: 'queued', error: null });
      this.store.publish('queue', this.queued());
    });
    void this.drain();
    return { queued: true };
  }
  async drain() {
    if (this.draining || (!this.ready && !this.desktop.bridge.connected) || this.closing) return;
    this.draining = true;
    try {
      const queue = this.store.db.prepare('SELECT * FROM queue ORDER BY position').all() as any[];
      for (const row of queue) {
        if (
          !this.store.db.prepare('SELECT 1 FROM queue WHERE operation_id=?').get(row.operation_id)
        )
          continue;
        const chat = this.store.chat(row.chat_id);
        if (chat.control !== 'desktop' && !this.ready) continue;
        if (this.store.chats().some((c) => c.cwd === chat.cwd && active(c))) continue;
        this.store.batch(() => {
          this.store.patchChat(chat.id, { status: 'running', error: null });
          // Persist the handoff boundary before I/O. A crash must leave an
          // uncertain message rather than a phantom item still labelled queued.
          this.store.db.prepare('DELETE FROM queue WHERE position=?').run(row.position);
          const entry = this.store.entry(`user:${row.operation_id}`)!;
          this.store.putEntry({ ...entry, status: 'sending' });
          this.store.publish('queue', this.queued());
        });
        try {
          await this.directory(chat.cwd);
          if (chat.control !== 'desktop') await this.load(chat);
          const result =
            chat.control === 'desktop'
              ? await this.desktop.send(chat, row.text, row.operation_id)
              : await this.agent().request('turn/start', {
                  threadId: this.store.chat(chat.id).nativeId ?? chat.id,
                  input: [{ type: 'text', text: row.text, text_elements: [] }],
                });
          if (typeof result.turn?.id !== 'string') throw new Error('Codex 没有返回执行标识');
          const current = this.store.chat(chat.id);
          if (active(current)) this.store.patchChat(chat.id, { turnId: result.turn.id });
          const entry = this.store.entry(`user:${row.operation_id}`)!;
          this.store.putEntry({ ...entry, turnId: result.turn.id, status: 'sent' });
        } catch (e) {
          this.store.patchChat(chat.id, { status: 'failed', turnId: null, error: errorText(e) });
          const entry = this.store.entry(`user:${row.operation_id}`)!;
          this.store.putEntry({ ...entry, status: 'uncertain' });
          for (const next of this.queued().filter((r) => r.chatId === chat.id))
            this.cancelQueued(next.id);
        }
      }
    } finally {
      this.draining = false;
      // A message may arrive while the worker awaits provider I/O, after its
      // current queue snapshot. Wake again only when some workspace is free.
      if ((this.ready || this.desktop.bridge.connected) && !this.closing) {
        const queued = this.store.db.prepare('SELECT chat_id FROM queue').all() as {
          chat_id: string;
        }[];
        if (
          queued.some((row) => {
            const chat = this.store.chat(row.chat_id);
            if (chat.control !== 'desktop' && !this.ready) return false;
            return !this.store.chats().some((c) => c.cwd === chat.cwd && active(c));
          })
        )
          queueMicrotask(() => void this.drain());
      }
    }
  }
  async stop(id: string, expectedTurnId?: string) {
    const chat = this.store.chat(id);
    if (expectedTurnId !== undefined && chat.turnId !== expectedTurnId)
      throw new PocketError(409, '执行轮次已经改变，请确认当前任务后再停止');
    if (chat.source === 'codex' && chat.control !== 'pocket' && chat.control !== 'desktop')
      throw new PocketError(409, '历史查看不能停止其他客户端的任务');
    const rows = this.store.db
      .prepare('SELECT operation_id FROM queue WHERE chat_id=?')
      .all(id) as any[];
    this.store.db.prepare('DELETE FROM queue WHERE chat_id=?').run(id);
    for (const r of rows) {
      const e = this.store.entry(`user:${r.operation_id}`);
      if (e) this.store.putEntry({ ...e, status: 'cancelled' });
    }
    this.store.publish('queue', this.queued());
    if (!chat.turnId) {
      if (chat.status === 'running') throw new PocketError(409, '任务正在启动，请稍后停止');
      if (chat.status === 'queued') this.store.patchChat(id, { status: 'interrupted' });
      return { stopped: !active(chat) };
    }
    this.store.patchChat(id, { status: 'stopping' });
    try {
      if (chat.control === 'desktop') await this.desktop.stop(chat);
      else
        await this.agent().request('turn/interrupt', {
          threadId: chat.nativeId ?? id,
          turnId: chat.turnId,
        });
    } catch (e) {
      this.store.patchChat(id, { error: '停止未确认：' + errorText(e) });
      throw e;
    }
    return { requested: true };
  }
  async respond(id: string, decision?: string, answers?: Record<string, string[]>) {
    const request = this.store.requests().find((r) => r.id === id);
    const live = this.liveRequests.get(id);
    if (!request || request.status !== 'pending' || (!live && !request.params._desktop))
      throw new PocketError(409, '此请求已处理或已失效');
    let response: unknown;
    if (request.kind === 'question') {
      const questions = request.params.questions ?? [];
      if (
        !answers ||
        questions.some(
          (q: any) =>
            !Array.isArray(answers[q.id]) ||
            !answers[q.id].some((v) => typeof v === 'string' && v.trim()),
        )
      )
        throw new PocketError(400, '请回答所有问题');
      response = {
        answers: Object.fromEntries(questions.map((q: any) => [q.id, { answers: answers[q.id] }])),
      };
    } else {
      if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision ?? ''))
        throw new PocketError(400, '无效的审批决定');
      const available = request.params.availableDecisions;
      if (Array.isArray(available) && !available.includes(decision))
        throw new PocketError(400, 'Codex 不支持此审批范围');
      response =
        request.method === 'item/permissions/requestApproval'
          ? {
              permissions: !['decline', 'cancel'].includes(decision!)
                ? request.params.permissions
                : {},
              scope: decision === 'acceptForSession' ? 'session' : 'turn',
            }
          : { decision };
    }
    if (request.params._desktop) return this.desktop.respond(request, response);
    // Claim synchronously before resolving the provider callback; competing clients lose here.
    this.store.putRequest({ ...request, status: 'resolved' });
    this.liveRequests.delete(id);
    live!.resolve(response);
    this.refreshWaiting(request.chatId);
    return { resolved: true };
  }
  private refreshWaiting(chatId: string) {
    const c = this.store.chat(chatId);
    if (!active(c) || c.status === 'stopping') return;
    const pending = this.store
      .requests()
      .filter((r) => r.chatId === chatId && r.status === 'pending');
    this.store.patchChat(chatId, {
      status: pending.some((r) => r.kind === 'approval')
        ? 'waiting_approval'
        : pending.length
          ? 'waiting_input'
          : 'running',
    });
  }
  agentRequest(method: string, params: WireParams): Promise<unknown> {
    const chat = this.store.chats().find((c) => (c.nativeId ?? c.id) === params.threadId);
    if (!chat) return Promise.reject(new Error('Unknown chat'));
    const kind = method === 'item/tool/requestUserInput' ? 'question' : 'approval';
    if (
      ![
        'item/tool/requestUserInput',
        'item/commandExecution/requestApproval',
        'item/fileChange/requestApproval',
        'item/permissions/requestApproval',
      ].includes(method)
    )
      return Promise.reject(new Error('Unsupported Codex request: ' + method));
    const request: PendingRequest = {
      id: randomUUID(),
      chatId: chat.id,
      turnId: params.turnId ?? null,
      method,
      kind,
      prompt:
        params.reason ??
        params.command ??
        (kind === 'question' ? 'Codex 需要你的回答' : 'Codex 请求操作权限'),
      params: {
        ...params,
        cwd: params.cwd ?? chat.cwd,
        command:
          params.command ??
          this.store.entry(nativeEntryId(chat, params.turnId, params.itemId))?.command,
        changes:
          params.changes ??
          (method === 'item/fileChange/requestApproval'
            ? (this.store.entry(nativeEntryId(chat, params.turnId, params.itemId))?.changes ??
              this.store.entry(nativeEntryId(chat, params.turnId, params.itemId))?.text)
            : undefined),
      },
      status: 'pending',
      createdAt: Date.now(),
    };
    const promise = new Promise((resolve, reject) =>
      this.liveRequests.set(request.id, { resolve, reject }),
    );
    this.store.putRequest(request);
    this.refreshWaiting(request.chatId);
    return promise;
  }
  private expire(chatId?: string, includeDesktop = true) {
    for (const r of this.store.requests())
      if (
        r.status === 'pending' &&
        (!chatId || r.chatId === chatId) &&
        (includeDesktop || !r.params._desktop)
      ) {
        this.liveRequests.get(r.id)?.reject(new Error('请求已失效'));
        this.liveRequests.delete(r.id);
        this.store.putRequest({ ...r, status: 'expired' });
      }
  }
  notification(method: string, p: WireParams) {
    if (method === 'account/rateLimits/updated') {
      this.applyLimits(p, false);
      return;
    }
    if (method === 'account/updated') {
      this.usage = {
        accountType: p.authMode ?? null,
        plan: p.planType ?? null,
        buckets: [],
        updatedAt: null,
        error: null,
      };
      this.store.publish('usage', this.usage);
      return;
    }
    if (!p.threadId) return;
    const chat = this.store.chats().find((c) => (c.nativeId ?? c.id) === p.threadId);
    if (!chat || (chat.source === 'codex' && chat.control !== 'pocket')) return;
    const chatId = chat.id;
    if (method === 'turn/started')
      this.store.patchChat(chatId, { turnId: p.turn.id, status: 'running', error: null });
    else if (method === 'turn/completed') {
      this.flushDeltas();
      this.local.invalidate(chatId);
      this.expire(chatId);
      const status =
        p.turn.status === 'completed'
          ? 'completed'
          : p.turn.status === 'interrupted'
            ? 'interrupted'
            : 'failed';
      this.store.patchChat(chatId, { status, turnId: null, error: p.turn.error?.message ?? null });
      if (status !== 'completed')
        for (const next of this.queued().filter((r) => r.chatId === chatId))
          this.cancelQueued(next.id);
      void this.drain();
    } else if (method === 'serverRequest/resolved') {
      // Native IDs can differ from item IDs; match explicit fields only.
      for (const r of this.store.requests())
        if (
          r.chatId === chatId &&
          r.status === 'pending' &&
          String(r.params._nativeRequestId) === String(p.requestId)
        ) {
          this.liveRequests.get(r.id)?.reject(new Error('Codex 已清除此请求'));
          this.liveRequests.delete(r.id);
          this.store.putRequest({ ...r, status: 'expired' });
        }
      this.refreshWaiting(chatId);
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = p.item;
      if (!item?.id || item.type === 'userMessage') return;
      const id = nativeEntryId(chat, p.turnId, item.id);
      this.flushDeltas();
      const old = this.store.entry(id);
      const kind: Entry['kind'] =
        item.type === 'agentMessage'
          ? 'assistant'
          : item.type === 'fileChange'
            ? 'change'
            : item.type === 'reasoning'
              ? 'info'
              : 'tool';
      const text =
        item.type === 'reasoning'
          ? (item.summary ?? []).join('\n')
          : (item.text ??
            item.aggregatedOutput ??
            item.output ??
            (item.changes ? JSON.stringify(item.changes, null, 2) : (old?.text ?? '')));
      this.store.putEntry({
        id,
        chatId,
        turnId: p.turnId ?? null,
        kind,
        title: item.command ?? item.tool ?? item.type,
        text: typeof text === 'string' ? text : JSON.stringify(text, null, 2),
        status: item.status ?? (method === 'item/completed' ? 'completed' : 'running'),
        createdAt: old?.createdAt ?? Date.now(),
        command: item.command ?? old?.command,
        cwd: item.cwd ?? old?.cwd,
        changes: item.changes ?? old?.changes,
      });
    } else if (['item/agentMessage/delta', 'item/commandExecution/outputDelta'].includes(method)) {
      const id = nativeEntryId(chat, p.turnId, p.itemId);
      const old = this.deltas.get(id) ?? this.store.entry(id);
      const entry: Entry = old ?? {
        id,
        chatId,
        turnId: p.turnId ?? null,
        kind: method === 'item/agentMessage/delta' ? 'assistant' : 'tool',
        title: method === 'item/agentMessage/delta' ? 'Codex' : '命令输出',
        text: '',
        status: 'running',
        createdAt: Date.now(),
      };
      const text = entry.text + String(p.delta ?? '');
      this.deltas.set(id, {
        ...entry,
        text: text.length > 250000 ? '[较早输出已截断]\n' + text.slice(-240000) : text,
      });
      this.deltaTimer ??= setTimeout(() => this.flushDeltas(), 80);
    } else if (method === 'error') {
      this.store.patchChat(chatId, { error: p.error?.message ?? 'Codex 报告了错误' });
    }
  }
  flushDeltas() {
    clearTimeout(this.deltaTimer);
    this.deltaTimer = undefined;
    for (const entry of this.deltas.values()) this.store.putEntry(entry);
    this.deltas.clear();
  }
  terminated(error: string) {
    if (this.closing) return;
    this.flushDeltas();
    this.markUncertainSends();
    this.ready = false;
    this.error = error;
    this.loaded.clear();
    this.expire(undefined, false);
    for (const c of this.store.chats())
      if (active(c) && c.control !== 'desktop')
        this.store.patchChat(c.id, {
          status: 'interrupted',
          turnId: null,
          error: 'Codex 进程已退出：' + error,
        });
    this.store.emit('status');
  }
  async close() {
    this.closing = true;
    this.desktop.close();
    this.flushDeltas();
    this.expire();
    await this.transport?.close();
    this.ready = false;
  }
}
