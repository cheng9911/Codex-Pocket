import { connect, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { stat } from 'node:fs/promises';

// Observed desktop IPC contract, NOT the public app-server JSON-RPC protocol.
// Keep versioned methods explicit. Never retry a mutation after an uncertain reply.
const versions: Record<string, number> = {
  initialize: 0,
  'thread-owner-discovery': 1,
  'thread-follower-load-complete-history': 1,
  'thread-follower-start-turn': 2,
  'thread-follower-steer-turn': 1,
  'thread-follower-interrupt-turn': 4,
  'thread-follower-command-approval-decision': 1,
  'thread-follower-file-approval-decision': 1,
  'thread-follower-permissions-request-approval-response': 1,
  'thread-follower-submit-user-input': 1,
};
export const desktopSocketPath = () =>
  process.env.POCKET_DESKTOP_SOCKET ??
  join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'ipc', 'ipc.sock');

export class DesktopIpc extends EventEmitter {
  private socket?: Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private pending = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  clientId = '';
  async open(path = desktopSocketPath()) {
    if (this.socket) throw new Error('Desktop IPC already connected');
    const info = await stat(path);
    if (!info.isSocket() || (process.getuid && info.uid !== process.getuid()))
      throw new Error('桌面连接必须是当前用户拥有的本地 socket');
    const socket = connect(path);
    this.socket = socket;
    socket.on('data', (chunk) => {
      try {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
          const length = this.buffer.readUInt32LE(0);
          if (!length || length > 32 * 1024 * 1024) throw new Error('Invalid desktop frame size');
          if (this.buffer.length < length + 4) break;
          const message = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8'));
          this.buffer = this.buffer.subarray(length + 4);
          if (message.type === 'response') {
            const p = this.pending.get(message.requestId);
            if (!p) continue;
            this.pending.delete(message.requestId);
            clearTimeout(p.timer);
            if (message.resultType === 'success') p.resolve(message);
            else p.reject(new Error(String(message.error ?? 'Desktop request failed')));
          } else if (message.type === 'broadcast') this.emit('broadcast', message);
          else if (message.type === 'client-discovery-request')
            this.write({
              type: 'client-discovery-response',
              requestId: message.requestId,
              response: { canHandle: false },
            });
        }
      } catch (error) {
        socket.destroy(error as Error);
      }
    });
    socket.on('error', () => {});
    socket.once('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.clientId = '';
      this.buffer = Buffer.alloc(0);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('桌面连接已断开，操作结果需要核对'));
      }
      this.pending.clear();
      this.emit('disconnected');
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => socket.destroy(new Error('Desktop connection timeout')), 5000);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    try {
      this.clientId = (
        await this.request('initialize', { clientType: 'codex-pocket' })
      ).result.clientId;
      if (typeof this.clientId !== 'string' || !this.clientId)
        throw new Error('Invalid desktop handshake');
    } catch (error) {
      this.close();
      throw error;
    }
  }
  private write(message: any) {
    if (!this.socket?.writable) throw new Error('桌面连接未建立');
    const body = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }
  request(method: string, params: unknown, targetClientId?: string, timeout = 15000): Promise<any> {
    if (!(method in versions))
      return Promise.reject(new Error('Unsupported desktop method: ' + method));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('桌面响应超时，操作结果需要核对；不会自动重试'));
      }, timeout);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.write({
          type: 'request',
          requestId,
          sourceClientId: this.clientId,
          version: versions[method],
          method,
          params,
          targetClientId,
        });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(e);
      }
    });
  }
  following(conversationId: string, owner: string, following: boolean) {
    this.write({
      type: 'broadcast',
      method: 'thread-stream-following-changed',
      version: 1,
      sourceClientId: this.clientId,
      targetClientIds: [owner],
      params: { conversationId, hostId: 'local', following },
    });
  }
  close() {
    this.socket?.destroy();
  }
}
