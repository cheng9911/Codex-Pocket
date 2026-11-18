import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DesktopBridge, applyDesktopPatches } from '../apps/server/src/desktop-bridge.ts';
import { setup } from './helpers.ts';
import { createHttp } from '../apps/server/src/http.ts';

const pause = (ms = 100) => new Promise((r) => setTimeout(r, ms));
async function fixture(root: string) {
  const path = join(root, 'desktop.sock');
  let socket: Socket,
    revision = 0,
    approvals = 0;
  const calls: any[] = [];
  const state: any = {
    id: 'native-desktop',
    cwd: root,
    requests: [],
    turns: [],
    threadRuntimeStatus: { type: 'idle' },
  };
  function send(m: any) {
    const body = Buffer.from(JSON.stringify(m)),
      header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    // Deliberately fragment the header to exercise stream framing.
    socket.write(header.subarray(0, 2));
    socket.write(Buffer.concat([header.subarray(2), body]));
  }
  function snapshot(source = 'owner', version = 11) {
    send({
      type: 'broadcast',
      method: 'thread-stream-state-changed',
      version,
      sourceClientId: source,
      params: {
        conversationId: state.id,
        hostId: 'local',
        change: { type: 'snapshot', revision: ++revision, conversationState: state },
      },
    });
  }
  const server = createServer((s) => {
    socket = s;
    let buffer = Buffer.alloc(0);
    s.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0),
          m = JSON.parse(buffer.subarray(4, length + 4).toString());
        buffer = buffer.subarray(length + 4);
        if (m.type !== 'request') continue;
        calls.push(m);
        let result: any = {};
        if (m.method === 'initialize') result = { clientId: 'pocket' };
        if (m.method === 'thread-owner-discovery') result = { supportsUntrustedAppInput: true };
        if (m.method === 'thread-follower-load-complete-history') {
          snapshot();
          result = { revision };
        }
        if (m.method === 'thread-follower-start-turn') {
          const turn = {
            turnId: randomUUID(),
            status: 'inProgress',
            params: m.params.turnStart.request,
            items: [],
          };
          state.turns.push(turn);
          state.threadRuntimeStatus = { type: 'active' };
          snapshot();
          result = { result: { turn: { id: turn.turnId } } };
        }
        if (m.method === 'thread-follower-steer-turn')
          result = { result: { turnId: state.turns.at(-1).turnId } };
        if (m.method === 'thread-follower-interrupt-turn') {
          const turn = state.turns.at(-1);
          assert.equal(m.params.expectedTurnId, turn.turnId);
          assert.equal(m.version, 4);
          turn.status = 'interrupted';
          state.threadRuntimeStatus = { type: 'idle' };
          state.requests = [];
          snapshot();
          result = { ok: true, interruptedTurnId: turn.turnId };
        }
        if (m.method === 'thread-follower-command-approval-decision') {
          assert.equal(m.version, 1);
          approvals++;
          state.requests = [];
          snapshot();
          result = { ok: true };
        }
        send({
          type: 'response',
          method: m.method,
          requestId: m.requestId,
          resultType: 'success',
          handledByClientId: 'owner',
          result,
        });
      }
    });
  });
  await new Promise<void>((r) => server.listen(path, r));
  return {
    path,
    state,
    calls,
    snapshot,
    gap: () =>
      send({
        type: 'broadcast',
        method: 'thread-stream-state-changed',
        version: 11,
        sourceClientId: 'owner',
        params: {
          conversationId: state.id,
          hostId: 'local',
          change: { type: 'patches', baseRevision: -1, revision: ++revision, patches: [] },
        },
      }),
    approvals: () => approvals,
    disconnect: () => socket.destroy(),
    close: async () => {
      socket?.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

test('desktop patches preserve array order and reject prototype/path corruption', () => {
  const s = { a: ['one', 'three'] };
  applyDesktopPatches(s, [
    { op: 'add', path: ['a', 1], value: 'two' },
    { op: 'remove', path: ['a', 0] },
  ]);
  assert.deepEqual(s.a, ['two', 'three']);
  assert.throws(() =>
    applyDesktopPatches(s, [{ op: 'add', path: ['__proto__', 'polluted'], value: true }]),
  );
  assert.throws(() =>
    applyDesktopPatches(s, [{ op: 'replace', path: ['missing', 'x'], value: 1 }]),
  );
  assert.equal(({} as any).polluted, undefined);
});

test('desktop sends requested settings to the existing owner in the next turn', async () => {
  const env = await setup();
  const desktop = await fixture(env.root);
  const bridge = new DesktopBridge();
  try {
    await bridge.ipc.open(desktop.path);
    bridge.connected = true;
    await bridge.attach(desktop.state.id);
    await bridge.send(desktop.state.id, 'next turn', randomUUID(), undefined, {
      model: 'fixture-alt', effort: 'high', access: 'full-access',
    });
    const { request, context } = desktop.calls.find((call) => call.method === 'thread-follower-start-turn').params.turnStart;
    assert.equal(request.threadId, desktop.state.id);
    assert.equal(request.model, 'fixture-alt');
    assert.equal(request.effort, 'high');
    assert.deepEqual(request.sandboxPolicy, { type: 'dangerFullAccess' });
    assert.deepEqual(context, { inheritThreadSettings: false });
  } finally {
    bridge.close();
    await desktop.close();
    await env.close();
  }
});

test('desktop framing, owner isolation, revision resync and incompatible protocol fail closed', async () => {
  const e = await setup(),
    f = await fixture(e.root),
    b = new DesktopBridge();
  try {
    await b.ipc.open(f.path);
    b.connected = true;
    await b.attach(f.state.id);
    f.state.title = 'spoof';
    f.snapshot('foreign');
    await pause();
    assert.notEqual(b.state(f.state.id).title, 'spoof');
    f.state.title = 'valid';
    f.snapshot();
    await pause();
    assert.equal(b.state(f.state.id).title, 'valid');
    const reads = f.calls.filter(
      (m) => m.method === 'thread-follower-load-complete-history',
    ).length;
    f.gap();
    await pause();
    assert.equal(b.state(f.state.id).title, 'valid');
    assert.equal(
      f.calls.filter((m) => m.method === 'thread-follower-load-complete-history').length,
      reads + 1,
    );
    f.snapshot('owner', 99);
    await pause();
    assert.equal(b.state(f.state.id), null);
    f.disconnect();
    await pause();
    assert.equal(b.connected, false);
  } finally {
    b.close();
    await f.close();
    await e.close();
  }
});

test('desktop service controls existing writer, claims approvals once, expires requests and cancels queue on disconnect', async () => {
  const e = await setup(),
    f = await fixture(e.root),
    b = e.service.desktop.bridge;
  const id = 'codex:' + f.state.id;
  try {
    await b.ipc.open(f.path);
    b.connected = true;
    e.store.putChat({
      id,
      nativeId: f.state.id,
      source: 'codex',
      control: 'history',
      title: 'Desktop test',
      cwd: e.root,
      model: null,
      status: 'history',
      turnId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      error: null,
    });
    await e.service.desktop.attach(id);
    await e.service.message(id, 'hello', randomUUID());
    await pause(200);
    const turnId = e.store.chat(id).turnId!;
    assert.equal(e.store.chat(id).status, 'running');
    assert.ok(turnId);
    await assert.rejects(
      e.service.message(id, 'wrong turn', randomUUID(), 'steer', 'wrong'),
      /轮次/,
    );
    await e.service.message(id, 'follow up', randomUUID(), 'steer', turnId);
    f.state.requests = [
      {
        id: 0,
        method: 'item/commandExecution/requestApproval',
        params: { turnId, command: 'printf ok', availableDecisions: ['accept', 'cancel'] },
      },
    ];
    f.snapshot();
    await pause();
    const req = e.store.requests().find((r) => r.status === 'pending')!;
    assert.ok(req);
    const answers = await Promise.allSettled([
      e.service.respond(req.id, 'accept'),
      e.service.respond(req.id, 'accept'),
    ]);
    assert.equal(answers.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(f.approvals(), 1);
    await e.service.stop(id);
    await pause();
    assert.equal(e.store.chat(id).status, 'interrupted');
    await e.service.message(id, 'next', randomUUID());
    await pause(200);
    const interrupts = f.calls.filter((m) => m.method === 'thread-follower-interrupt-turn').length;
    e.service.desktop.detach(id);
    assert.equal(f.state.turns.at(-1).status, 'inProgress');
    assert.equal(
      f.calls.filter((m) => m.method === 'thread-follower-interrupt-turn').length,
      interrupts,
    );
    await e.service.desktop.attach(id);
    await e.service.message(id, 'queued', randomUUID());
    assert.equal(e.service.queued().length, 1);
    f.state.requests = [
      {
        id: 1,
        method: 'item/commandExecution/requestApproval',
        params: { command: 'printf next' },
      },
    ];
    f.snapshot();
    await pause();
    f.disconnect();
    await pause();
    assert.equal(e.store.chat(id).desktopConnected, false);
    assert.equal(e.service.queued().length, 0);
    assert.equal(
      e.store.requests().some((r) => r.status === 'pending'),
      false,
    );
    await assert.rejects(e.service.message(id, 'must not send', randomUUID()), /重新连接/);
    const stats = await e.service.transport!.request('test/stats');
    assert.equal(stats.calls.includes('thread/resume'), false);
    assert.equal(stats.calls.includes('turn/start'), false);
    assert.equal(f.calls.filter((m) => m.method === 'thread-follower-start-turn').length, 2);
  } finally {
    await f.close();
    await e.close();
  }
});

test('desktop endpoints retain host authentication and workspace restrictions', async () => {
  const e = await setup(),
    h = createHttp(e.service);
  try {
    await new Promise<void>((r) => h.http.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(h.http.address() as any).port}`;
    assert.equal(
      (
        await fetch(base + '/api/chats/example/desktop-connect', {
          method: 'POST',
          headers: { 'X-Pocket-Client': 'web' },
        })
      ).status,
      401,
    );
    e.store.putChat({
      id: 'foreign',
      nativeId: 'foreign',
      source: 'codex',
      cwd: '/etc',
      model: null,
      title: 'foreign',
      status: 'history',
      turnId: null,
      createdAt: 0,
      updatedAt: 0,
      error: null,
    });
    await assert.rejects(e.service.desktop.attach('foreign'), /允许/);
    assert.equal(e.service.desktop.bridge.connected, false);
  } finally {
    await h.close();
    await e.close();
  }
});
