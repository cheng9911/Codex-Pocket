// Deterministic process fixture. Only tests explicitly launch this file.
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
const chats = new Map(),
  approvals = new Map();
const histories = new Map(),
  calls = [];
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const event = (method, params) => send({ method, params });
function finish(threadId, turnId, status = 'completed', text = 'POCKET_OK') {
  const c = chats.get(threadId);
  if (!c || c.turnId !== turnId) return;
  const id = 'assistant-' + turnId;
  event('item/started', { threadId, turnId, item: { id, type: 'agentMessage', text: '' } });
  event('item/agentMessage/delta', { threadId, turnId, itemId: id, delta: text });
  event('item/completed', {
    threadId,
    turnId,
    item: { id, type: 'agentMessage', text, status: 'completed' },
  });
  const history = histories.get(threadId);
  if (history) {
    const turn = history.find((t) => t.id === turnId);
    if (turn) {
      turn.status = status;
      turn.items.push({ id, type: 'agentMessage', text });
    }
  }
  c.turnId = null;
  event('turn/completed', { threadId, turn: { id: turnId, status } });
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  const p = m.params ?? {};
  if (m.method) calls.push(m.method);
  if (m.method === 'test/seed') {
    for (const c of p.chats) {
      chats.set(c.id, { ...c, turnId: null });
      histories.set(c.id, c.turns ?? []);
    }
    send({ id: m.id, result: {} });
    return;
  }
  if (m.method === 'test/stats') {
    send({ id: m.id, result: { calls } });
    return;
  }
  if (m.method === 'thread/list') {
    const rows = [...chats.values()].filter((c) => c.source);
    const offset = Number(p.cursor ?? 0),
      limit = p.limit ?? 50;
    send({
      id: m.id,
      result: {
        data: rows.slice(offset, offset + limit),
        nextCursor: offset + limit < rows.length ? String(offset + limit) : null,
      },
    });
    return;
  }
  if (m.method === 'thread/read') {
    const c = chats.get(p.threadId);
    send({
      id: m.id,
      result: {
        thread: {
          ...c,
          status: { type: 'notLoaded' },
          turns: p.includeTurns ? (histories.get(p.threadId) ?? []) : [],
        },
      },
    });
    return;
  }
  if (m.method === 'thread/turns/list') {
    const rows = [...(histories.get(p.threadId) ?? [])].reverse(),
      offset = Number(p.cursor ?? 0),
      limit = p.limit ?? 10;
    send({
      id: m.id,
      result: {
        data: rows.slice(offset, offset + limit),
        nextCursor: offset + limit < rows.length ? String(offset + limit) : null,
      },
    });
    return;
  }
  if (m.method === 'thread/loaded/list') {
    send({
      id: m.id,
      result: { data: [...chats.values()].filter((c) => !c.unsubscribed).map((c) => c.id) },
    });
    return;
  }
  if (m.method === 'thread/unsubscribe') {
    if (chats.has(p.threadId)) chats.get(p.threadId).unsubscribed = true;
    send({ id: m.id, result: { status: 'unsubscribed' } });
    return;
  }

  if (!m.method) {
    const a = approvals.get(m.id);
    if (a) {
      approvals.delete(m.id);
      finish(
        a.threadId,
        a.turnId,
        'completed',
        m.result?.decision === 'decline' ? 'DECLINED' : m.result?.answers ? 'ANSWERED' : 'APPROVED',
      );
    }
    return;
  }
  if (m.method === 'initialized') return;
  if (m.method === 'initialize') {
    send({ id: m.id, result: { userAgent: 'fixture', platformFamily: 'unix' } });
    return;
  }
  if (m.method === 'model/list') {
    send({
      id: m.id,
      result: { data: [{ id: 'fixture-model', displayName: 'Fixture model' }], nextCursor: null },
    });
    return;
  }
  if (m.method === 'account/read') {
    send({
      id: m.id,
      result: { account: { type: 'chatgpt', planType: 'plus', email: 'private@example.test' } },
    });
    return;
  }
  if (m.method === 'account/rateLimits/read') {
    send({
      id: m.id,
      result: {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1900000000 },
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: 'codex',
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1900000000 },
          },
          other: {
            limitId: 'other',
            limitName: 'Other model',
            secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: null },
          },
        },
      },
    });
    return;
  }
  if (m.method === 'turn/steer') {
    const c = chats.get(p.threadId);
    if (!c?.turnId || c.turnId !== p.expectedTurnId) {
      send({ id: m.id, error: { code: -32600, message: 'No matching active turn' } });
      return;
    }
    send({ id: m.id, result: { turnId: c.turnId } });
    if (p.input[0].text === 'complete') finish(p.threadId, c.turnId);
    if (p.input[0].text === 'fail') finish(p.threadId, c.turnId, 'failed');
    return;
  }
  if (m.method === 'thread/start') {
    const id = randomUUID();
    chats.set(id, { id, cwd: p.cwd, turnId: null });
    send({ id: m.id, result: { thread: chats.get(id) } });
    return;
  }
  if (m.method === 'thread/resume') {
    if (chats.has(p.threadId)) chats.get(p.threadId).unsubscribed = false;
    if (chats.get(p.threadId)?.locked) {
      send({ id: m.id, error: { code: -32600, message: 'thread already has an active writer' } });
      return;
    }
    send({ id: m.id, result: { thread: { id: p.threadId } } });
    if (!chats.has(p.threadId)) chats.set(p.threadId, { id: p.threadId, turnId: null });
    return;
  }
  if (m.method === 'turn/start') {
    const c = chats.get(p.threadId);
    const turnId = randomUUID();
    c.turnId = turnId;
    send({ id: m.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    event('turn/started', { threadId: p.threadId, turn: { id: turnId } });
    const text = p.input[0].text;
    histories.get(p.threadId)?.push({
      id: turnId,
      status: 'inProgress',
      startedAt: Date.now() / 1000,
      items: [{ id: 'user-' + turnId, type: 'userMessage', content: [{ type: 'text', text }] }],
    });
    if (text === 'exit') {
      process.exit(2);
      return;
    }
    if (text === 'hang') return;
    if (text === 'approval' || text === 'question') {
      const id = randomUUID();
      approvals.set(id, { threadId: p.threadId, turnId });
      send({
        id,
        method:
          text === 'approval'
            ? 'item/commandExecution/requestApproval'
            : 'item/tool/requestUserInput',
        params: {
          threadId: p.threadId,
          turnId,
          itemId: 'cmd-' + turnId,
          command: 'printf test',
          cwd: c.cwd,
          reason: '测试命令需要你批准后继续。',
          availableDecisions: ['accept', 'acceptForSession', 'decline'],
          questions: [
            {
              id: 'q1',
              header: 'Choose',
              question: 'Which option?',
              options: [{ label: 'Yes', description: 'Continue' }],
            },
          ],
        },
      });
      return;
    }
    finish(p.threadId, turnId);
    return;
  }
  if (m.method === 'turn/interrupt') {
    send({ id: m.id, result: {} });
    chats.get(p.threadId).turnId = null;
    event('turn/completed', {
      threadId: p.threadId,
      turn: { id: p.turnId, status: 'interrupted' },
    });
    return;
  }
  send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
});
