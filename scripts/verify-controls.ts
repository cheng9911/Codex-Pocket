import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/server/src/store.ts';
import { PocketService } from '../apps/server/src/service.ts';
import { waitFor } from '../tests/helpers.ts';

const root = await mkdtemp(join(tmpdir(), 'pocket-controls-'));
const store = new Store(join(root, 'data', 'pocket.sqlite'));
const service = new PocketService(store, {
  id: store.meta('hostId')!,
  name: hostname(),
  version: '0.1.0',
});
const deadline = setTimeout(() => {
  console.error('Control verification timed out');
  process.exitCode = 1;
  void service.close();
}, 120000);
let approvals = 0;
const approve = () => {
  for (const r of store.requests())
    if (r.status === 'pending' && r.kind === 'approval') {
      approvals++;
      void service.respond(r.id, 'accept');
    }
};
try {
  await service.start([root]);
  const chat = await service.create('Control verification', root, null);
  // Force a read-only test workspace. A harmless write requires a native approval.
  const readonly = await service.transport!.request('thread/start', {
    cwd: root,
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
  });
  store.patchChat(chat.id, { nativeId: readonly.thread.id });
  store.on('event', approve);
  await service.message(
    chat.id,
    `Use the shell tool to run exactly: printf POCKET_APPROVAL_OK > '${join(root, 'approval-marker.txt')}'. The sandbox is read-only. Request escalated permission for this harmless test write. After the command succeeds, reply DONE. Do not read any other files.`,
    randomUUID(),
  );
  await waitFor(store, () =>
    ['completed', 'failed', 'interrupted'].includes(store.chat(chat.id).status) ? true : undefined,
  );
  store.off('event', approve);
  assert.equal(store.chat(chat.id).status, 'completed', store.chat(chat.id).error ?? '');
  assert(approvals > 0, 'The provider did not issue a native approval');
  assert.equal(await readFile(join(root, 'approval-marker.txt'), 'utf8'), 'POCKET_APPROVAL_OK');
  await service.message(chat.id, 'Wait for my next instruction. Do not call tools.', randomUUID());
  const turnId = await waitFor(store, () => store.chat(chat.id).turnId ?? undefined);
  await service.stop(chat.id);
  await waitFor(store, () => (store.chat(chat.id).status === 'interrupted' ? true : undefined));
  console.log(
    JSON.stringify({ ok: true, nativeApprovals: approvals, interruptedTurn: turnId }, null, 2),
  );
} finally {
  clearTimeout(deadline);
  store.off('event', approve);
  await service.close();
  store.close();
  await rm(root, { recursive: true, force: true });
}
