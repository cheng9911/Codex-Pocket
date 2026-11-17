// Isolated browser-QA host. No real Codex, project files, or account access.
import { setup } from '../tests/helpers.ts';
import { createHttp } from '../apps/server/src/http.ts';
const env = await setup();
env.service.host.name = process.env.POCKET_NAME ?? 'Pocket 测试主机';
const server = createHttp(env.service);
const port = Number(process.env.POCKET_PORT ?? 4311);
await new Promise<void>((r) => server.http.listen(port, '127.0.0.1', r));
console.log(`Isolated test preview http://127.0.0.1:${port}`);
console.log('Test-only pairing code: ' + server.auth.pairCode());
const chat = await env.service.create('网页验收', env.root, 'fixture-model');
await env.service.message(chat.id, 'normal', crypto.randomUUID());
let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  await server.close();
  await env.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
