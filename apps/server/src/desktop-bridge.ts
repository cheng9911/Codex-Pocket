import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DesktopIpc } from './desktop-ipc.ts';

export function desktopTurns(state: any): any[] {
  const h = state?.turnHistory?.kind === 'canonical' ? state.turnHistory.history : null;
  return h
    ? h.islands.flatMap((i: any) =>
        i.entries.map((e: any) => h.entitiesByKey[e.value]).filter(Boolean),
      )
    : (state?.turns ?? []);
}
export function applyDesktopPatches(state: any, patches: any[]) {
  for (const patch of patches) {
    if (
      !Array.isArray(patch.path) ||
      !patch.path.length ||
      patch.path.some(
        (p: any) =>
          !['string', 'number'].includes(typeof p) ||
          ['__proto__', 'constructor', 'prototype'].includes(String(p)),
      ) ||
      !['add', 'replace', 'remove'].includes(patch.op)
    )
      throw new Error('Unsupported desktop patch');
    let parent = state;
    for (const key of patch.path.slice(0, -1)) {
      if (!parent || !Object.hasOwn(parent, key)) throw new Error('Desktop patch path missing');
      parent = parent[key];
    }
    const key = patch.path.at(-1);
    if (Array.isArray(parent)) {
      if (!Number.isInteger(key) || key < 0 || key > parent.length)
        throw new Error('Invalid desktop array patch');
      if (patch.op === 'add') parent.splice(key, 0, patch.value);
      else if (patch.op === 'remove') parent.splice(key, 1);
      else parent[key] = patch.value;
    } else if (parent && typeof parent === 'object') {
      if (patch.op === 'remove') delete parent[key];
      else parent[key] = patch.value;
    } else throw new Error('Invalid desktop patch target');
  }
  return state;
}
type Followed = {
  owner: string;
  revision: number;
  state: any;
  healthy: boolean;
  refresh?: Promise<any>;
};

