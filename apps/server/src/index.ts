import { resolve, join, parse } from 'node:path';
import { homedir, hostname } from 'node:os';
import { Store } from './store.ts';
import { PocketService } from './service.ts';
import { createHttp } from './http.ts';
import { existsSync } from 'node:fs';
import { loadPasswordConfig } from './password.ts';

if (existsSync('.env')) process.loadEnvFile('.env');

const directory = process.env.POCKET_DATA_DIR ?? join(homedir(), '.local', 'share', 'codex-pocket');
const password = await loadPasswordConfig(
  resolve(process.env.POCKET_AUTH_FILE ?? join(directory, 'auth.json')),
);
const store = new Store(join(directory, 'pocket.sqlite'));
if (process.argv.includes('--pair') && password) {
  console.error('已启用主机密码，请使用密码登录，无需生成配对码。');
  store.close();
  process.exitCode = 1;
} else if (process.argv.includes('--pair')) {
  const { Auth } = await import('./auth.ts');
  console.log('一次性配对码（10 分钟有效）：' + new Auth(store, false, password).pairCode());
  store.close();
} else {
  const service = new PocketService(store, {
    id: store.meta('hostId')!,
    name: process.env.POCKET_NAME ?? hostname(),
    version: '0.1.0',
  });
  const server = createHttp(service, { origin: process.env.POCKET_ORIGIN, password });
  const host = process.env.POCKET_HOST ?? '127.0.0.1';
  const port = Number(process.env.POCKET_PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('无效的端口');
  await new Promise<void>((resolve, reject) => {
    server.http.once('error', reject);
    server.http.listen(port, host, resolve);
  });
  console.log(`Codex Pocket: http://${host}:${port}`);
  console.log(
    password
      ? '主机密码登录已启用。'
      : '运行 npm run password:set 设置主机密码，然后重启服务。旧版配对仍可使用。',
  );
  const roots = (process.env.POCKET_ROOTS?.trim() || parse(process.cwd()).root)
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(p));
  try {
    await service.start(roots);
    console.log('Codex 已连接。');
  } catch (e) {
    service.error = e instanceof Error ? e.message : String(e);
    console.error('Codex 连接失败：' + service.error);
    store.emit('status');
  }
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await service.close();
    await server.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
