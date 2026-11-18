import { t, getLocale, speechLocale } from './i18n.ts';
import React, { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, Clock, FileText, Mic, Pin, Square, X } from 'lucide-react';
import type {
  AccountUsage,
  Chat,
  Delivery,
  HostInfo,
  QueuedMessage,
  Snapshot,
} from '../../../packages/types.ts';
import { api, ApiError, operation } from './api.ts';
import { captureSpeech, type Recognition } from './speech.ts';

type Draft = { text: string; unsent: boolean; uncertain: boolean };
const emptyDraft = (): Draft => ({ text: '', unsent: false, uncertain: false });
const keyboardDictationOnly = /\bCodexPocketAndroid\//.test(navigator.userAgent);
function loadDraft(key: string): Draft {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (typeof value === 'string') return { ...emptyDraft(), text: value };
    if (value && typeof value.text === 'string') return { ...emptyDraft(), ...value };
  } catch {}
  return emptyDraft();
}
function SpeechInput({ onText, disabled }: { onText: (text: string) => void; disabled: boolean }) {
  const [phase, setPhase] = useState<'idle' | 'listening' | 'stopping'>('idle'),
    [message, setMessage] = useState(''),
    [interim, setInterim] = useState('');
  const recognition = useRef<ReturnType<typeof captureSpeech> | null>(null),
    callback = useRef(onText);
  callback.current = onText;
  const browser = window as Window & {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  const Constructor = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
  useEffect(() => () => recognition.current?.cancel(), []);
  useEffect(() => {
    if (!disabled || !recognition.current) return;
    recognition.current.cancel();
    recognition.current = null;
    setPhase('idle');
    setInterim('');
  }, [disabled]);
  function toggle() {
    if (recognition.current) {
      setPhase('stopping');
      recognition.current.stop();
      return;
    }
    if (!Constructor || !window.isSecureContext) {
      setMessage('此浏览器暂不支持语音识别，请使用安卓键盘的麦克风输入。远程网页需要 HTTPS。');
      return;
    }
    try {
      const session = captureSpeech(new Constructor(), speechLocale(), {
        preview: setInterim,
        completed({ text, usedInterim, error }) {
          recognition.current = null;
          setPhase('idle');
          setInterim('');
          if (text) {
            callback.current(text);
            if (usedInterim) setMessage('已将临时识别结果填入草稿，请核对文字。');
          } else if (error === 'not-allowed' || error === 'service-not-allowed') {
            setMessage('未获得麦克风权限，可在浏览器设置中允许，或使用键盘语音。');
          } else if (error === 'network') {
            setMessage('语音服务网络不可用，请使用键盘语音。');
          } else if (error === 'start-failed') {
            setMessage('语音识别无法启动，请使用键盘语音。');
          } else if (error && error !== 'no-speech') {
            setMessage('未能完成识别，请重试或使用键盘语音。');
          } else {
            setMessage('没有识别到文字，请重试或使用键盘语音。');
          }
        },
      });
      recognition.current = session;
      setPhase('listening');
      setMessage('');
      session.start();
    } catch {
      setMessage('语音识别无法启动，请使用键盘语音。');
    }
  }
  const active = phase !== 'idle';
  const label = phase === 'stopping' ? '正在结束识别…' : active ? '结束识别' : '语音输入';
  return (
    <>
      <div className="speech-input">
        <button
          type="button"
          className={'voice-button ' + (active ? 'listening' : '')}
          title={t(label)}
          onClick={toggle}
          disabled={disabled || phase === 'stopping'}
          aria-pressed={active}
        >
          {active ? <Square size={14} /> : <Mic size={15} />}
          <span className="sr-only">{t(label)}</span>
        </button>
      </div>
      {(active || message || !Constructor) && (
        <span className="voice-status" role="status">
          {phase === 'stopping'
            ? t(label)
            : t(message) || interim || t(Constructor ? '正在听…识别结果仅填入草稿' : '可使用键盘语音')}
        </span>
      )}
    </>
  );
}
export function MessageComposer({
  host,
  chat,
  ready,
  connected,
  queue,
  onError,
  onStop,
  onSend,
}: {
  host: HostInfo;
  chat: Chat;
  ready: boolean;
  connected: boolean;
  queue: QueuedMessage[];
  onError: (error: string) => void;
  onStop: () => Promise<void>;
  onSend: () => void;
}) {
  const key = `draft:${host.id}:${chat.id}`;
  const [draft, setDraft] = useState(() => loadDraft(key)),
    [intent, setIntent] = useState<Delivery | 'draft'>('queue'),
    [sending, setSending] = useState(false),
    [note, setNote] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const active = ['running', 'waiting_approval', 'waiting_input', 'stopping'].includes(chat.status);
  const canSteer = active && !!chat.turnId && chat.status !== 'stopping';
  // Persist synchronously before network I/O as well as on edits: closing the page
  // while a send is in flight must not turn an uncertain operation into a clean draft.
  const currentDraft = useRef(draft);
  function update(next: Draft | ((old: Draft) => Draft)) {
    const value = typeof next === 'function' ? next(currentDraft.current) : next;
    currentDraft.current = value;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
    setDraft(value);
  }
  useEffect(() => {
    if (!connected) update((d) => (d.text ? { ...d, unsent: true } : d));
  }, [connected]);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.text.trim() || sending) return;
    if (intent === 'draft' || !connected) {
      update({ ...draft, unsent: true });
      setNote(
        connected
          ? '草稿已保存在此浏览器，未发送到主机。'
          : '离线消息已保存为未发送，恢复连接后请确认发送。',
      );
      return;
    }
    if (!ready || (intent === 'steer' && !canSteer) || (draft.uncertain && !confirmed)) return;
    const text = draft.text;
    onSend();
    setSending(true);
    setNote('');
    // Browser localStorage is written directly before handing the command to fetch.
    const pending = { ...draft, unsent: true, uncertain: true };
    update(pending);
    try {
      await api(`/chats/${chat.id}/messages`, {
        text,
        operationId: operation(),
        delivery: intent,
        expectedTurnId: intent === 'steer' ? chat.turnId : undefined,
      });
      update(emptyDraft());
      setConfirmed(false);
    } catch (e) {
      const uncertain = !(e instanceof ApiError && e.status >= 400 && e.status < 500);
      update({ ...draft, unsent: true, uncertain });
      onError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function cancel(id: string) {
    try {
      await api(`/queue/${id}/cancel`, { operationId: operation() });
    } catch (e) {
      onError((e as Error).message);
    }
  }
  return (
    <div className="composer-wrap">
      {queue.length > 0 && (
        <details className="queued-messages">
          <summary>
            <Clock size={14} />
            {t('稍后发送 · {0} 条', { 0: queue.length })}
          </summary>
          {queue.map((q) => (
            <div className="queued-row" key={q.id}>
              <p>{q.text}</p>
              <button type="button" onClick={() => cancel(q.id)} aria-label={t('取消排队消息')}>
                <X size={15} />
                {t('取消')}
              </button>
            </div>
          ))}
        </details>
      )}
      <form className="composer" onSubmit={send}>
        <label className="sr-only" htmlFor="message">
          {t('发送给 Codex')}
        </label>
        <textarea
          id="message"
          value={draft.text}
          maxLength={30000}
          disabled={sending}
          placeholder={active ? t('写好下一条指令，选择何时发送…') : t('让 Codex 做些什么…')}
          onChange={(e) => {
            update({ ...draft, text: e.target.value, unsent: draft.unsent || !connected });
            setNote('');
            setConfirmed(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void send(e);
            }
          }}
        />
        {draft.text && (draft.unsent || draft.uncertain) && (
          <div className="unsent-notice" role="status">
            {draft.uncertain
              ? t('上次发送结果待确认，请先核对聊天记录，避免重复执行。')
              : connected
                ? t('未发送 · 请确认内容和发送方式，再手动发送。')
                : t('未发送 · 消息保存在此浏览器，重连后不会自动发送。')}
            {draft.uncertain && (
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                {t('已核对记录，仍需发送这条消息')}
              </label>
            )}
          </div>
        )}
        <div className={'composer-toolbar' + (keyboardDictationOnly ? ' keyboard-dictation' : '')}>
          <div className="delivery-row">
            <label>
              <span className="sr-only">{t('消息发送方式')}</span>
              <select
                aria-label={t('消息发送方式')}
                value={intent}
                onChange={(e) => setIntent(e.target.value as Delivery | 'draft')}
                disabled={sending}
              >
                <option value="queue">{active ? t('完成后发送') : t('发送新任务')}</option>
                <option value="steer" disabled={!canSteer}>
                  {t('现在补充 · 当前任务')}
                </option>
                <option value="draft">{t('仅保存草稿')}</option>
              </select>
            </label>
            {['running', 'queued', 'waiting_approval', 'waiting_input', 'stopping'].includes(
              chat.status,
            ) && (
              <button
                type="button"
                className="stop-button"
                onClick={onStop}
                disabled={chat.status === 'stopping'}
              >
                <Square size={12} />
                {chat.status === 'stopping' ? t('正在停止') : t('停止')}
              </button>
            )}
          </div>

          {!keyboardDictationOnly && (
            <SpeechInput
              disabled={sending}
              onText={(text) =>
                update((d) => ({
                  ...d,
                  text: (d.text + (d.text ? ' ' : '') + text).slice(0, 30000),
                  unsent: true,
                }))
              }
            />
          )}
          <button
            className="send-intent"
            disabled={
              !draft.text.trim() ||
              sending ||
              (intent !== 'draft' &&
                connected &&
                (!ready || (intent === 'steer' && !canSteer) || (draft.uncertain && !confirmed)))
            }
          >
            {intent === 'draft' || !connected ? <FileText size={15} /> : <ArrowUp size={16} />}
            {sending
              ? t('提交中…')
              : intent === 'draft'
                ? t('保存草稿')
                : !connected
                  ? t('保存未发送')
                  : draft.unsent
                    ? t('确认发送')
                    : intent === 'steer'
                      ? t('现在补充')
                      : active
                        ? t('加入队列')
                        : t('发送')}
          </button>
        </div>
      </form>
      <div className="composer-note" role="status">
        {t(note) ||
          (intent === 'draft'
            ? t('草稿只保存在此浏览器')
            : intent === 'steer'
              ? t('追加到当前轮次，不会自动改为排队')
              : active
                ? t('本轮成功完成后自动发送；停止或失败会取消排队')
                : t(chat.control === 'desktop' ? '发送到当前桌面聊天' : '相同工作目录按顺序执行'))}
      </div>
    </div>
  );
}
export function OrganizePanel({ chat, onDone }: { chat: Chat; onDone: () => void }) {
  const [title, setTitle] = useState(chat.title),
    [pinned, setPinned] = useState(!!chat.pinned),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api(`/chats/${chat.id}/update`, { operationId: operation(), title, pinned });
          onDone();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        {t('聊天名称')}
        <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} />
      </label>
      <label className="checkbox-label">
        <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
        <Pin size={15} />
        {t('置顶此聊天')}
      </label>
      {error && (
        <p className="form-error" role="alert">
          {t(error)}
        </p>
      )}
      <button className="primary" disabled={busy}>
        <Check size={15} />
        {busy ? t('保存中…') : t('保存')}
      </button>
    </form>
  );
}
export function PendingPanel({
  snapshot,
  onSelect,
}: {
  snapshot: Snapshot | null;
  onSelect: (id: string) => void;
}) {
  const [error, setError] = useState('');
  const requests = snapshot?.requests ?? [],
    queue = snapshot?.queue ?? [];
  return (
    <>
      <p className="modal-description">
        {snapshot?.host.name} {t('· 仅显示此主机的待处理事项。')}
      </p>
      <h3 className="pending-heading">
        {t('等我处理 ·')} {requests.length}
      </h3>
      {!requests.length && <p className="empty-note">{t('暂时没有需要审批或回答的请求。')}</p>}
      <div className="pending-list">
        {requests.map((r) => (
          <button key={r.id} onClick={() => onSelect(r.chatId)}>
            <strong>
              {r.kind === 'approval' ? t('审批') : t('回答')} ·{' '}
              {snapshot?.chats.find((c) => c.id === r.chatId)?.title}
            </strong>
            <span>{r.prompt}</span>
            <small>{snapshot?.chats.find((c) => c.id === r.chatId)?.cwd}</small>
          </button>
        ))}
      </div>
      <h3 className="pending-heading">
        {t('稍后发送 ·')} {queue.length}
      </h3>
      {!queue.length && <p className="empty-note">{t('没有排队的消息。')}</p>}
      {queue.map((q) => (
        <div className="pending-queue" key={q.id}>
          <button onClick={() => onSelect(q.chatId)}>
            <strong>{snapshot?.chats.find((c) => c.id === q.chatId)?.title}</strong>
            <span>{q.text}</span>
          </button>
          <button
            onClick={async () => {
              try {
                await api(`/queue/${q.id}/cancel`, { operationId: operation() });
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            {t('取消')}
          </button>
        </div>
      ))}
      {error && (
        <p className="form-error" role="alert">
          {t(error)}
        </p>
      )}
    </>
  );
}
function duration(mins: number | null) {
  if (mins === null) return t('额度窗口');
  if (mins % 1440 === 0)
    return t(getLocale() === 'en' && mins === 1440 ? '{0} 天（单数）' : '{0} 天', {
      0: mins / 1440,
    });
  if (mins % 60 === 0)
    return t(getLocale() === 'en' && mins === 60 ? '{0} 小时（单数）' : '{0} 小时', {
      0: mins / 60,
    });
  return t(getLocale() === 'en' && mins === 1 ? '{0} 分钟（单数）' : '{0} 分钟', { 0: mins });
}
export function UsagePanel({ usage, host }: { usage?: AccountUsage; host: HostInfo | null }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function refresh() {
    setBusy(true);
    setError('');
    try {
      await api('/usage');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <>
      <p className="modal-description">
        {host?.name} · {usage?.accountType ?? t('账号类型尚未返回')}
        {usage?.plan ? ' · ' + usage.plan : ''}
      </p>
      {(usage?.buckets ?? []).map((b, i) => (
        <section className="usage-bucket" key={b.id + i}>
          <h3>
            {b.name}
            {b.plan ? ' · ' + b.plan : ''}
          </h3>
          {!b.windows.length && <p>{t('此额度未返回使用比例。')}</p>}
          {b.windows.map((w, index) => (
            <div className="usage-window" key={index}>
              <div>
                <span>{duration(w.durationMins)}</span>
                <strong>
                  {t('已用')} {w.usedPercent}%
                </strong>
              </div>
              <progress
                aria-label={t('{0} {1}已用比例', { 0: b.name, 1: duration(w.durationMins) })}
                value={w.usedPercent}
                max={100}
              />
              <p>
                {w.resetsAt === null
                  ? t('重置时间未返回')
                  : t('重置于 ') + new Date(w.resetsAt * 1000).toLocaleString(getLocale())}
              </p>
            </div>
          ))}
        </section>
      ))}
      {!usage?.buckets.length && (
        <p className="empty-note">
          {busy
            ? t('正在读取主机账号额度…')
            : t('当前账号没有可显示的额度数据。API Key 或自定义供应商可能不返回此信息。')}
        </p>
      )}
      {(usage?.error || error) && (
        <p className="form-error" role="status">
          {t(error || usage?.error || '')}
        </p>
      )}
      <p className="form-note">
        {t('数据来自此主机 Codex 的账号接口，不估算剩余消息数。时间按此设备时区显示。')}
        {usage?.updatedAt
          ? t(' 更新于 ') + new Date(usage.updatedAt).toLocaleString(getLocale())
          : ''}
      </p>
      <button className="primary" disabled={busy} onClick={refresh}>
        {busy ? t('正在刷新…') : t('刷新额度')}
      </button>
    </>
  );
}
