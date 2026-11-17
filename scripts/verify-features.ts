// Explicit real-provider check, isolated from the user's projects and Pocket database.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/server/src/store.ts';
import { PocketService } from '../apps/server/src/service.ts';
import { waitFor } from '../tests/helpers.ts';

const root = await mkdtemp(join(tmpdir(), 'pocket-features-'));
const store = new Store(join(root, 'data', 'pocket.sqlite'));
const service = new PocketService(store, {
  id: store.meta('hostId')!,
  name: 'Feature verification',
  version: 'test',
});
const timeout = setTimeout(() => {
  console.error('Feature verification timed out');
  process.exitCode = 1;
  void service.close();
}, 120000);
try {
  await service.start([root]);
  const usage = await service.refreshUsage();
  console.log(
    JSON.stringify({
      accountType: usage.accountType,
      quotaBuckets: usage.buckets.length,
      quotaAvailable: !!usage.updatedAt,
      quotaError: usage.error,
    }),
  );
  const chat = await service.create('Steer verification', root, null);
  await service.message(
    chat.id,
    'Reply with exactly POCKET_FEATURE_START. Do not call tools, read files or execute commands.',
    randomUUID(),
  );
  const turnId = await waitFor(store, () => store.chat(chat.id).turnId ?? undefined);
  await service.message(
    chat.id,
    'Additional instruction: include POCKET_STEER_OK in your reply. Do not use tools.',
    randomUUID(),
    'steer',
  );
  assert(store.entries(chat.id).some((e) => e.status === 'steered' && e.turnId === turnId));
  await waitFor(store, () =>
    ['completed', 'failed', 'interrupted'].includes(store.chat(chat.id).status) ? true : undefined,
  );
  assert.equal(store.chat(chat.id).status, 'completed', store.chat(chat.id).error ?? '');
  console.log(
    JSON.stringify({
      ok: true,
      steerAcceptedForActiveTurn: true,
      finalStatus: store.chat(chat.id).status,
    }),
  );
} finally {
  clearTimeout(timeout);
  await service.close();
  store.close();
  await rm(root, { recursive: true, force: true });
}
