// Isolated browser-QA host. No real Codex, project files, or account access.
import { setup } from '../tests/helpers.ts';
import { createHttp } from '../apps/server/src/http.ts';
import { makePasswordConfig } from '../apps/server/src/password.ts';
const password = process.env.POCKET_TEST_PASSWORD
  ? await makePasswordConfig(process.env.POCKET_TEST_PASSWORD)
  : undefined;
const env = await setup();
env.service.host.name = process.env.POCKET_NAME ?? 'Pocket 测试主机';
let server = createHttp(env.service, { password });
const port = Number(process.env.POCKET_PORT ?? 4311);
await new Promise<void>((r) => server.http.listen(port, '127.0.0.1', r));
console.log(`Isolated test preview http://127.0.0.1:${port}`);
if (!password) console.log('Test-only pairing code: ' + server.auth.pairCode());
else console.log('Test-only password login enabled.');
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

// QA-only network interruption. The fixture agent and SQLite stay alive.
let paused = false;
process.on('SIGUSR1', () => {
  if (!paused) {
    paused = true;
    void server.close().then(() => console.log('Test HTTP/WS paused'));
  }
});
process.on('SIGUSR2', () => {
  if (paused) {
    server = createHttp(env.service, { password });
    server.http.listen(port, '127.0.0.1', () => {
      paused = false;
      console.log('Test HTTP/WS resumed');
    });
  }
});
