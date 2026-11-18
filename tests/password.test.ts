import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import {
  makePasswordConfig,
  savePasswordConfig,
  loadPasswordConfig,
  verifyPassword,
} from '../apps/server/src/password.ts';
import { Auth, digest, rememberedLifetime, temporaryLifetime } from '../apps/server/src/auth.ts';
import { Store } from '../apps/server/src/store.ts';
import { createHttp } from '../apps/server/src/http.ts';
import { setup } from './helpers.ts';
const password = 'Pocket test password 中文 2026';

test('password config uses salted hashes, owner-only atomic files and fails closed on invalid config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pocket-password-'));
  try {
    const path = join(root, 'auth.json');
    assert.equal(await loadPasswordConfig(path), undefined);
    const a = await makePasswordConfig(password),
      b = await makePasswordConfig(password);
    assert.notEqual(a.hash, b.hash);
    await savePasswordConfig(path, a);
    assert.equal((await readFile(path, 'utf8')).includes(password), false);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await loadPasswordConfig(path), a);
    await assert.rejects(makePasswordConfig(''), /不能为空/);
    await writeFile(path, '{}');
    await assert.rejects(loadPasswordConfig(path), /格式/);
    await savePasswordConfig(path, b);
    await chmod(path, 0o644);
    await assert.rejects(loadPasswordConfig(path), /600/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('short and long Unicode passwords can be configured and used to log in without trimming', async () => {
  const store = new Store(':memory:');
  try {
    for (const value of ['1', ' 中🙂! '.repeat(300)]) {
      const config = await makePasswordConfig(value);
      const auth = new Auth(store, false, config);
      const token = await auth.login(value, 'Phone', true);
      assert.ok(auth.session({ headers: { cookie: `${auth.cookieName}=${token}` } } as any));
      await assert.rejects(auth.login(value + ' ', 'Phone', true), /不正确/);
    }
  } finally {
    store.close();
  }
});

test('password sessions survive restart; rotation invalidates old devices and never falls back to pairing', async () => {
  const store = new Store(':memory:'),
    other = new Store(':memory:');
  try {
    const legacy = new Auth(store, false);
    const oldToken = legacy.exchange(legacy.pairCode(), 'Old device', 'local');
    const config = await makePasswordConfig(password);
    let auth = new Auth(store, false, config);
    const req = (token: string) => ({ headers: { cookie: `${auth.cookieName}=${token}` } }) as any;
    assert.equal(auth.session(req(oldToken)), undefined);
    assert.throws(() => auth.pairCode(), /密码/);
    assert.throws(() => auth.exchange('anything', 'phone', 'local'), /密码/);
    await assert.rejects(auth.login('incorrect password', 'Phone', true), /不正确/);
    const token = await auth.login(password, 'Phone', true);
    const session = auth.session(req(token));
    assert.equal(session.expires_at - session.created_at, rememberedLifetime);
    auth = new Auth(store, false, config);
    assert.ok(auth.session(req(token)));
    const second = new Auth(other, false, await makePasswordConfig('Different host password'));
    assert.equal(second.session(req(token)), null);
    assert.throws(() => new Auth(store, false), /配置缺失/);
    auth = new Auth(store, false, await makePasswordConfig('A different password 2026'));
    assert.equal(auth.session(req(token)), undefined);
    await assert.rejects(auth.login(password, 'Phone', true), /不正确/);
  } finally {
    store.close();
    other.close();
  }
});

test('password attempts are host-wide, persisted and reserve before verification', async () => {
  const store = new Store(':memory:');
  try {
    const config = await makePasswordConfig(password);
    let auth = new Auth(store, false, config);
    for (let i = 0; i < 10; i++) await assert.rejects(auth.login('', 'Phone', true), /不正确/);
    auth = new Auth(store, false, config);
    await assert.rejects(auth.login(password, 'Phone', true), (e: any) => e.status === 429);
    store.db.prepare('UPDATE auth_attempts SET until=0').run();
    const results = await Promise.allSettled([
      auth.login('wrong', 'A', true),
      auth.login('wrong', 'B', true),
      auth.login(password, 'C', true),
    ]);
    assert.equal(
      results.filter((r) => r.status === 'rejected' && r.reason.status === 429).length,
      1,
    );
    assert.equal(
      (store.db.prepare('SELECT count(*) as n FROM sessions').get() as { n: number }).n,
      0,
    );
  } finally {
    store.close();
  }
});

test('password HTTP login, cookie modes, origin checks, logout and device revocation protect HTTP and WS', async () => {
  const env = await setup();
  const config = await makePasswordConfig(password);
  const server = createHttp(env.service, { password: config });
  await new Promise<void>((r) => server.http.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.http.address() as any).port}`;
  const request = (path: string, body?: unknown, cookie?: string, origin = base) =>
    fetch(base + '/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: origin,
        'X-Pocket-Client': 'web',
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const host = await (await request('/host')).json();
    assert.equal(host.authMode, 'password');
    assert.equal(JSON.stringify(host).includes(config.hash), false);
    assert.equal((await request('/pair', { code: 'bypass' })).status, 403);
    assert.equal(
      (
        await request(
          '/login',
          { password, label: 'Phone', remember: true },
          undefined,
          'https://evil.example',
        )
      ).status,
      403,
    );
    assert.equal(
      (await request('/login', { password, label: 'Phone', remember: 'yes' })).status,
      400,
    );
    const login = await request('/login', { password, label: 'Phone', remember: true });
    assert.equal(login.status, 200);
    const header = login.headers.get('set-cookie')!;
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Strict/);
    assert.match(header, /Max-Age=2592000/);
    const cookie = header.split(';')[0];
    assert.equal((await request('/snapshot', undefined, cookie)).status, 200);
    const temp = await request('/login', { password, label: 'Temporary', remember: false });
    assert.equal(temp.status, 200);
    assert.doesNotMatch(temp.headers.get('set-cookie')!, /Max-Age|Expires/);
    const tempCookie = temp.headers.get('set-cookie')!.split(';')[0];
    const record = env.store.db
      .prepare('SELECT * FROM sessions WHERE hash=?')
      .get(digest(tempCookie.split('=')[1])) as any;
    assert.equal(record.expires_at - record.created_at, temporaryLifetime);
    assert.equal((await request('/logout', {}, tempCookie)).status, 200);
    assert.equal((await request('/snapshot', undefined, tempCookie)).status, 401);
    const ws = new WebSocket(base.replace('http', 'ws') + '/api/events', {
      headers: { Cookie: cookie, Origin: base },
    });
    await once(ws, 'message');
    const sessions = await (await request('/sessions', undefined, cookie)).json();
    const current = sessions.find((s: any) => s.current);
    assert.ok(current.expiresAt);
    assert.equal(JSON.stringify(sessions).includes(config.hash), false);
    const closed = once(ws, 'close');
    await request(`/sessions/${current.id}/revoke`, {}, cookie);
    assert.equal((await closed)[0], 4001);
    assert.equal((await request('/snapshot', undefined, cookie)).status, 401);
    assert.equal(
      (await request('/login', { password, label: 'Phone again', remember: true })).status,
      200,
    );
    const secure = new Auth(env.store, true, config);
    let options: any;
    secure.cookie(
      {
        cookie: (_n: any, _t: any, o: any) => {
          options = o;
        },
      } as any,
      'token',
    );
    assert.equal(options.secure, true);
    assert.match(secure.cookieName, /^__Host-/);
  } finally {
    await server.close();
    await env.close();
  }
});

test('local password setup reads stdin without logging the password or starting Codex', async () => {
  const password = ' 测试🙂 '.repeat(300);
  const root = await mkdtemp(join(tmpdir(), 'pocket-password-cli-'));
  try {
    const path = join(root, 'auth.json');
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'scripts/set-password.ts', '--stdin'],
      { env: { ...process.env, POCKET_AUTH_FILE: path }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (v) => (output += v));
    child.stderr.on('data', (v) => (output += v));
    child.stdin.end(password + '\n');
    const [code] = await once(child, 'close');
    assert.equal(code, 0, output);
    assert.equal(output.includes(password), false);
    const config = await loadPasswordConfig(path);
    assert.ok(config);
    assert.equal(await verifyPassword(password, config), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
