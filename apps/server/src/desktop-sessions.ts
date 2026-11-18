import { randomUUID } from 'node:crypto';
import type { Chat, Entry, PendingRequest } from '../../../packages/types.ts';
import { DesktopBridge, desktopTurns } from './desktop-bridge.ts';
import { historyEntry } from './local-chats.ts';
import { PocketError, Store } from './store.ts';

export class DesktopSessions {
  readonly bridge = new DesktopBridge();
  private attached = new Map<string, string>();
  private epochs = new Map<string, string>();
  private timers = new Map<string, NodeJS.Timeout>();
  private claims = new Set<string>();
  private connecting = new Set<string>();
  constructor(
    private store: Store,
    private directory: (path: string) => Promise<string>,
    private onIdle: () => void,
  ) {
    this.bridge.on('state', (nativeId) => {
      if (!this.attached.has(nativeId) || this.timers.has(nativeId)) return;
      this.timers.set(
        nativeId,
        setTimeout(() => {
          this.timers.delete(nativeId);
          try {
            this.sync(nativeId);
          } catch (e) {
            this.unavailable(nativeId, String(e));
          }
        }, 60),
      );
    });
    this.bridge.on('unavailable', (id, reason) => this.unavailable(id, reason));
    this.bridge.on('disconnected', () => {
      for (const id of this.attached.keys()) this.unavailable(id, '桌面连接已断开，请重新连接聊天');
    });
  }
  private unavailable(nativeId: string, reason: string) {
    const id = this.attached.get(nativeId);
    if (!id) return;
    clearTimeout(this.timers.get(nativeId));
    this.timers.delete(nativeId);
    this.store.patchChat(id, {
      desktopConnected: false,
      status: 'interrupted',
      turnId: null,
      error: reason,
    });
    for (const r of this.store.requests())
      if (r.chatId === id && r.status === 'pending')
        this.store.putRequest({ ...r, status: 'expired' });
    // Undelivered queued work must require a new explicit send after bridge loss.
    for (const row of this.store.db
      .prepare('SELECT operation_id FROM queue WHERE chat_id=?')
      .all(id) as any[]) {
      const e = this.store.entry(`user:${row.operation_id}`);
      if (e) this.store.putEntry({ ...e, status: 'cancelled' });
    }
    this.store.db.prepare('DELETE FROM queue WHERE chat_id=?').run(id);
    this.store.emit('status');
  }
  async attach(id: string) {
    if (this.connecting.has(id)) throw new PocketError(409, '聊天正在连接，请稍后');
    this.connecting.add(id);
    try {
      return await this.attachOnce(id);
    } finally {
      this.connecting.delete(id);
    }
  }
  private async attachOnce(id: string) {
    const c = this.store.chat(id);
    if (c.source !== 'codex' || !c.nativeId) throw new PocketError(400, '请选择本机已有聊天');
    if (c.control === 'pocket') throw new PocketError(409, '请先释放 Pocket 聊天，再在桌面打开');
    if (c.control === 'desktop' && c.desktopConnected) return this.refresh(c);
    await this.directory(c.cwd);
    const s = await this.bridge.attach(c.nativeId);
    try {
      const cwd = await this.directory(s.cwd);
      if (cwd !== (await this.directory(c.cwd)))
        throw new PocketError(409, '桌面聊天目录已改变，请刷新列表');
      this.attached.set(c.nativeId, id);
      this.epochs.set(c.nativeId, randomUUID());
      this.store.patchChat(id, { control: 'desktop', desktopConnected: true, error: null });
      this.sync(c.nativeId);
      return this.store.chat(id);
    } catch (e) {
      this.unavailable(c.nativeId, String(e));
      this.bridge.detach(c.nativeId);
      this.attached.delete(c.nativeId);
      this.epochs.delete(c.nativeId);
      throw e;
    }
  }
  detach(id: string) {
    if (this.connecting.has(id)) throw new PocketError(409, '聊天正在连接，请稍后');
    const c = this.store.chat(id);
    if (c.control !== 'desktop' || !c.nativeId) throw new PocketError(409, '此聊天未连接桌面');
    this.unavailable(c.nativeId, '已断开桌面同步');
    this.bridge.detach(c.nativeId);
    this.attached.delete(c.nativeId);
    this.epochs.delete(c.nativeId);
    return this.store.patchChat(id, {
      control: 'history',
      desktopConnected: false,
      status: 'history',
      error: null,
      turnId: null,
    });
  }
  private sync(nativeId: string) {
    const id = this.attached.get(nativeId),
      s = this.bridge.state(nativeId);
    if (!id || !s) return;
    const c = this.store.chat(id);
    if (c.control !== 'desktop') return;
    if (s.cwd !== c.cwd) {
      this.unavailable(nativeId, '桌面工作目录已改变，请重新连接');
      return;
    }
    const turns = desktopTurns(s),
      last = turns.at(-1);
    this.store.batch(() => {
      for (const turn of turns)
        for (const [index, raw] of (turn.items ?? []).entries()) {
          if (raw.type === 'steered') continue; // Desktop acknowledgement marker, not a second message.
          const item =
            raw.type === 'steeringUserMessage'
              ? {
                  ...raw,
                  type: 'userMessage',
                  content: raw.input ?? raw.content ?? [{ text: raw.text ?? '' }],
                }
              : raw;
          const entry = historyEntry(
            c,
            {
              ...turn,
              id: turn.turnId ?? 'pending',
              startedAt: (turn.turnStartedAtMs ?? c.createdAt) / 1000,
            },
            item,
            index,
          );
          // Desktop has its own message IDs; reuse our operation entry via clientUserMessageId.
          const clientId =
            raw.clientUserMessageId ??
            raw.clientId ??
            (entry.kind === 'user' ? turn.params?.clientUserMessageId : undefined);
          const own = clientId ? this.store.entry(`user:${clientId}`) : undefined;
          const previous = this.store.entry(own?.id ?? entry.id);
          const next: Entry = {
            ...entry,
            id: own?.id ?? entry.id,
            createdAt: previous?.createdAt ?? raw.startedAtMs ?? entry.createdAt,
            status:
              entry.kind === 'user'
                ? 'sent'
                : (raw.status ?? (raw.completedAtMs != null ? 'completed' : turn.status)),
          };
          if (JSON.stringify(previous) !== JSON.stringify(next)) this.store.putEntry(next);
        }
      const current = new Set<string>();
      let unsupported: string | undefined;
      for (const raw of s.requests) {
        if (
          ![
            'item/commandExecution/requestApproval',
            'item/fileChange/requestApproval',
            'item/permissions/requestApproval',
            'item/tool/requestUserInput',
          ].includes(raw.method)
        ) {
          unsupported = String(raw.method);
          continue;
        }
        const rid = `desktop:${this.epochs.get(nativeId)}:${String(raw.id)}`;
        current.add(rid);
        const old = this.store.requests().find((r) => r.id === rid);
        if (this.claims.has(rid) || old?.status === 'resolved') continue;
        const p = raw.params ?? {};
        const request: PendingRequest = {
          id: rid,
          chatId: id,
          turnId: p.turnId ?? last?.turnId ?? null,
          method: raw.method,
          kind: raw.method === 'item/tool/requestUserInput' ? 'question' : 'approval',
          prompt: p.reason ?? p.command ?? 'Codex 请求操作权限',
          params: { ...p, cwd: p.cwd ?? c.cwd, _desktop: true, _nativeRequestId: raw.id },
          status: 'pending',
          createdAt: old?.createdAt ?? p.startedAtMs ?? Date.now(),
        };
        if (JSON.stringify(old) !== JSON.stringify(request)) this.store.putRequest(request);
      }
      for (const r of this.store.requests())
        if (r.chatId === id && r.status === 'pending' && !current.has(r.id))
          this.store.putRequest({ ...r, status: 'resolved' });
      const pending = this.store
        .requests()
        .filter((r) => r.chatId === id && r.status === 'pending');
      const running = last?.status === 'inProgress' || s.threadRuntimeStatus?.type === 'active';
      const status: Chat['status'] = pending.some((r) => r.kind === 'approval')
        ? 'waiting_approval'
        : pending.length || unsupported
          ? 'waiting_input'
          : running
            ? 'running'
            : last?.status === 'interrupted'
              ? 'interrupted'
              : last?.status === 'failed'
                ? 'failed'
                : last
                  ? 'completed'
                  : 'idle';
      if (
        status !== c.status ||
        c.turnId !== (running ? (last?.turnId ?? null) : null) ||
        !c.desktopConnected ||
        c.error
      )
        this.store.patchChat(id, {
          status,
          turnId: running ? (last?.turnId ?? null) : null,
          desktopConnected: true,
          error: unsupported
            ? '请在桌面端处理请求：' + unsupported
            : (last?.error?.message ?? null),
        });
      if (
        !running &&
        status === 'completed' &&
        ['running', 'waiting_approval', 'waiting_input', 'stopping'].includes(c.status)
      )
        queueMicrotask(this.onIdle);
      if (!running && ['interrupted', 'failed'].includes(status)) {
        for (const row of this.store.db
          .prepare('SELECT operation_id FROM queue WHERE chat_id=?')
          .all(id) as any[]) {
          const e = this.store.entry(`user:${row.operation_id}`);
          if (e) this.store.putEntry({ ...e, status: 'cancelled' });
        }
        this.store.db.prepare('DELETE FROM queue WHERE chat_id=?').run(id);
      }
    });
  }
  async refresh(c: Chat) {
    if (!c.nativeId || c.control !== 'desktop' || !c.desktopConnected)
      throw new PocketError(409, '请重新连接桌面聊天');
    const s = await this.bridge.refresh(c.nativeId);
    if (s.cwd !== c.cwd) throw new PocketError(409, '桌面工作目录已改变');
    await this.directory(s.cwd);
    this.sync(c.nativeId);
    return this.store.chat(c.id);
  }
  async send(c: Chat, text: string, operationId: string, expectedTurnId?: string) {
    await this.refresh(c);
    return this.bridge.send(c.nativeId!, text, operationId, expectedTurnId);
  }
  async stop(c: Chat) {
    await this.refresh(c);
    return this.bridge.stop(c.nativeId!, c.turnId!);
  }
  async respond(request: PendingRequest, response: any) {
    if (this.claims.has(request.id)) throw new PocketError(409, '此请求正在处理');
    this.claims.add(request.id);
    try {
      const c = await this.refresh(this.store.chat(request.chatId));
      if (this.store.requests().find((r) => r.id === request.id)?.status !== 'pending')
        throw new PocketError(409, '此请求已处理或失效');
      await this.bridge.respond(
        c.nativeId!,
        request.params._nativeRequestId,
        request.method,
        response,
      );
      this.store.putRequest({ ...request, status: 'resolved' });
      await this.bridge.refresh(c.nativeId!);
      this.sync(c.nativeId!);
      return { resolved: true };
    } catch (e) {
      // A missing reply never justifies resending an approval to a new owner.
      this.store.putRequest({ ...request, status: 'expired' });
      throw e;
    } finally {
      this.claims.delete(request.id);
    }
  }
  close() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.attached.clear();
    this.bridge.close();
  }
}
