const handshakeTimeout = 20_000;

export function subscribeToEvents(options: {
  cursor: () => number;
  onState: (state: '连接中' | '实时连接' | '连接已断开') => void;
  onMessage: (data: any) => void;
  onExpired: () => void;
}) {
  let socket: WebSocket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let healthTimer: ReturnType<typeof setTimeout> | undefined;
  let authProbe: AbortController | undefined;
  let refreshHealth = () => {};
  let attempts = 0;
  let stopped = false;

  function dispose() {
    stopped = true;
    clearTimeout(retryTimer);
    clearTimeout(healthTimer);
    authProbe?.abort();
    socket?.close();
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('online', resume);
  }

  function expire() {
    dispose();
    options.onExpired();
  }

  async function checkSession() {
    if (authProbe || !navigator.onLine) return;
    const probe = new AbortController();
    authProbe = probe;
    const timeout = setTimeout(() => probe.abort(), handshakeTimeout);
    try {
      const response = await fetch('/api/snapshot', { method: 'HEAD', signal: probe.signal });
      if (!stopped && !probe.signal.aborted && response.status === 401) expire();
    } catch {
      // Transport errors are handled by the WebSocket retry.
    } finally {
      clearTimeout(timeout);
      authProbe = undefined;
    }
  }

  function connect() {
    if (stopped || socket || !navigator.onLine) return;
    clearTimeout(retryTimer);
    options.onState('连接中');
    const url = new URL('/api/events', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('after', String(options.cursor()));
    const ws = new WebSocket(url);
    socket = ws;
    let initialized = false;
    let heartbeatMs = 0;

    function disconnected(code?: number) {
      if (stopped || socket !== ws) return;
      socket = undefined;
      clearTimeout(healthTimer);
      ws.close();
      if (code === 4001) {
        expire();
        return;
      }
      options.onState('连接已断开');
      retryTimer = setTimeout(connect, Math.min(15_000, 500 * 2 ** attempts++) + Math.random() * 300);
      if (!initialized) void checkSession();
    }

    refreshHealth = () => {
      clearTimeout(healthTimer);
      if (document.visibilityState !== 'visible') return;
      const timeout = initialized ? (heartbeatMs ? 2 * heartbeatMs + 10_000 : 0) : handshakeTimeout;
      if (timeout) healthTimer = setTimeout(disconnected, timeout);
    };

    ws.onmessage = (event) => {
      if (stopped || socket !== ws) return;
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof data?.type !== 'string') return;
      if (!initialized) {
        if (data.type !== 'snapshot') return;
        const interval = data.heartbeatMs;
        if (Number.isFinite(interval) && interval >= 5_000 && interval <= 60_000)
          heartbeatMs = interval;
        initialized = true;
        attempts = 0;
        authProbe?.abort();
        options.onState('实时连接');
      }
      refreshHealth();
      if (data.type !== 'heartbeat') options.onMessage(data);
    };
    ws.onclose = (event) => disconnected(event.code);
    ws.onerror = () => disconnected();
    refreshHealth();
  }

  function resume() {
    if (socket) refreshHealth();
    else if (document.visibilityState === 'visible') connect();
  }

  document.addEventListener('visibilitychange', resume);
  window.addEventListener('online', resume);
  connect();
  return dispose;
}
