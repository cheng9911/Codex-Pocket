import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getLocale,
  resolveLocale,
  setLocale,
  speechLocale,
  translate,
} from '../apps/web/src/i18n.ts';
import { english } from '../apps/web/src/messages.ts';

test('language preference validates storage and falls back to browser language', () => {
  assert.equal(resolveLocale('zh-CN', 'en-US'), 'zh-CN');
  assert.equal(resolveLocale('en', 'zh-CN'), 'en');
  assert.equal(resolveLocale('invalid', 'en-GB'), 'en');
  assert.equal(resolveLocale(null, 'ja-JP'), 'zh-CN');
});

test('translation keeps placeholders intact, interpolates literally and leaves unknown text alone', () => {
  for (const [source, value] of Object.entries(english)) {
    assert.deepEqual(
      value.match(/\{\w+\}/g)?.sort() ?? [],
      source.match(/\{\w+\}/g)?.sort() ?? [],
      source,
    );
    assert.ok(value.length > 0, source);
  }
  assert.equal(
    translate('取消收藏 {0}', 'en', { 0: '/tmp/$&/${secret}/项目' }),
    'Remove /tmp/$&/${secret}/项目 from favorites',
  );
  assert.equal(translate('  就绪 ', 'en'), '  Ready ');
  assert.equal(translate('这是聊天中的原文', 'en'), '这是聊天中的原文');
  assert.equal(translate('constructor', 'en'), 'constructor');
  assert.equal(translate('待处理列表，{0} 项', 'zh-CN', { 0: 3 }), '待处理列表，3 项');
});

test('language switches immediately and updates speech locale even without storage', () => {
  const original = getLocale();
  try {
    setLocale('en');
    assert.equal(getLocale(), 'en');
    assert.equal(speechLocale(), 'en-US');
    setLocale('zh-CN');
    assert.equal(speechLocale(), 'zh-CN');
  } finally {
    setLocale(original);
  }
});
