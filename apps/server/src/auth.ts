import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'node:http';
import { Store, PocketError } from './store.ts';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export class Auth {
  private attempts = new Map<string, { n: number; until: number }>();
  readonly cookieName: string;
  constructor(
    private store: Store,
    private secure: boolean,
  ) {
    this.cookieName =
      (secure ? '__Host-' : '') + 'pocket_' + store.meta('hostId')!.replaceAll('-', '');
  }
  pairCode() {
    const code = randomBytes(18).toString('base64url');
    this.store.db.prepare('DELETE FROM pairing WHERE expires_at<?').run(Date.now());
    this.store.db
      .prepare('INSERT INTO pairing VALUES(?,?)')
      .run(digest(code), Date.now() + 10 * 60 * 1000);
    return code;
  }
  exchange(code: string, label: string, address: string) {
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
    const token = randomBytes(32).toString('base64url');
    this.store.db.transaction(() => {
      const result = this.store.db
        .prepare('DELETE FROM pairing WHERE hash=? AND expires_at>?')
        .run(digest(code), now);
      if (result.changes !== 1) throw new PocketError(401, '配对码无效、已使用或已过期');
      this.store.db
        .prepare('INSERT INTO sessions VALUES(?,?,?,?)')
        .run(digest(token), label.slice(0, 80), now, now + 30 * 86400000);
    })();
    return token;
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
      res.status(401).json({ error: '请先配对这台主机' });
      return;
    }
    res.locals.session = session;
    next();
  };
  cookie(res: Response, token: string) {
    res.cookie(this.cookieName, token, {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'strict',
      maxAge: 30 * 86400000,
      path: '/',
    });
  }
}
