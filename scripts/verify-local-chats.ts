// Real Codex interoperability check. Only the uniquely-created temporary chat is mutated.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { openTransport } from '../packages/codex-transport/index.ts';
import { Store } from '../apps/server/src/store.ts';
import { PocketService } from '../apps/server/src/service.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
const root = await mkdtemp(join(tmpdir(), 'pocket-local-verification-'));
const store = new Store(join(root, 'pocket.sqlite'));
const service = new PocketService(store, {
  id: store.meta('hostId')!,
  name: 'Local verification',
  version: 'test',
});
let ownerTurn: string | undefined;
const owner = await openTransport({ request: async () => ({ decision: 'decline' }) });
async function until(check: () => boolean, label: string, timeout = 90000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out: ' + label);
    await new Promise((r) => setTimeout(r, 100));
  }
}
let id: string | undefined;
try {
  await owner.request('initialize', {
    clientInfo: { name: 'pocket_local_verification_owner', version: '0.1.0' },
    capabilities: { experimentalApi: false },
  });
  await owner.notify('initialized');
  const start = await owner.request('thread/start', {
    cwd: root,
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
  });
  id = start.thread.id;
  await owner.request('thread/name/set', { threadId: id, name: 'Pocket 本机聊天联调（临时测试）' });
  ownerTurn = (
    await owner.request('turn/start', {
      threadId: id,
      input: [
        {
          type: 'text',
          text: 'Isolated interoperability test. Run only sleep 30 with the shell tool, then reply POCKET_OWNER_DONE. Do not read or write files or run any other command.',
        },
      ],
    })
  ).turn.id;
  await service.start([root]);
  let list = await service.local.list();
  // The native index is updated asynchronously after the first turn is persisted.
  for (let attempt = 0; attempt < 20 && !store.chats().some((c) => c.nativeId === id); attempt++) {
    await new Promise((r) => setTimeout(r, 500));
    list = await service.local.list();
  }
  const chat = store.chats().find((c) => c.nativeId === id);
  assert.ok(chat, 'Native chat was not discovered');
  assert.equal(chat.status, 'history');
  const history = await service.local.history(chat);
  assert.ok(history.entries.some((e) => e.kind === 'user'));
  await assert.rejects(service.continueLocal(chat.id), /占用/);
  for (const method of ['turn/steer', 'turn/interrupt']) {
    await assert.rejects(
      service.transport!.request(method, {
        threadId: id,
        turnId: ownerTurn,
        expectedTurnId: ownerTurn,
        input: [{ type: 'text', text: 'End this isolated test.' }],
      }),
      /thread not found/,
    );
  }
  await owner.request('turn/interrupt', { threadId: id, turnId: ownerTurn });
  await owner.close();
  await service.continueLocal(chat.id);
  assert.equal(store.chat(chat.id).nativeId, id);
  await service.message(
    chat.id,
    'Reply exactly POCKET_CONTINUED_OK. Do not use tools or inspect any files.',
    randomUUID(),
  );
  await until(
    () => ['completed', 'failed', 'interrupted'].includes(store.chat(chat.id).status),
    'continued turn',
  );
  assert.equal(store.chat(chat.id).status, 'completed', store.chat(chat.id).error ?? '');
  const continued = await service.local.history(store.chat(chat.id));
  assert.ok(
    continued.entries.some((e) => e.kind === 'assistant' && e.text.includes('POCKET_CONTINUED_OK')),
  );
  await service.message(
    chat.id,
    'Run only sleep 30 with the shell tool, then reply DONE. Do not read or write files.',
    randomUUID(),
  );
  await until(() => !!store.chat(chat.id).turnId, 'new turn');
  await service.stop(chat.id);
  await until(() => store.chat(chat.id).status === 'interrupted', 'stop confirmation');
  await service.releaseLocal(chat.id);
  const reader = await openTransport();
  try {
    await reader.request('initialize', {
      clientInfo: { name: 'pocket_local_verification_reader', version: '0.1.0' },
      capabilities: { experimentalApi: false },
    });
    await reader.notify('initialized');
    const resumed = await reader.request('thread/resume', { threadId: id, excludeTurns: true });
    assert.equal(resumed.thread.id, id);
    await reader.request('thread/unsubscribe', { threadId: id });
    await reader.request('thread/archive', { threadId: id });
  } finally {
    await reader.close();
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        discovered: list.count,
        pagedHistory: true,
        sameThreadContinued: true,
        nativeStopConfirmed: true,
        releasedToAnotherProcess: true,
        externalWriterLocked: true,
        crossProcessSteer: false,
        crossProcessInterrupt: false,
        externalApprovals: 'not attached: no subscription to the owning process',
        testThreadArchived: id,
      },
      null,
      2,
    ),
  );
} finally {
  await owner.close();
  await service.close();
  store.close();
  await rm(root, { recursive: true, force: true });
}
