import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { subscribeToEvents } from '../apps/web/src/event-stream.ts';

function browser(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const window = new EventTarget();
  const network = { onLine: true };
  const sockets: Socket[] = [];
  class Socket {
    closed = false;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number }) => void;
    constructor(readonly url: URL) {
      sockets.push(this);
    }
    close() {
      this.closed = true;
    }
    receive(data: unknown) {
      this.onmessage?.({ data: JSON.stringify(data) });
    }
  }
  for (const [name, value] of Object.entries({
    document: page,
    window,
    navigator: network,
    location: new URL('https://pocket.example.com/'),
    WebSocket: Socket,
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  const states: string[] = [];
  const messages: string[] = [];
  const expired = t.mock.fn();
  const dispose = subscribeToEvents({
    cursor: () => 12,
    onState: (state) => states.push(state),
    onMessage: (data) => messages.push(data.type),
    onExpired: expired,
  });
  const visibility = (state: string) => {
    page.visibilityState = state;
    page.dispatchEvent(new Event('visibilitychange'));
  };
  return { sockets, window, network, states, messages, expired, dispose, visibility };
}

test('keeps a healthy socket on foreground and reconnects only after a socket closes', (t) => {
  const client = browser(t);
  try {
    const original = client.sockets[0];
    original.receive({ type: 'snapshot' });
    client.visibility('hidden');
    t.mock.timers.tick(120_000);
    client.visibility('visible');
    client.window.dispatchEvent(new Event('online'));
    assert.equal(original.closed, false);
    assert.equal(client.sockets.length, 1);

    client.network.onLine = false;
    original.onclose?.({ code: 1006 });
    t.mock.timers.tick(1_000);
    assert.equal(client.sockets.length, 1);
    assert.equal(client.states.at(-1), '连接已断开');
    client.network.onLine = true;
    client.window.dispatchEvent(new Event('online'));
    assert.equal(client.sockets.length, 2);
    assert.equal(client.sockets[1].url.searchParams.get('after'), '12');
    client.sockets[1].receive({ type: 'snapshot' });
    assert.equal(client.states.at(-1), '实时连接');
  } finally {
    client.dispose();
  }
});

test('ignores idle time in the background and recovers a silent connection in the foreground', (t) => {
  const client = browser(t);
  try {
    const original = client.sockets[0];
    original.receive({ type: 'snapshot', heartbeatMs: 20_000 });
    client.visibility('hidden');
    t.mock.timers.tick(120_000);
    client.visibility('visible');
    t.mock.timers.tick(20_000);
    original.receive({ type: 'heartbeat' });
    t.mock.timers.tick(49_999);
    assert.equal(original.closed, false);
    assert.deepEqual(client.messages, ['snapshot']);
    t.mock.timers.tick(1);
    assert.equal(original.closed, true);
    assert.equal(client.states.at(-1), '连接已断开');
    t.mock.timers.tick(1_000);
    assert.equal(client.sockets.length, 2);
  } finally {
    client.dispose();
  }
});

test('session revocation stops automatic retries', (t) => {
  const client = browser(t);
  try {
    client.sockets[0].receive({ type: 'snapshot' });
    client.sockets[0].onclose?.({ code: 4001 });
    t.mock.timers.tick(100_000);
    client.window.dispatchEvent(new Event('online'));
    assert.equal(client.expired.mock.callCount(), 1);
    assert.equal(client.sockets.length, 1);
  } finally {
    client.dispose();
  }
});
