import assert from 'node:assert/strict';
import { openTransport } from '../packages/codex-transport/index.ts';

const transport = await openTransport();
try {
  const init = await transport.request('initialize', {
    clientInfo: { name: 'codex_pocket', title: 'Codex Pocket', version: '0.1.0' },
    capabilities: { experimentalApi: false },
  });
  await transport.notify('initialized');
  const models = await transport.request('model/list', { limit: 20 });
  assert(Array.isArray(models.data));
  console.log(
    JSON.stringify(
      {
        ok: true,
        upstream: '983654b3b2f7267a69e3d5d049d781aadbbc3166',
        pid: transport.pid,
        userAgent: init.userAgent,
        models: models.data.map((m: any) => m.id),
      },
      null,
      2,
    ),
  );
} finally {
  await transport.close();
}
