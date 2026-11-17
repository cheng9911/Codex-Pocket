import express from 'express';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { Auth } from './auth.ts';
import { PocketError } from './store.ts';
import { PocketService } from './service.ts';
import type { PocketEvent } from '../../../packages/types.ts';

export function createHttp(
  service: PocketService,
  options: { origin?: string; staticDir?: string } = {},
) {
  const app = express();
  const http = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const origin = options.origin ? new URL(options.origin).origin : undefined;
  const auth = new Auth(service.store, origin?.startsWith('https:') ?? false);
  const allowed = (req: import('node:http').IncomingMessage) => {
    if (!req.headers.host) return false;
    if (origin) {
      if (req.headers.host !== new URL(origin).host) return false;
      return !req.headers.origin || req.headers.origin === origin;
    }
    try {
      const url = new URL('http://' + req.headers.host);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return false;
      return !req.headers.origin || req.headers.origin === url.origin;
    } catch {
      return false;
    }
  };
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (!allowed(req)) {
      res.status(403).json({ error: '不允许的主机地址或来源，请配置 POCKET_ORIGIN' });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '128kb' }));
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-pocket-client'] !== 'web') {
      res.status(403).json({ error: '缺少客户端标识' });
      return;
    }
    next();
  });
  app.get('/api/host', (_req, res) => res.json(service.host));
  app.post('/api/pair', (req, res) => {
    const code = String(req.body?.code ?? '');
    const token = auth.exchange(
      code,
      String(req.body?.label ?? '浏览器'),
      req.socket.remoteAddress ?? 'local',
    );
    auth.cookie(res, token);
    res.json({ paired: true, host: service.host });
  });
  app.use('/api', auth.middleware);
  app.get('/api/snapshot', (_req, res) => res.json(service.snapshot()));
  app.get('/api/usage', async (_req, res) => res.json(await service.refreshUsage()));
  app.post('/api/favorites', async (req, res) => {
    const { operationId, path, saved } = req.body;
    if (typeof path !== 'string' || typeof saved !== 'boolean')
      throw new PocketError(400, '收藏参数无效');
    res.json(
      await service.operation(String(operationId), { type: 'favorite', path, saved }, () =>
        service.favorite(path, saved),
      ),
    );
  });
  app.post('/api/queue/:id/cancel', async (req, res) => {
    const id = req.params.id;
    res.json(
      await service.operation(String(req.body.operationId), { type: 'cancelQueue', id }, async () =>
        service.cancelQueued(id),
      ),
    );
  });
  app.post('/api/chats/:id/update', async (req, res) => {
    const id = req.params.id;
    const { operationId, title, pinned } = req.body;
    if (
      (title !== undefined && typeof title !== 'string') ||
      (pinned !== undefined && typeof pinned !== 'boolean') ||
      (title === undefined && pinned === undefined)
    )
      throw new PocketError(400, '聊天整理参数无效');
    res.json(
      await service.operation(
        String(operationId),
        { type: 'organize', id, title, pinned },
        async () => service.organize(id, { title, pinned }),
      ),
    );
  });
  app.get('/api/config', (_req, res) => res.json({ roots: service.roots, models: service.models }));
  app.get('/api/directories', async (req, res) =>
    res.json(
      await service.directories(typeof req.query.path === 'string' ? req.query.path : undefined),
    ),
  );
  app.get('/api/chats/:id/entries', (req, res) => {
    service.store.chat(req.params.id);
    const before = Number(req.query.before);
    const entries = service.store.entries(
      req.params.id,
      Number.isFinite(before) && before > 0 ? before : undefined,
    );
    res.json({ entries, hasMore: entries.length === 60, cursor: service.store.cursor() });
  });
  app.post('/api/chats', async (req, res) => {
    const { operationId, title, cwd, model } = req.body;
    if (
      typeof cwd !== 'string' ||
      typeof title !== 'string' ||
      title.length > 120 ||
      (model !== null && typeof model !== 'string')
    )
      throw new PocketError(400, '聊天参数无效');
    res.json(
      await service.operation(String(operationId), { type: 'create', title, cwd, model }, () =>
        service.create(title, cwd, model),
      ),
    );
  });
  app.post('/api/chats/:id/messages', async (req, res) => {
    const { text, operationId, delivery = 'queue', expectedTurnId } = req.body;
    if (typeof text !== 'string' || !text.trim() || text.length > 30000)
      throw new PocketError(400, '消息不能为空且不能超过 30000 字符');
    if (!['queue', 'steer'].includes(delivery)) throw new PocketError(400, '请选择有效的发送方式');
    if (delivery === 'steer' && typeof expectedTurnId !== 'string')
      throw new PocketError(400, '追加指令需要当前执行轮次标识');
    const id = req.params.id;
    res.json(
      await service.operation(
        String(operationId),
        { type: 'message', id, text, delivery, expectedTurnId },
        () => service.message(id, text.trim(), String(operationId), delivery, expectedTurnId),
      ),
    );
  });
  app.post('/api/chats/:id/stop', async (req, res) => {
    const id = req.params.id;
    res.json(
      await service.operation(String(req.body.operationId), { type: 'stop', id }, () =>
        service.stop(id),
      ),
    );
  });
  app.post('/api/requests/:id/respond', async (req, res) => {
    const id = req.params.id;
    const { operationId, decision, answers } = req.body;
    res.json(
      await service.operation(String(operationId), { type: 'respond', id, decision, answers }, () =>
        service.respond(id, decision, answers),
      ),
    );
  });
  app.get('/api/sessions', (_req, res) =>
    res.json(
      (
        service.store.db
          .prepare('SELECT hash,label,created_at,expires_at FROM sessions WHERE expires_at>?')
          .all(Date.now()) as any[]
      ).map((s) => ({
        id: s.hash.slice(0, 16),
        label: s.label,
        createdAt: s.created_at,
        expiresAt: s.expires_at,
        current: s.hash === res.locals.session.hash,
      })),
    ),
  );
  app.post('/api/sessions/:id/revoke', (req, res) => {
    const sessions = service.store.db.prepare('SELECT hash FROM sessions').all() as any[];
    const target = sessions.find((s) => s.hash.slice(0, 16) === req.params.id);
    if (!target) throw new PocketError(404, '设备会话不存在');
    service.store.db.prepare('DELETE FROM sessions WHERE hash=?').run(target.hash);
    for (const client of wss.clients)
      if ((client as any).sessionHash === target.hash) client.close(4001, 'Session revoked');
    res.json({ revoked: true });
  });
  app.post('/api/logout', (_req, res) => {
    service.store.db.prepare('DELETE FROM sessions WHERE hash=?').run(res.locals.session.hash);
    for (const client of wss.clients)
      if ((client as any).sessionHash === res.locals.session.hash) client.close(4001, 'Signed out');
    res.clearCookie(auth.cookieName, { path: '/', secure: origin?.startsWith('https:') ?? false });
    res.json({ ok: true });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  const staticDir = options.staticDir ?? resolve('dist/web');
  if (existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: 'index.html' }));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(staticDir, 'index.html')));
  }
  app.use(
    (error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res
        .status(error instanceof PocketError ? error.status : 500)
        .json({ error: error instanceof Error ? error.message : '请求失败' });
    },
  );
  http.on('upgrade', (req, socket, head) => {
    const session = auth.session(req);
    if (
      !allowed(req) ||
      !req.headers.origin ||
      !session ||
      req.url?.split('?')[0] !== '/api/events'
    ) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      (ws as any).sessionHash = session.hash;
      const send = (value: unknown) => {
        if (ws.readyState === WebSocket.OPEN) {
          if (ws.bufferedAmount > 2 * 1024 * 1024) {
            ws.close(4002, 'Reconnect to refresh');
            return;
          }
          ws.send(JSON.stringify(value));
        }
      };
      // A current snapshot is always sent. Replay repairs persisted entries in the
      // selected chat; snapshot.cursor prevents stale replay overwriting metadata.
      const after = Number(new URL(req.url!, 'http://local').searchParams.get('after'));
      const replay = Number.isSafeInteger(after) && after >= 0 ? service.store.replay(after) : null;
      send({ type: 'snapshot', data: service.snapshot(), reset: replay === null });
      if (replay)
        for (const event of replay) if (event.type === 'entry') send({ type: 'replay', event });
      const event = (e: PocketEvent) => send({ type: 'event', event: e });
      const status = () => send({ type: 'snapshot', data: service.snapshot() });
      service.store.on('event', event);
      service.store.on('status', status);
      let alive = true;
      ws.on('pong', () => (alive = true));
      const heartbeat = setInterval(() => {
        if (!auth.session(req)) {
          ws.close(4001, 'Session expired');
          return;
        }
        if (!alive) {
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, 20000);
      ws.on('close', () => {
        clearInterval(heartbeat);
        service.store.off('event', event);
        service.store.off('status', status);
      });
    });
  });
  return {
    app,
    http,
    auth,
    async close() {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
