import { realpath, stat, readdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, basename, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  openTransport,
  type CodexTransport,
  type WireParams,
} from '../../../packages/codex-transport/index.ts';
import type { Chat, Entry, Snapshot, HostInfo, PendingRequest } from '../../../packages/types.ts';
import { Store, PocketError } from './store.ts';

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
      ready: this.ready,
      error: this.error,
    };
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
  private async load(chat: Chat) {
    if (!this.loaded.has(chat.id)) {
      try {
        await this.agent().request('thread/resume', {
          threadId: chat.nativeId ?? chat.id,
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
  async message(id: string, text: string, operationId: string) {
    this.agent();
    const chat = this.store.chat(id);
    if (!this.allowed(chat.cwd)) throw new PocketError(403, '工作目录不在允许的项目范围内');
    const entry: Entry = {
      id: `user:${operationId}`,
      chatId: id,
      turnId: null,
      kind: 'user',
      title: '你',
      text,
      status: 'queued',
      createdAt: Date.now(),
    };
    this.store.batch(() => {
      this.store.putEntry(entry);
      // Persist the visible message, queue and metadata together before publishing.
      this.store.db
        .prepare('INSERT INTO queue(operation_id,chat_id,text) VALUES(?,?,?)')
        .run(operationId, id, text);
      if (!active(chat)) this.store.patchChat(id, { status: 'queued', error: null });
    });
    void this.drain();
    return { queued: true };
  }
  async drain() {
    if (this.draining || !this.ready || this.closing) return;
    this.draining = true;
    try {
      const queue = this.store.db.prepare('SELECT * FROM queue ORDER BY position').all() as any[];
      for (const row of queue) {
        const chat = this.store.chat(row.chat_id);
        if (this.store.chats().some((c) => c.cwd === chat.cwd && active(c))) continue;
        this.store.patchChat(chat.id, { status: 'running', error: null });
        // Remove before I/O: uncertain sends never replay after a crash.
        this.store.db.prepare('DELETE FROM queue WHERE position=?').run(row.position);
        try {
          await this.directory(chat.cwd);
          await this.load(chat);
          const result = await this.agent().request('turn/start', {
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
        }
      }
    } finally {
      this.draining = false;
      // A message may arrive while the worker awaits provider I/O, after its
      // current queue snapshot. Wake again only when some workspace is free.
      if (this.ready && !this.closing) {
        const queued = this.store.db.prepare('SELECT chat_id FROM queue').all() as {
          chat_id: string;
        }[];
        if (
          queued.some((row) => {
            const chat = this.store.chat(row.chat_id);
            return !this.store.chats().some((c) => c.cwd === chat.cwd && active(c));
          })
        )
          queueMicrotask(() => void this.drain());
      }
    }
  }
  async stop(id: string) {
    const chat = this.store.chat(id);
    const rows = this.store.db
      .prepare('SELECT operation_id FROM queue WHERE chat_id=?')
      .all(id) as any[];
    this.store.db.prepare('DELETE FROM queue WHERE chat_id=?').run(id);
    for (const r of rows) {
      const e = this.store.entry(`user:${r.operation_id}`);
      if (e) this.store.putEntry({ ...e, status: 'cancelled' });
    }
    if (!chat.turnId) {
      if (chat.status === 'running') throw new PocketError(409, '任务正在启动，请稍后停止');
      if (chat.status === 'queued') this.store.patchChat(id, { status: 'interrupted' });
      return { stopped: !active(chat) };
    }
    this.store.patchChat(id, { status: 'stopping' });
    try {
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
    if (!request || request.status !== 'pending' || !live)
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
      if (!['accept', 'decline'].includes(decision ?? ''))
        throw new PocketError(400, '无效的审批决定');
      response =
        request.method === 'item/permissions/requestApproval'
          ? { permissions: decision === 'accept' ? request.params.permissions : {}, scope: 'turn' }
          : { decision };
    }
    // Claim synchronously before resolving the provider callback; competing clients lose here.
    this.store.putRequest({ ...request, status: 'resolved' });
    this.liveRequests.delete(id);
    live.resolve(response);
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
      params,
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
  private expire(chatId?: string) {
    for (const r of this.store.requests())
      if (r.status === 'pending' && (!chatId || r.chatId === chatId)) {
        this.liveRequests.get(r.id)?.reject(new Error('请求已失效'));
        this.liveRequests.delete(r.id);
        this.store.putRequest({ ...r, status: 'expired' });
      }
  }
  notification(method: string, p: WireParams) {
    if (!p.threadId) return;
    const chat = this.store.chats().find((c) => (c.nativeId ?? c.id) === p.threadId);
    if (!chat) return;
    const chatId = chat.id;
    if (method === 'turn/started')
      this.store.patchChat(chatId, { turnId: p.turn.id, status: 'running', error: null });
    else if (method === 'turn/completed') {
      this.flushDeltas();
      this.expire(chatId);
      const status =
        p.turn.status === 'completed'
          ? 'completed'
          : p.turn.status === 'interrupted'
            ? 'interrupted'
            : 'failed';
      this.store.patchChat(chatId, { status, turnId: null, error: p.turn.error?.message ?? null });
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
      const id = `${chatId}:${item.id}`;
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
      });
    } else if (['item/agentMessage/delta', 'item/commandExecution/outputDelta'].includes(method)) {
      const id = `${chatId}:${p.itemId}`;
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
    this.ready = false;
    this.error = error;
    this.loaded.clear();
    this.expire();
    for (const c of this.store.chats())
      if (active(c))
        this.store.patchChat(c.id, {
          status: 'interrupted',
          turnId: null,
          error: 'Codex 进程已退出：' + error,
        });
    this.store.emit('status');
  }
  async close() {
    this.closing = true;
    this.flushDeltas();
    this.expire();
    await this.transport?.close();
    this.ready = false;
  }
}
