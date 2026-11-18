import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'node:http';
import { Store, PocketError } from './store.ts';
import { verifyPassword, type PasswordConfig } from './password.ts';
export const rememberedLifetime = 30 * 86400000;
export const temporaryLifetime = 12 * 3600000;

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export class Auth {
  private attempts = new Map<string, { n: number; until: number }>();
  readonly cookieName: string;
  private verifying = 0;
  get passwordEnabled() {
    return !!this.password;
  }
  constructor(
    private store: Store,
    private secure: boolean,
    private password?: PasswordConfig,
  ) {
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS auth_attempts(key TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL)',
    );
    const previous = store.meta('passwordFingerprint');
    if (!password && previous)
      throw new Error('主机密码配置缺失，拒绝退回配对模式；请恢复配置或运行 npm run password:set');
    if (password) {
      const fingerprint = digest(JSON.stringify(password));
      if (previous !== fingerprint)
        store.db.transaction(() => {
          store.db.exec('DELETE FROM sessions; DELETE FROM pairing; DELETE FROM auth_attempts');
          store.setMeta('passwordFingerprint', fingerprint);
        })();
    }
    this.cookieName =
      (secure ? '__Host-' : '') + 'pocket_' + store.meta('hostId')!.replaceAll('-', '');
  }
  pairCode() {
    if (this.passwordEnabled) throw new PocketError(403, '已启用主机密码，请使用密码登录');
    const code = randomBytes(18).toString('base64url');
    this.store.db.prepare('DELETE FROM pairing WHERE expires_at<?').run(Date.now());
    this.store.db
      .prepare('INSERT INTO pairing VALUES(?,?)')
      .run(digest(code), Date.now() + 10 * 60 * 1000);
    return code;
  }
  exchange(code: string, label: string, address: string) {
    if (this.passwordEnabled) throw new PocketError(403, '已启用主机密码，请使用密码登录');
    const now = Date.now();
    const bucket = this.attempts.get(address);
    if (bucket && bucket.until > now && bucket.n >= 10)
      throw new PocketError(429, '尝试次数过多，请十分钟后再试');
    if (this.attempts.size > 1000)
      for (const [k, v] of this.attempts) if (v.until < now) this.attempts.delete(k);
    this.attempts.set(address, {
      n: bucket && bucket.until > now ? bucket.n + 1 : 1,
      until: bucket && bucket.until > now ? bucket.until : now + 600000,
    });
    return this.store.db.transaction(() => {
      const result = this.store.db
        .prepare('DELETE FROM pairing WHERE hash=? AND expires_at>?')
        .run(digest(code), now);
      if (result.changes !== 1) throw new PocketError(401, '配对码无效、已使用或已过期');
      return this.issue(label, true);
    })();
  }
  private issue(label: string, remember: boolean) {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.store.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now);
    this.store.db
      .prepare('INSERT INTO sessions VALUES(?,?,?,?)')
      .run(
        digest(token),
        label.trim().slice(0, 80) || '浏览器',
        now,
        now + (remember ? rememberedLifetime : temporaryLifetime),
      );
    return token;
  }
  async login(password: unknown, label: string, remember: boolean) {
    if (!this.password) throw new PocketError(503, '尚未设置主机密码');
    if (this.verifying >= 2) throw new PocketError(429, '登录请求较多，请稍后再试');
    const now = Date.now();
    // Host-wide and persisted: proxy addresses, forged forwarding headers and restarts
    // cannot bypass the limit. Reserve attempts before the asynchronous hash check.
    this.store.db.transaction(() => {
      const bucket = this.store.db
        .prepare('SELECT count,until FROM auth_attempts WHERE key=?')
        .get('password') as { count: number; until: number } | undefined;
      if (bucket && bucket.until > now && bucket.count >= 10)
        throw new PocketError(429, '登录尝试过多，请十分钟后再试');
      this.store.db
        .prepare('INSERT OR REPLACE INTO auth_attempts VALUES(?,?,?)')
        .run(
          'password',
          bucket && bucket.until > now ? bucket.count + 1 : 1,
          bucket && bucket.until > now ? bucket.until : now + 600000,
        );
    })();
    if (typeof password !== 'string' || !password || Buffer.byteLength(password) > 512)
      throw new PocketError(401, '主机密码不正确');
    this.verifying++;
    try {
      if (!(await verifyPassword(password, this.password)))
        throw new PocketError(401, '主机密码不正确');
      return this.issue(label, remember);
    } finally {
      this.verifying--;
    }
  }
  session(req: IncomingMessage) {
    const prefix = this.cookieName + '=';
    const raw = req.headers.cookie
      ?.split(';')
      .map((p) => p.trim())
      .find((p) => p.startsWith(prefix))
      ?.slice(prefix.length);
    if (!raw || raw.length > 100) return null;
    return this.store.db
      .prepare('SELECT * FROM sessions WHERE hash=? AND expires_at>?')
      .get(digest(raw), Date.now()) as any;
  }
  middleware = (req: Request, res: Response, next: NextFunction) => {
    const session = this.session(req);
    if (!session) {
      res
        .status(401)
        .json({ error: this.passwordEnabled ? '请先登录这台主机' : '请先配对这台主机' });
      return;
    }
    res.locals.session = session;
    next();
  };
  cookie(res: Response, token: string, remember = true) {
    res.cookie(this.cookieName, token, {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'strict',
      ...(remember ? { maxAge: rememberedLifetime } : {}),
      path: '/',
    });
  }
}
