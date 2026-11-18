import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, waitFor } from './helpers.ts';
import { PocketService } from '../apps/server/src/service.ts';
import { createHttp } from '../apps/server/src/http.ts';

const turns = Array.from({ length: 12 }, (_, n) => ({
  id: `old-turn-${n}`,
  status: 'completed',
  startedAt: 1700000000 + n,
  items: [
    { id: '0', type: 'userMessage', content: [{ type: 'text', text: `Question ${n}` }] },
    { id: '1', type: 'agentMessage', text: `Answer ${n}` },
    {
      id: '2',
      type: 'commandExecution',
      command: 'printf test',
      aggregatedOutput: 'test',
      status: 'completed',
    },
  ],
}));
async function seed(env: Awaited<ReturnType<typeof setup>>, count = 1, extra = {}) {
  await env.service.transport!.request('test/seed', {
    chats: Array.from({ length: count }, (_, i) => ({
      id: `native-${i}`,
      cwd: env.root,
      name: `Local ${i}`,
      preview: 'Preview',
      source: 'vscode',
      historyMode: 'paginated',
      createdAt: 1700000000,
      updatedAt: 1700000012,
      turns,
      ...extra,
    })),
  });
}

test('local discovery pages, de-duplicates and preserves custom titles without resuming a writer', async () => {
  const e = await setup();
  try {
    await seed(e, 55);
    const page = await e.service.local.list();
    assert.equal(e.store.chats().length, 50);
    assert.equal(page.nextCursor, '50');
    await e.service.local.list(page.nextCursor);
    const chat = e.store.chat('codex:native-0');
    e.service.organize(chat.id, { title: 'My title', pinned: true });
    await e.service.local.list();
    assert.equal(e.store.chats().length, 55);
    assert.equal(e.store.chat(chat.id).title, 'My title');
    assert.equal(e.store.chat(chat.id).pinned, true);
    assert.equal(chat.status, 'history');
    const stats = await e.service.transport!.request('test/stats');
    assert.equal(stats.calls.includes('thread/resume'), false);
    await assert.rejects(e.service.message(chat.id, 'hello', randomUUID()), /先选择/);
    await assert.rejects(e.service.stop(chat.id), /历史查看/);
  } finally {
    await e.close();
  }
});

test('history pages retain native turn order and unique item IDs and do not create approval requests', async () => {
  const e = await setup();
  try {
    await seed(e);
    await e.service.local.list();
    const chat = e.store.chat('codex:native-0');
    const first = await e.service.local.history(chat);
    assert.equal(first.entries[0].text, 'Question 2');
    assert.equal(first.entries.at(-1)?.text, 'test');
    const second = await e.service.local.history(chat, first.nextCursor);
    const all = [...second.entries, ...first.entries];
    assert.equal(all.length, 36);
    assert.equal(new Set(all.map((e) => e.id)).size, 36);
    assert.equal(second.hasMore, false);
    assert.equal(e.store.requests().length, 0);
    assert.equal(
      (await e.service.transport!.request('test/stats')).calls.includes('thread/resume'),
      false,
    );
  } finally {
    await e.close();
  }
});

test('continue retains native ID, receives approvals and stop, merges history once, and releases ownership', async () => {
  const e = await setup();
  try {
    await seed(e);
    await e.service.local.list();
    const id = 'codex:native-0';
    await e.service.continueLocal(id);
    assert.equal(e.store.chat(id).control, 'pocket');
    const op = randomUUID();
    await e.service.message(id, 'normal', op);
    await waitFor(e.store, () => (e.store.chat(id).status === 'completed' ? true : undefined));
    const history = await e.service.local.history(e.store.chat(id));
    assert.equal(history.entries.filter((e) => e.kind === 'user' && e.text === 'normal').length, 1);
    assert.equal(history.entries.filter((e) => e.text === 'POCKET_OK').length, 1);
    assert.equal(history.entries.find((e) => e.text === 'normal')?.id, `user:${op}`);
    await e.service.message(id, 'approval', randomUUID());
    const request = await waitFor(e.store, () =>
      e.store.requests().find((r) => r.status === 'pending'),
    );
    await assert.rejects(e.service.releaseLocal(id), /先停止/);
    await e.service.respond(request.id, 'accept');
    await waitFor(e.store, () => (e.store.chat(id).status === 'completed' ? true : undefined));
    await e.service.message(id, 'hang', randomUUID());
    await waitFor(e.store, () => e.store.chat(id).turnId ?? undefined);
    await e.service.stop(id);
    await waitFor(e.store, () => (e.store.chat(id).status === 'interrupted' ? true : undefined));
    await e.service.releaseLocal(id);
    assert.equal(e.store.chat(id).control, 'history');
    assert.equal(e.store.chat(id).nativeId, 'native-0');
    assert.equal(
      (await e.service.transport!.request('test/stats')).calls.includes('thread/start'),
      false,
    );
  } finally {
    await e.close();
  }
});

test('writer locks and workspace boundaries block continuation; restart never reacquires imported chats', async () => {
  const e = await setup();
  try {
    await seed(e, 1, { locked: true });
    await e.service.local.list();
    await assert.rejects(
      e.service.continueLocal('codex:native-0'),
      (err: any) => err.status === 409 && /占用/.test(err.message),
    );
    assert.equal(e.store.chat('codex:native-0').control, 'history');
    await seed(e, 1, { cwd: '/tmp', locked: false });
    await e.service.local.list();
    await assert.rejects(
      e.service.continueLocal('codex:native-0'),
      (err: any) => err.status === 403,
    );
    await seed(e);
    await e.service.local.list();
    await e.service.continueLocal('codex:native-0');
    const transport = e.service.transport!;
    const request = transport.request.bind(transport);
    transport.request = async (method, params) => {
      if (method === 'thread/unsubscribe') throw new Error('Simulated unsubscribe failure');
      return request(method, params);
    };
    await assert.rejects(e.service.releaseLocal('codex:native-0'), /unsubscribe failure/);
    await assert.rejects(
      e.service.message('codex:native-0', 'must not send', randomUUID()),
      /先选择/,
    );
    transport.request = request;
    await e.service.continueLocal('codex:native-0');
    await e.service.close();
    const restarted = new PocketService(e.store, e.service.host);
    assert.equal(e.store.chat('codex:native-0').control, 'history');
    assert.equal(e.store.chat('codex:native-0').status, 'history');
    await restarted.close();
  } finally {
    await e.close();
  }
});

test('local history and continuation endpoints require host authorization and reject foreign origins', async () => {
  const e = await setup();
  const server = createHttp(e.service, {});
  try {
    await seed(e);
    await new Promise<void>((r) => server.http.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(server.http.address() as any).port}`;
    assert.equal((await fetch(origin + '/api/local-chats')).status, 401);
    assert.equal((await fetch(origin + '/api/chats/codex:native-0/entries')).status, 401);
    const token = server.auth.exchange(server.auth.pairCode(), 'Phone', 'local');
    const headers = {
      Cookie: `${server.auth.cookieName}=${token}`,
      Origin: origin,
      'Content-Type': 'application/json',
      'X-Pocket-Client': 'web',
    };
    assert.equal((await fetch(origin + '/api/local-chats', { headers })).status, 200);
    const history = await fetch(origin + '/api/chats/codex:native-0/entries', { headers });
    assert.equal((await history.json()).entries.length, 30);
    assert.equal(
      (
        await fetch(origin + '/api/chats/codex:native-0/continue', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://evil.test' },
          body: JSON.stringify({ operationId: randomUUID() }),
        })
      ).status,
      403,
    );
  } finally {
    await server.close();
    await e.close();
  }
});
