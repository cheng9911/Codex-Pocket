import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/server/src/store.ts';
import { PocketService } from '../apps/server/src/service.ts';
import { waitFor } from '../tests/helpers.ts';

const root = await mkdtemp(join(tmpdir(), 'pocket-live-'));
const store = new Store(join(root, 'data', 'pocket.sqlite'));
let service = new PocketService(store, {
  id: store.meta('hostId')!,
  name: hostname(),
  version: '0.1.0',
});
const timeout = setTimeout(() => {
  console.error('Live verification timed out');
  process.exitCode = 1;
  void service.close();
}, 120000);
try {
  await service.start([root]);
  const chat = await service.create('Pocket live verification', root, null);
  const originalNativeId = chat.nativeId;
  await service.close();
  service = new PocketService(store, service.host);
  await service.start([root]);
  await service.message(
    chat.id,
    'Reply with exactly POCKET_LIVE_OK. Do not run commands, read files, or call any tools.',
    randomUUID(),
  );
  await waitFor(store, () =>
    ['completed', 'failed', 'interrupted'].includes(store.chat(chat.id).status) ? true : undefined,
  );
  const messages = store.entries(chat.id).filter((e) => e.kind === 'assistant');
  assert.equal(store.chat(chat.id).status, 'completed', store.chat(chat.id).error ?? '');
  assert(messages.some((e) => e.text.includes('POCKET_LIVE_OK')));
  assert.notEqual(
    store.chat(chat.id).nativeId,
    originalNativeId,
    'An unpersisted empty native thread should be recreated',
  );
  const durableId = store.chat(chat.id).nativeId;
  await service.close();
  service = new PocketService(store, service.host);
  await service.start([root]);
  await service.message(
    chat.id,
    'What exact marker did you just reply with? Reply with that marker alone. Do not use tools.',
    randomUUID(),
  );
  await waitFor(store, () =>
    ['completed', 'failed', 'interrupted'].includes(store.chat(chat.id).status) ? true : undefined,
  );
  assert.equal(store.chat(chat.id).status, 'completed', store.chat(chat.id).error ?? '');
  assert.equal(
    store.chat(chat.id).nativeId,
    durableId,
    'A persisted native conversation must be resumed',
  );
  assert(
    store
      .entries(chat.id)
      .filter((e) => e.kind === 'assistant')
      .at(-1)
      ?.text.includes('POCKET_LIVE_OK'),
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        chat: chat.id,
        status: store.chat(chat.id).status,
        emptyThreadRecovered: true,
        historyResumed: true,
        messages: store
          .entries(chat.id)
          .filter((e) => e.kind === 'assistant')
          .map((e) => e.text),
      },
      null,
      2,
    ),
  );
} finally {
  clearTimeout(timeout);
  await service.close();
  store.close();
  await rm(root, { recursive: true, force: true });
}