/** One local desktop IPC client. Never opens/resumes an app-server writer. */
export class DesktopBridge extends EventEmitter {
  readonly ipc = new DesktopIpc();
  private followed = new Map<string, Followed>();
  connected = false;
  error: string | null = null;
  private opening?: Promise<void>;
  constructor() {
    super();
    this.ipc.on('disconnected', () => {
      this.connected = false;
      this.error = '桌面连接已断开，请重新连接聊天';
      for (const f of this.followed.values()) f.healthy = false;
      this.emit('disconnected');
    });
    this.ipc.on('broadcast', (m) => {
      const id = m.params?.conversationId,
        f = this.followed.get(id);
      if (m.method === 'client-status-changed' && m.params?.status === 'disconnected') {
        for (const [id, f] of this.followed)
          if (f.owner === m.params.clientId) {
            f.healthy = false;
            this.emit('unavailable', id, '桌面聊天控制端已断开，请重新连接');
          }
        return;
      }
      if (!f || m.sourceClientId !== f.owner || m.params.hostId !== 'local') return;
      if (m.method === 'thread-stream-following-status-requested') {
        this.ipc.following(id, f.owner, true);
        return;
      }
      if (m.method !== 'thread-stream-state-changed') return;
      try {
        if (m.version !== 11) throw new Error('桌面协议版本不兼容，请升级 Pocket 桥接');
        const c = m.params.change;
        if (!Number.isSafeInteger(c?.revision)) throw new Error('Invalid desktop revision');
        if (c.revision < f.revision) return;
        if (c.type === 'snapshot') {
          if (c.conversationState?.id !== id || !Array.isArray(c.conversationState.requests))
            throw new Error('Invalid desktop snapshot');
          f.state = c.conversationState;
        } else if (c.type === 'patches') {
          if (!f.healthy || c.baseRevision !== f.revision || !f.state)
            throw new Error('桌面事件序列中断，正在重新同步');
          applyDesktopPatches(f.state, c.patches);
        } else throw new Error('Unsupported desktop event');
        f.revision = c.revision;
        f.healthy = true;
        this.emit('state', id, f.state);
      } catch (e) {
        f.healthy = false;
        this.emit('unavailable', id, String(e));
        if (m.version === 11) void this.refresh(id).catch(() => {});
      }
    });
  }
  async open() {
    if (this.connected) return;
    if (!this.opening)
      this.opening = this.ipc
        .open()
        .then(() => {
          this.connected = true;
          this.error = null;
        })
        .catch((e) => {
          this.error = String(e);
          throw e;
        })
        .finally(() => {
          this.opening = undefined;
        });
    return this.opening;
  }
  state(id: string) {
    const f = this.followed.get(id);
    return this.connected && f?.healthy ? f.state : null;
  }
  async attach(id: string) {
    await this.open();
    const discovery = await this.ipc
      .request('thread-owner-discovery', { hostId: 'local', conversationId: id })
      .catch((e) => {
        if (String(e).includes('no-client-found'))
          throw new Error('桌面端未打开此聊天，请先在桌面打开它');
        throw e;
      });
    const owner = discovery.handledByClientId;
    if (typeof owner !== 'string' || owner === this.ipc.clientId)
      throw new Error('桌面端未打开此聊天，请先在桌面打开它');
    this.followed.set(id, { owner, revision: -1, state: null, healthy: false });
    this.ipc.following(id, owner, true);
    try {
      return await this.refresh(id);
    } catch (e) {
      this.detach(id);
      throw e;
    }
  }
  async refresh(id: string): Promise<any> {
    const f = this.followed.get(id);
    if (!f || !this.connected) throw new Error('请先连接桌面聊天');
    if (!f.refresh)
      f.refresh = (async () => {
        const r = await this.ipc.request(
          'thread-follower-load-complete-history',
          { conversationId: id },
          f.owner,
        );
        // The snapshot precedes the reply on this ordered socket.
        if (!f.healthy || !f.state || f.revision < r.result.revision)
          throw new Error('桌面状态尚未同步，暂不能控制');
        return f.state;
      })()
        .catch((e) => {
          f.healthy = false;
          this.emit('unavailable', id, String(e));
          throw e;
        })
        .finally(() => {
          f.refresh = undefined;
        });
    return f.refresh;
  }
  async send(
    id: string,
    text: string,
    operationId: string = randomUUID(),
    expectedTurnId?: string,
  ) {
    const state = await this.refresh(id),
      f = this.followed.get(id)!;
    const last = desktopTurns(state).at(-1);
    const input = [{ type: 'text', text, text_elements: [] }];
    if (expectedTurnId) {
      if (last?.status !== 'inProgress' || last.turnId !== expectedTurnId)
        throw new Error('执行轮次已改变，请重新确认');
      const r = await this.ipc.request(
        'thread-follower-steer-turn',
        {
          conversationId: id,
          input,
          clientUserMessageId: operationId,
          restoreMessage: {
            id: operationId,
            text,
            cwd: state.cwd,
            context: { workspaceRoots: [state.cwd] },
          },
        },
        f.owner,
      );
      if (r.result?.result?.turnId !== expectedTurnId)
        throw new Error('追加指令轮次未确认，请核对桌面聊天');
      return r.result.result;
    }
    if (last?.status === 'inProgress' || state.threadRuntimeStatus?.type === 'active')
      throw new Error('桌面任务正在运行，请选择现在补充或完成后发送');
    return (
      await this.ipc.request(
        'thread-follower-start-turn',
        {
          conversationId: id,
          turnStart: { request: { threadId: id, input, clientUserMessageId: operationId } },
        },
        f.owner,
      )
    ).result.result;
  }
  async stop(id: string, expectedTurnId: string) {
    const state = await this.refresh(id),
      f = this.followed.get(id)!;
    const last = desktopTurns(state).at(-1);
    if (last?.turnId !== expectedTurnId || last.status !== 'inProgress')
      throw new Error('当前任务已结束或轮次已改变');
    const r = (
      await this.ipc.request(
        'thread-follower-interrupt-turn',
        {
          conversationId: id,
          expectedTurnId,
          mode: 'user-stop',
        },
        f.owner,
      )
    ).result;
    if (r.interruptedTurnId !== expectedTurnId) throw new Error('停止未确认，请核对桌面状态');
    return r;
  }
  async respond(id: string, requestId: string | number, method: string, response: any) {
    const state = await this.refresh(id),
      f = this.followed.get(id)!;
    if (!state.requests.some((r: any) => r.id === requestId && r.method === method))
      throw new Error('桌面请求已处理或失效');
    const methods: Record<string, string> = {
      'item/commandExecution/requestApproval': 'thread-follower-command-approval-decision',
      'item/fileChange/requestApproval': 'thread-follower-file-approval-decision',
      'item/permissions/requestApproval': 'thread-follower-permissions-request-approval-response',
      'item/tool/requestUserInput': 'thread-follower-submit-user-input',
    };
    if (!methods[method]) throw new Error('请在桌面端处理此类型请求');
    return (
      await this.ipc.request(
        methods[method],
        {
          conversationId: id,
          requestId,
          ...(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(
            method,
          )
            ? { decision: response.decision }
            : { response }),
        },
        f.owner,
      )
    ).result;
  }
  detach(id: string) {
    const f = this.followed.get(id);
    if (f && this.connected) this.ipc.following(id, f.owner, false);
    this.followed.delete(id);
  }
  close() {
    this.followed.clear();
    this.ipc.close();
  }
}
