// Opt-in real desktop test. Only target a dedicated, idle desktop test chat.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/server/src/store.ts';
import { PocketService } from '../apps/server/src/service.ts';
import { createHttp } from '../apps/server/src/http.ts';
import { DesktopBridge, desktopTurns } from '../apps/server/src/desktop-bridge.ts';
import { makePasswordConfig } from '../apps/server/src/password.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
const nativeId = process.env.POCKET_DESKTOP_TEST_THREAD;
if (!nativeId)
  throw new Error(
    '请指定独立测试聊天：POCKET_DESKTOP_TEST_THREAD=<聊天 ID> npm run verify:desktop',
  );
const probe = new DesktopBridge();
let state: any;
try {
  state = await probe.attach(nativeId);
} finally {
  probe.close();
}
if (desktopTurns(state).at(-1)?.status === 'inProgress')
  throw new Error('测试聊天正在运行，请选择空闲的独立测试聊天');
const temp = await mkdtemp(join(tmpdir(), 'pocket-desktop-verification-'));
const store = new Store(join(temp, 'pocket.sqlite'));
const service = new PocketService(store, {
  id: store.meta('hostId')!,
  name: 'Pocket 桌面桥接测试',
  version: 'test',
});
const preview = process.argv.includes('--preview');
const server = createHttp(service, {
  password: preview ? await makePasswordConfig('pocket-bridge-test') : undefined,
});
const id = 'codex:' + nativeId;
let cleaned = false;
async function close() {
  if (cleaned) return;
  cleaned = true;
  await service.close();
  await server.close();
  store.close();
  await rm(temp, { recursive: true, force: true });
}
try {
  await service.start([state.cwd]);
  store.putChat({
    id,
    nativeId,
    source: 'codex',
    control: 'history',
    title: 'Pocket 桌面桥接验证',
    cwd: state.cwd,
    model: null,
    status: 'history',
    turnId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    error: null,
  });
  await new Promise<void>((r) => server.http.listen(preview ? 4312 : 0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.http.address() as any).port}`;
  const token = preview
    ? await server.auth.login('pocket-bridge-test', 'Verification', false)
    : server.auth.exchange(server.auth.pairCode(), 'Verification', 'local');
  const headers = {
    Cookie: server.auth.cookieName + '=' + token,
    Origin: base,
    'Content-Type': 'application/json',
    'X-Pocket-Client': 'web',
  };
  async function post(path: string, body: any = {}) {
    const r = await fetch(base + '/api' + path, {
      method: 'POST',
      headers,
      body: JSON.stringify({ operationId: randomUUID(), ...body }),
    });
    const result = await r.json();
    assert.equal(r.status, 200, JSON.stringify(result));
    return result;
  }
  const prefix = '/chats/' + encodeURIComponent(id);
  await post(prefix + '/desktop-connect');
  const wait = async (check: () => boolean, timeout = 60000) => {
    const end = Date.now() + timeout;
    while (!check()) {
      if (Date.now() > end)
        throw new Error('Desktop verification timeout: ' + JSON.stringify(store.chat(id)));
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  console.log('PASS: authenticated HTTP connected to the existing desktop owner');
  if (!preview) {
    await post(prefix + '/messages', {
      text: '独立桥接测试：只回复 POCKET_HTTP_OK，不调用工具。',
      delivery: 'queue',
    });
    await wait(
      () =>
        store.entries(id).some((e) => e.text === 'POCKET_HTTP_OK') &&
        store.chat(id).status === 'completed',
    );
    console.log('PASS: HTTP send → desktop turn → live stored output');
    await post(prefix + '/messages', {
      text: '独立桥接停止测试：请说明将等待，然后执行 sleep 30；不要访问文件和网络。',
      delivery: 'queue',
    });
    await wait(() => !!store.chat(id).turnId && store.chat(id).status === 'running');
    const turnId = store.chat(id).turnId;
    await post(prefix + '/messages', {
      text: '追加测试指令：完成等待后只回复 POCKET_HTTP_STEER。',
      delivery: 'steer',
      expectedTurnId: turnId,
    });
    await post(prefix + '/stop');
    await wait(() => store.chat(id).status === 'interrupted');
    console.log('PASS: HTTP steer and stop target the same desktop turn');
    const bridge = service.desktop.bridge;
    const owner = (
      await bridge.ipc.request('thread-owner-discovery', {
        hostId: 'local',
        conversationId: nativeId,
      })
    ).handledByClientId;
    await bridge.ipc.request(
      'thread-follower-start-turn',
      {
        conversationId: nativeId,
        turnStart: {
          request: {
            threadId: nativeId,
            input: [
              {
                type: 'text',
                text: '独立审批测试：仅执行 python3 -c "print(7654321)"。使用 exec_command 显式申请 require_escalated，justification 写 Pocket 审批测试。等待审批，不改用其他工具，不访问文件或网络。',
                text_elements: [],
              },
            ],
            approvalPolicy: 'on-request',
            approvalsReviewer: 'user',
            sandboxPolicy: { type: 'readOnly' },
            permissions: ':read-only',
          },
          context: { inheritThreadSettings: false },
        },
      },
      owner,
    );
    await wait(() => store.requests().some((r) => r.status === 'pending'));
    const pending = store.requests().find((r) => r.status === 'pending')!;
    assert.equal(pending.method, 'item/commandExecution/requestApproval');
    assert.match(pending.params.command, /7654321/);
    await post('/requests/' + encodeURIComponent(pending.id) + '/respond', { decision: 'accept' });
    await wait(() => store.chat(id).status === 'completed');
    assert.ok(store.entries(id).some((e) => e.kind === 'tool' && e.text.includes('7654321')));
    console.log('PASS: desktop approval → Pocket request → HTTP approve → real command output');
    // Reconnect is read-only and must preserve native thread and terminal state.
    await post(prefix + '/desktop-disconnect');
    await post(prefix + '/desktop-connect');
    assert.equal(store.chat(id).nativeId, nativeId);
    assert.equal(store.chat(id).status, 'completed');
    console.log('PASS: detach/reconnect preserves the desktop task and history');
  } else {
    console.log('Isolated live desktop preview: ' + base);
    console.log('Test-only password: pocket-bridge-test');
    process.on('SIGINT', () => void close().then(() => process.exit(0)));
    process.on('SIGTERM', () => void close().then(() => process.exit(0)));
    await new Promise(() => {});
  }
} finally {
  await close();
}
