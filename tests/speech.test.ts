import assert from 'node:assert/strict';
import test from 'node:test';
import { captureSpeech, type Recognition } from '../apps/web/src/speech.ts';

function setup() {
  const received: unknown[] = [];
  const calls: string[] = [];
  const recognizer: Recognition = {
    lang: '',
    continuous: true,
    interimResults: false,
    onresult: null,
    onerror: null,
    onnomatch: null,
    onend: null,
    start: () => calls.push('start'),
    stop: () => calls.push('stop'),
    abort: () => calls.push('abort'),
  };
  const session = captureSpeech(recognizer, 'zh-CN', {
    preview() {},
    completed: (result) => received.push(result),
  });
  session.start();
  const result = (transcript: string, isFinal = false) =>
    recognizer.onresult?.({ results: [{ isFinal, 0: { transcript } }] });
  return { recognizer, session, result, received, calls };
}

test('a final result after stop replaces interim text and completes exactly once', () => {
  const { recognizer, session, result, received, calls } = setup();
  assert.equal(recognizer.lang, 'zh-CN');
  result('草高');
  session.stop();
  session.stop();
  const lateEnd = recognizer.onend!;
  result('草稿', true);
  lateEnd();
  assert.deepEqual(calls, ['start', 'stop']);
  assert.deepEqual(received, [{ text: '草稿', usedInterim: false, error: undefined }]);
});

test('a browser that never finishes is aborted and the latest interim text survives', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { recognizer, session, result, received, calls } = setup();
  result('第一');
  result('第一句');
  recognizer.onresult?.({ results: [] });
  session.stop();
  t.mock.timers.tick(5_000);
  assert.deepEqual(calls, ['start', 'stop', 'abort']);
  assert.deepEqual(received, [{ text: '第一句', usedInterim: true, error: 'timeout' }]);
});

test('natural end saves an interim transcript, and errors complete without an end event', () => {
  const partial = setup();
  partial.result('临时文字');
  partial.recognizer.onend?.();
  assert.deepEqual(partial.received, [{ text: '临时文字', usedInterim: true, error: undefined }]);

  const denied = setup();
  denied.recognizer.onerror?.({ error: 'not-allowed' });
  assert.deepEqual(denied.received, [{ text: '', usedInterim: false, error: 'not-allowed' }]);
  assert.deepEqual(denied.calls, ['start', 'abort']);
});

test('cancelling a recording does not edit the draft', () => {
  const { recognizer, session, result, received, calls } = setup();
  result('不应放入草稿');
  const lateEnd = recognizer.onend!;
  session.cancel();
  lateEnd();
  assert.deepEqual(calls, ['start', 'abort']);
  assert.deepEqual(received, []);
});
