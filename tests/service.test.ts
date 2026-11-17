import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setup, waitFor } from './helpers.ts';
import { PocketService } from '../apps/server/src/service.ts';

test('upstream transport streams real JSONL and routes approvals only once', async () => {
  const env = await setup();
  try {
    const c = await env.service.create('Approval', env.root, null);
    await env.service.message(c.id, 'approval', randomUUID());
    const req = await waitFor(env.store, () =>
      env.store.requests().find((r) => r.status === 'pending'),
    );
    assert.equal(req.chatId, c.id);
    assert.equal(env.store.chat(c.id).status, 'waiting_approval');
    const result = await Promise.allSettled([
      env.service.respond(req.id, 'accept'),
      env.service.respond(req.id, 'decline'),
    ]);
    assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
    await waitFor(env.store, () =>
      env.store.chat(c.id).status === 'completed' ? true : undefined,
    );
    assert(env.store.entries(c.id).some((e) => e.text === 'APPROVED'));
  } finally {
    await env.close();
  }
});
test('same workspace queues, other workspace runs; stop targets one chat', async () => {
  const env = await setup();
  try {
    const a = await env.service.create('A', env.root, null),
      b = await env.service.create('B', env.root, null),
      c = await env.service.create('C', join(env.root, 'other'), null);
    await env.service.message(a.id, 'hang', randomUUID());
    await waitFor(env.store, () => env.store.chat(a.id).turnId ?? undefined);
    await env.service.message(b.id, 'normal', randomUUID());
    await env.service.message(c.id, 'normal', randomUUID());
    await waitFor(env.store, () =>
      env.store.chat(c.id).status === 'completed' ? true : undefined,
    );
    assert.equal(env.store.chat(a.id).status, 'running');
    assert.equal(env.store.chat(b.id).status, 'queued');
    await env.service.stop(a.id);
    await waitFor(env.store, () =>
      env.store.chat(b.id).status === 'completed' ? true : undefined,
    );
    assert.equal(env.store.chat(a.id).status, 'interrupted');
  } finally {
    await env.close();
  }
});
test('idempotency rejects mismatched reuse and never sends duplicate messages', async () => {
  const env = await setup();
  try {
    const c = await env.service.create('Dedup', env.root, null),
      id = randomUUID();
    const input = { type: 'message', chat: c.id, text: 'normal' };
    await env.service.operation(id, input, () => env.service.message(c.id, 'normal', id));
    await env.service.operation(id, input, () => env.service.message(c.id, 'normal', id));
    await assert.rejects(
      () => env.service.operation(id, { ...input, text: 'different' }, async () => ({})),
      /另一条指令/,
    );
    await waitFor(env.store, () =>
      env.store.chat(c.id).status === 'completed' ? true : undefined,
    );
    assert.equal(env.store.entries(c.id).filter((e) => e.kind === 'user').length, 1);
  } finally {
    await env.close();
  }
});

test('concurrent messages cannot overwrite a running reservation; stop cancels queued follow-up', async () => {
  const env = await setup();
  try {
    const chat = await env.service.create('Concurrent', env.root, null);
    await Promise.all([
      env.service.message(chat.id, 'hang', randomUUID()),
      env.service.message(chat.id, 'normal', randomUUID()),
    ]);
    await waitFor(env.store, () => env.store.chat(chat.id).turnId ?? undefined);
    assert.equal(env.store.chat(chat.id).status, 'running');
    assert.equal(env.store.entries(chat.id).filter((e) => e.status === 'queued').length, 1);
    await env.service.stop(chat.id);
    await waitFor(env.store, () =>
      env.store.chat(chat.id).status === 'interrupted' ? true : undefined,
    );
    assert.equal(env.store.entries(chat.id).filter((e) => e.status === 'cancelled').length, 1);
    assert.equal(env.store.entries(chat.id).filter((e) => e.kind === 'assistant').length, 0);
  } finally {
    await env.close();
  }
});
test('questions require answers; process exit expires pending state; restart never resumes work automatically', async () => {
  const env = await setup();
  try {
    const c = await env.service.create('Question', env.root, null);
    await env.service.message(c.id, 'question', randomUUID());
    const req = await waitFor(env.store, () =>
      env.store.requests().find((r) => r.status === 'pending'),
    );
    await assert.rejects(() => env.service.respond(req.id, undefined, {}), /所有问题/);
    await env.service.respond(req.id, undefined, { q1: ['Yes'] });
    await waitFor(env.store, () =>
      env.store.chat(c.id).status === 'completed' ? true : undefined,
    );
    await env.service.message(c.id, 'exit', randomUUID());
    await waitFor(env.store, () =>
      env.store.chat(c.id).status === 'interrupted' ? true : undefined,
    );
    assert.equal(env.service.ready, false);
    env.store.patchChat(c.id, { status: 'running', turnId: 'old-turn' });
    const restored = new PocketService(env.store, env.service.host);
    assert.equal(restored.store.chat(c.id).status, 'interrupted');
    assert.equal(restored.store.chat(c.id).turnId, null);
    assert.equal(restored.ready, false);
  } finally {
    await env.close();
  }
});
