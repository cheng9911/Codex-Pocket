import { resolve, join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { Store } from './store.ts';
import { PocketService } from './service.ts';
import { createHttp } from './http.ts';
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const directory = process.env.POCKET_DATA_DIR ?? join(homedir(), '.local', 'share', 'codex-pocket');
const store = new Store(join(directory, 'pocket.sqlite'));
if (process.argv.includes('--pair')) {
  const { Auth } = await import('./auth.ts');
  console.log('一次性配对码（10 分钟有效）：' + new Auth(store, false).pairCode());
  store.close();
} else {
  const service = new PocketService(store, {
    id: store.meta('hostId')!,
    name: process.env.POCKET_NAME ?? hostname(),
    version: '0.1.0',
  });
  const server = createHttp(service, { origin: process.env.POCKET_ORIGIN });
  const host = process.env.POCKET_HOST ?? '127.0.0.1';
  const port = Number(process.env.POCKET_PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('无效的端口');
  await new Promise<void>((resolve, reject) => {
    server.http.once('error', reject);
    server.http.listen(port, host, resolve);
  });
  console.log(`Codex Pocket: http://${host}:${port}`);
  console.log('首次访问运行 npm run pair 生成配对码。');
  const roots = (process.env.POCKET_ROOTS ?? process.cwd())
    .split(';')
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
