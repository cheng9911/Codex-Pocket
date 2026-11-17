import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../apps/server/src/store.ts';
import { Auth } from '../apps/server/src/auth.ts';
import type { Chat } from '../packages/types.ts';

test('host sessions are isolated even when hosts share a browser hostname', () => {
  const a = new Store(':memory:'),
    b = new Store(':memory:');
  try {
    const authA = new Auth(a, false),
      authB = new Auth(b, false);
    const ta = authA.exchange(authA.pairCode(), 'A', 'local'),
      tb = authB.exchange(authB.pairCode(), 'B', 'local');
    assert.notEqual(authA.cookieName, authB.cookieName);
    const req = {
      headers: { cookie: `${authA.cookieName}=${ta}; ${authB.cookieName}=${tb}` },
    } as any;
    assert(authA.session(req));
    assert(authB.session(req));
    assert.equal(
      authB.session({ headers: { cookie: `${authB.cookieName}=${ta}` } } as any),
      undefined,
    );
  } finally {
    a.close();
    b.close();
  }
});
test('entry pagination keeps ordering and replay falls back after pruning', () => {
  const store = new Store(':memory:');
  try {
    const chat: Chat = {
      id: 'chat',
      title: 'History',
      cwd: '/tmp',
      model: null,
      status: 'idle',
      turnId: null,
      createdAt: 1,
      updatedAt: 1,
      error: null,
    };
    store.putChat(chat);
    for (let i = 0; i < 65; i++)
      store.putEntry({
        id: 'e' + i,
        chatId: 'chat',
        turnId: null,
        kind: 'assistant',
        title: 'Codex',
        text: String(i),
        status: 'completed',
        createdAt: i,
      });
    const recent = store.entries('chat');
    assert.equal(recent.length, 60);
    assert.equal(recent[0].text, '5');
    const older = store.entries('chat', recent[0].order);
    assert.equal(older.length, 5);
    assert.equal(older[4].text, '4');
    store.putEntry({ ...recent[0], text: 'updated' });
    assert.equal(store.entries('chat')[0].order, recent[0].order);
    assert(store.replay(1));
    store.db.prepare('DELETE FROM events WHERE seq<10').run();
    assert.equal(store.replay(1), null);
    assert.equal(store.replay(store.cursor() + 1), null);
  } finally {
    store.close();
  }
});

test('a failed batch publishes no events and leaves neither phantom message nor queued work', () => {
  const store = new Store(':memory:');
  try {
    const events: unknown[] = [];
    store.on('event', (e) => events.push(e));
    assert.throws(
      () =>
        store.batch(() => {
          store.putEntry({
            id: 'message',
            chatId: 'chat',
            turnId: null,
            kind: 'user',
            title: 'You',
            text: 'run',
            status: 'queued',
            createdAt: 1,
          });
          store.db
            .prepare('INSERT INTO queue(operation_id,chat_id,text) VALUES(?,?,?)')
            .run('operation', 'chat', 'run');
          assert.equal(events.length, 0);
          throw new Error('simulated write failure');
        }),
      /simulated/,
    );
    assert.equal(store.entry('message'), undefined);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM queue').get() as any).n, 0);
    assert.equal(store.cursor(), 0);
    assert.equal(events.length, 0);
  } finally {
    store.close();
  }
});
