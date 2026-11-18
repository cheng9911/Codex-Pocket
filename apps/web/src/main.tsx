import { t, useLocale, getLocale, setLocale, type Locale } from './i18n.ts';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  Plus,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Square,
  Terminal,
  X,
  Pin,
  ListTodo,
  Pencil,
  Bookmark,
  RefreshCw,
} from 'lucide-react';
import '@fontsource/ibm-plex-mono/latin-400.css';
import type {
  Chat,
  Entry,
  PendingRequest,
  SavedHost,
  Snapshot,
  HostInfo,
} from '../../../packages/types.ts';
import { api, operation } from './api.ts';
import './style.css';
import { MessageComposer, UsagePanel, PendingPanel, OrganizePanel } from './features.tsx';

const statusNames: Record<string, string> = {
  history: '历史查看',
  idle: '就绪',
  running: '运行中',
  queued: '排队中',
  waiting_approval: '等待审批',
  waiting_input: '等待回答',
  stopping: '正在停止',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
};
const busy = (c?: Chat) =>
  !!c && ['running', 'waiting_approval', 'waiting_input', 'stopping', 'queued'].includes(c.status);
function read<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
function hostUrl(raw: string) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
    throw new Error('请输入不带账号信息的 HTTP 或 HTTPS 地址');
  if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
    throw new Error('远程主机请使用 HTTPS 地址');
  return u.origin;
}
function initialHosts(): SavedHost[] {
  let hosts = read<SavedHost[]>('pocket:hosts', []);
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.has('hosts')) {
    try {
      const imported = JSON.parse(hash.get('hosts')!);
      if (Array.isArray(imported) && imported.length <= 30)
        hosts = imported.map((h) => ({
          name: String(h.name).slice(0, 80),
          url: hostUrl(String(h.url)),
        }));
    } catch {}
    history.replaceState(null, '', location.pathname);
  }
  save('pocket:hosts', hosts);
  return hosts;
}
const bootHosts = initialHosts();
function Mark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m8 5-6 7 6 7M16 5l6 7-6 7M14 3l-4 18"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function Badge({ chat }: { chat: Chat }) {
  return (
    <span className={'status ' + chat.status}>
      <i />
      {t(statusNames[chat.status])}
    </span>
  );
}
function App() {
  useLocale();
  const [host, setHost] = useState<HostInfo | null>(null),
    [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [paired, setPaired] = useState<boolean | null>(null),
    [connection, setConnection] = useState('连接中');
  const [error, setError] = useState(''),
    [selected, setSelected] = useState<string | null>(() =>
      new URLSearchParams(location.search).get('chat'),
    );
  const [entries, setEntries] = useState<Entry[]>([]),
    [hasMore, setHasMore] = useState(false),
    [loading, setLoading] = useState(false);
  const [nativeCursor, setNativeCursor] = useState<string | null>(null);
  const [historyReadAt, setHistoryReadAt] = useState<number | null>(null);
  const [catalogCursor, setCatalogCursor] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [changingControl, setChangingControl] = useState(false);
  const catalogBusy = useRef(false);
  const [hosts, setHosts] = useState(bootHosts),
    [panel, setPanel] = useState<
      'hosts' | 'new' | 'settings' | 'pending' | 'usage' | 'organize' | null
    >(null);
  const [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all'),
    [sending, setSending] = useState(false);
  const [code, setCode] = useState(''),
    [label, setLabel] = useState(t('我的浏览器'));
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const passwordMode = host?.authMode === 'password';
  const selectedRef = useRef(selected),
    cursor = useRef(0),
    generation = useRef(0),
    scroller = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    socket = useRef<WebSocket | null>(null);
  const entryGeneration = useRef(0),
    [newOutput, setNewOutput] = useState(false);
  const liveEntries = useRef(new Map<string, { seq: number; entry: Entry }>()),
    modalRef = useRef<HTMLElement>(null);
  selectedRef.current = selected;
  const chat = snapshot?.chats.find((c) => c.id === selected);
  const pending = snapshot?.requests.filter((r) => r.chatId === selected) ?? [];
  function storeHosts(next: SavedHost[]) {
    setHosts(next);
    save('pocket:hosts', next);
  }
  useEffect(() => {
    api<HostInfo>('/host')
      .then(setHost)
      .catch((e) => setError(e.message));
    api<Snapshot>('/snapshot')
      .then((s) => {
        setSnapshot(s);
        setPaired(true);
        cursor.current = s.cursor;
      })
      .catch((e) => {
        setPaired(false);
        if (e.status !== 401) setError(e.message);
      });
  }, []);
  useEffect(() => {
    if (!host) return;
    const current = { name: host.name, url: location.origin };
    if (!hosts.some((h) => h.url === current.url)) storeHosts([...hosts, current]);
  }, [host]);
  async function discoverLocal(next?: string) {
    if (catalogBusy.current) return;
    catalogBusy.current = true;
    setCatalogLoading(true);
    setCatalogError('');
    try {
      const result = await api<{ nextCursor: string | null }>(
        `/local-chats${next ? '?cursor=' + encodeURIComponent(next) : ''}`,
      );
      setCatalogCursor(result.nextCursor);
      const snapshot = await api<Snapshot>('/snapshot');
      if (snapshot.cursor >= cursor.current) setSnapshot(snapshot);
    } catch (e) {
      setCatalogError((e as Error).message);
    } finally {
      catalogBusy.current = false;
      setCatalogLoading(false);
    }
  }
  useEffect(() => {
    if (paired && snapshot?.ready) void discoverLocal();
  }, [paired, snapshot?.ready]);
  async function changeControl(
    action: 'continue' | 'release' | 'desktop-connect' | 'desktop-disconnect',
  ) {
    if (!chat || changingControl) return;
    setChangingControl(true);
    try {
      const updated = await api<Chat>(`/chats/${encodeURIComponent(chat.id)}/${action}`, {
        operationId: operation(),
      });
      setSnapshot((s) =>
        s ? { ...s, chats: s.chats.map((c) => (c.id === updated.id ? updated : c)) } : s,
      );
      await loadEntries(updated.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChangingControl(false);
    }
  }
  async function loadEntries(id: string, before?: number | string, refresh = false) {
    const gen = ++entryGeneration.current;
    if (!refresh) setLoading(true);
    try {
      const result = await api<{
        entries: Entry[];
        hasMore: boolean;
        cursor: number;
        nextCursor?: string | null;
        readAt?: number;
      }>(
        `/chats/${encodeURIComponent(id)}/entries${before !== undefined ? (typeof before === 'string' ? '?nativeCursor=' + encodeURIComponent(before) : '?before=' + before) : ''}`,
      );
      if (selectedRef.current === id && entryGeneration.current === gen) {
        setEntries((old) => {
          let next = before
            ? [...result.entries, ...old.filter((e) => !result.entries.some((n) => n.id === e.id))]
            : refresh
              ? [
                  ...old.filter((e) => !result.entries.some((n) => n.id === e.id)),
                  ...result.entries,
                ]
              : result.entries;
          for (const { seq, entry } of liveEntries.current.values())
            if (entry.chatId === id && seq > result.cursor) {
              const index = next.findIndex((e) => e.id === entry.id);
              if (index < 0) next = [...next, entry];
              else next = next.map((e) => (e.id === entry.id ? { ...e, ...entry } : e));
            }
          return next;
        });
        if (!refresh) {
          setHasMore(result.hasMore);
          setNativeCursor(result.nextCursor ?? null);
        }
        setHistoryReadAt(result.readAt ?? null);
      }
    } catch (e) {
      if (selectedRef.current === id && entryGeneration.current === gen)
        setError((e as Error).message);
    } finally {
      if (entryGeneration.current === gen) setLoading(false);
    }
  }
  useEffect(() => {
    if (!host) return;
    setEntries([]);
    setNativeCursor(null);
    setHasMore(false);
    setHistoryReadAt(null);
    liveEntries.current.clear();
    follow.current = true;
    setNewOutput(false);
    if (selected && paired) void loadEntries(selected);
    const u = new URL(location.href);
    selected ? u.searchParams.set('chat', selected) : u.searchParams.delete('chat');
    history.replaceState(null, '', u);
  }, [selected, host?.id, paired]);
  useEffect(() => {
    if (!paired || !selected || chat?.source !== 'codex' || !snapshot?.ready) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !loading)
        void loadEntries(selected, undefined, true);
    }, 5000);
    return () => clearInterval(timer);
  }, [paired, selected, chat?.source, snapshot?.ready, loading]);
  useEffect(() => {
    if (paired) api('/usage').catch(() => {});
  }, [paired]);
  useEffect(() => {
    if (!paired) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>,
      attempt = 0;
    const gen = ++generation.current;
    const connect = () => {
      if (stopped) return;
      setConnection('连接中');
      const url = new URL('/api/events', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('after', String(cursor.current));
      const ws = new WebSocket(url);
      socket.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnection('实时连接');
      };
      ws.onmessage = (event) => {
        if (gen !== generation.current) return;
        const data = JSON.parse(event.data);
        if (data.type === 'snapshot') {
          setSnapshot(data.data);
          cursor.current = data.data.cursor;
          if (selectedRef.current) void loadEntries(selectedRef.current);
        } else if (data.type === 'event') {
          const e = data.event;
          cursor.current = Math.max(cursor.current, e.seq);
          if (e.type === 'chat')
            setSnapshot((s) =>
              s
                ? {
                    ...s,
                    chats: [e.data, ...s.chats.filter((c) => c.id !== e.data.id)].sort(
                      (a, b) => b.updatedAt - a.updatedAt,
                    ),
                  }
                : s,
            );
          else if (e.type === 'request')
            setSnapshot((s) =>
              s
                ? {
                    ...s,
                    requests: [
                      ...s.requests.filter((r) => r.id !== e.data.id),
                      ...(e.data.status === 'pending' ? [e.data] : []),
                    ],
                  }
                : s,
            );
          else if (['queue', 'favorites', 'usage'].includes(e.type))
            setSnapshot((s) => (s ? { ...s, [e.type]: e.data } : s));
          else if (e.type === 'entry' && e.chatId === selectedRef.current) {
            liveEntries.current.set(e.data.id, { seq: e.seq, entry: e.data });
            setEntries((old) => {
              const index = old.findIndex((v) => v.id === e.data.id);
              return index >= 0
                ? old.map((v) => (v.id === e.data.id ? { ...v, ...e.data } : v))
                : [...old, e.data];
            });
            if (!follow.current) setNewOutput(true);
          }
        }
      };
      ws.onclose = async (e) => {
        if (stopped) return;
        const expired = async () => {
          setPaired(false);
          setSnapshot(null);
          setError('设备授权已撤销或过期，请重新登录');
          try {
            const h = await api<HostInfo>('/host');
            setHost(h);
          } catch {}
        };
        if (e.code === 4001) {
          await expired();
          return;
        }
        setConnection('连接已断开');
        // Reconnect independently: a slow auth probe must not leave the UI online
        // or prevent recovery when the phone switches networks.
        timer = setTimeout(connect, Math.min(15000, 500 * 2 ** attempt++) + Math.random() * 300);
        try {
          await api('/snapshot');
        } catch (error) {
          if (stopped) return;
          if ((error as { status?: number }).status === 401) await expired();
        }
      };
      ws.onerror = () => ws.close();
    };
    connect();
    const foreground = () => {
      if (document.visibilityState === 'visible') {
        socket.current?.close();
      }
    };
    document.addEventListener('visibilitychange', foreground);
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket.current?.close();
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [paired]);
  useEffect(() => {
    if (follow.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [entries, pending.length, selected]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (follow.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [selected, paired]);
  useEffect(() => {
    if (!panel) return;
    const previous = document.activeElement as HTMLElement;
    const el = modalRef.current;
    (
      el?.querySelector<HTMLElement>('input,select') ?? el?.querySelector<HTMLElement>('button')
    )?.focus();
    return () => previous?.focus();
  }, [panel]);
  async function authenticate(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError('');
    try {
      if (passwordMode) await api('/login', { password, label, remember });
      else await api('/pair', { code: code.trim(), label });
      setCode('');
      setSnapshot(await api('/snapshot'));
      setPaired(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPassword('');
      setSending(false);
    }
  }
  async function stop() {
    if (!selected) return;
    try {
      await api(`/chats/${selected}/stop`, {
        operationId: operation(),
        expectedTurnId: chat?.turnId ?? undefined,
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const openHost = (target: SavedHost) => {
    const url = new URL(target.url);
    url.hash = new URLSearchParams({ hosts: JSON.stringify(hosts) }).toString();
    location.assign(url);
  };
  const filtered = (snapshot?.chats ?? [])
    .filter(
      (c) =>
        (c.title + ' ' + c.cwd).toLowerCase().includes(search.toLowerCase()) &&
        (filter === 'all' ||
          (filter === 'running' && ['running', 'queued', 'stopping'].includes(c.status)) ||
          (filter === 'waiting' && ['waiting_approval', 'waiting_input'].includes(c.status)) ||
          (filter === 'ended' && ['completed', 'failed', 'interrupted'].includes(c.status))),
    )
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
  const needsDecision = (c: Chat) =>
    c.status === 'waiting_approval' || c.status === 'waiting_input';
  const groups = [
    { name: t('已置顶'), chats: filtered.filter((c) => c.pinned) },
    { name: t('等我处理'), chats: filtered.filter((c) => !c.pinned && needsDecision(c)) },
    { name: t('最近聊天'), chats: filtered.filter((c) => !c.pinned && !needsDecision(c)) },
  ];
  const decisions = snapshot?.requests.length ?? 0;
  const waiting = (snapshot?.requests.length ?? 0) + (snapshot?.queue?.length ?? 0);
  const connectionText =
    paired === false ? t(passwordMode ? '等待登录' : '等待配对') : t(connection);
  return (
    <div className={'app ' + (selected ? 'has-selection' : '')}>
      <aside className="sidebar">
        <div className="brand">
          <Mark />
          <span>Codex Pocket</span>
          <button
            className="compose-shortcut"
            aria-label={t('新建聊天')}
            title={t('新建聊天')}
            disabled={!paired || !snapshot?.ready}
            onClick={() => setPanel('new')}
          >
            <Plus size={18} />
          </button>
        </div>
        <button className="host-switch" onClick={() => setPanel('hosts')}>
          <Server size={17} />
          <span>
            {host?.name ?? t('连接主机')}
            <small>
              {host?.id.slice(0, 8)} · {connectionText}
            </small>
          </span>
          <ChevronDown size={15} />
        </button>
        <button
          className={'task-inbox' + (decisions ? ' needs-attention' : '')}
          onClick={() => setPanel('pending')}
          disabled={!paired}
        >
          <ListTodo size={18} />
          <span>{t('待处理列表')}</span>
          <b>{waiting}</b>
          <ChevronRight size={15} />
        </button>
        <div className="search">
          <Search size={15} />
          <input
            aria-label={t('搜索聊天')}
            placeholder={t('搜索聊天')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="inbox-filters" role="group" aria-label={t('状态筛选')}>
          {Object.entries({
            all: t('全部'),
            running: t('运行中'),
            waiting: t('等我处理'),
            ended: t('已结束'),
          }).map(([key, label]) => (
            <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>
              {label}
            </button>
          ))}
        </div>
        {paired && (
          <div className="local-list-tools">
            <span>{t('本机已有聊天')}</span>
            <button
              className="icon-button"
              aria-label={t('刷新本机聊天')}
              title={t('刷新本机聊天')}
              disabled={catalogLoading || !snapshot?.ready}
              onClick={() => void discoverLocal()}
            >
              <RefreshCw size={15} />
            </button>
          </div>
        )}
        {catalogError && (
          <div className="local-list-error" role="status">
            {t(catalogError)}
          </div>
        )}
        <nav className="chat-list" aria-label={t('聊天列表')}>
          {groups
            .filter((g) => g.chats.length)
            .map((g) => (
              <section className="inbox-group" key={g.name}>
                <h2>
                  {g.name}
                  <span>{g.chats.length}</span>
                </h2>
                {g.chats.map((c) => (
                  <button
                    className={'chat-row ' + (selected === c.id ? 'selected' : '')}
                    key={c.id}
                    onClick={() => setSelected(c.id)}
                  >
                    <div className="chat-row-heading">
                      <div className="row-title">
                        {c.pinned && <Pin size={12} aria-label={t('已置顶')} />}
                        {c.title}
                      </div>
                      <time dateTime={new Date(c.updatedAt).toISOString()}>
                        {new Date(c.updatedAt).toDateString() === new Date().toDateString()
                          ? new Date(c.updatedAt).toLocaleTimeString(getLocale(), {
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : new Date(c.updatedAt).toLocaleDateString(getLocale(), {
                              month: 'numeric',
                              day: 'numeric',
                            })}
                      </time>
                    </div>
                    <div className="row-meta">
                      <span>{c.cwd.split('/').pop()}</span>
                      <Badge chat={c} />
                    </div>
                  </button>
                ))}
              </section>
            ))}
          {paired && !filtered.length && (
            <div className="list-empty">
              {search || filter !== 'all'
                ? t('没有符合当前搜索和状态条件的聊天。')
                : catalogLoading
                  ? t('正在读取本机聊天…')
                  : t('还没有聊天。选择工作目录，开始第一个任务。')}
            </div>
          )}
          {catalogCursor && (
            <button
              className="load-more"
              disabled={catalogLoading}
              onClick={() => void discoverLocal(catalogCursor)}
            >
              {t(catalogLoading ? '正在加载…' : '加载更多本机聊天')}
            </button>
          )}
        </nav>
        {paired && (
          <button className="quota-link" onClick={() => setPanel('usage')}>
            <span>{t('账号额度')}</span>
            <span>
              {snapshot?.usage?.plan ?? snapshot?.usage?.accountType ?? t('查看状态')}
              <ChevronRight size={14} />
            </span>
          </button>
        )}
        <div className="sidebar-bottom">
          <span
            className={'connection-dot ' + (paired && connection === '实时连接' ? 'online' : '')}
          />
          <span>{connectionText}</span>
          <button
            className="icon-button"
            aria-label={t('设备与连接设置')}
            onClick={() => setPanel('settings')}
          >
            <Settings size={17} />
          </button>
        </div>
      </aside>
      <main className="main">
        <div className="host-identity" aria-label={t('当前主机')}>
          <button onClick={() => setPanel('hosts')}>
            <Server size={14} />
            <strong>{host?.name ?? t('正在连接主机')}</strong>
            <span>{host?.id.slice(0, 8)}</span>
            <ChevronDown size={13} />
          </button>
          <button
            onClick={() => setPanel('pending')}
            disabled={!paired}
            aria-label={t('待处理列表，{0} 项', { 0: waiting })}
          >
            <ListTodo size={15} />
            <span>
              {t('待处理')} {waiting}
            </span>
          </button>
        </div>
        <header className="chat-header">
          <button
            className="icon-button mobile-back"
            aria-label={t('返回聊天列表')}
            onClick={() => setSelected(null)}
          >
            <ArrowLeft size={20} />
          </button>
          <div className="header-title">
            <div className="title-line">
              <h1>{chat?.title ?? 'Codex Pocket'}</h1>
              {chat && (
                <button
                  className="icon-button"
                  aria-label={t('整理聊天')}
                  onClick={() => setPanel('organize')}
                >
                  <Pencil size={14} />
                </button>
              )}
            </div>
            <div className="header-meta">
              {chat ? (
                <>
                  <Folder size={13} />
                  <span title={chat.cwd}>{chat.cwd}</span>
                </>
              ) : (
                <span>{paired ? t('主机工作区') : t(passwordMode ? '主机登录' : '设备配对')}</span>
              )}
            </div>
          </div>
          {chat && <Badge chat={chat} />}
          <button
            className="icon-button mobile-host"
            aria-label={t('切换主机')}
            onClick={() => setPanel('hosts')}
          >
            <Server size={18} />
          </button>
        </header>

        {error && (
          <div className="error-banner" role="alert">
            <span>{t(error)}</span>
            <button
              className="icon-button"
              aria-label={t('关闭错误提示')}
              onClick={() => setError('')}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {paired && connection !== '实时连接' && (
          <div className="reconnect-banner" role="status">
            {t(connection)}
            {t('· 正在恢复显示，主机任务可能仍在继续。')}
          </div>
        )}
        {paired === false ? (
          <section className="pair-screen">
            <div className="pair-guide">
              <Mark />
              <h2>{t('连接到你的主机')}</h2>
              {passwordMode ? (
                <>
                  <p>{host?.name}</p>
                  <small>{t('输入此主机的固定密码，授权当前设备。')}</small>
                </>
              ) : (
                <>
                  <p>{t('在主机运行以下命令设置固定密码，然后重启服务。')}</p>
                  <div className="pair-command">
                    <Terminal size={18} />
                    <code>npm run password:set</code>
                  </div>
                  <small>{t('尚未设置密码时，仍可运行 npm run pair 使用一次性配对码。')}</small>
                </>
              )}
            </div>
            <form onSubmit={authenticate}>
              <label>
                {t(passwordMode ? '主机密码' : '一次性配对码')}
                {passwordMode ? (
                  <input
                    type="password"
                    name="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t('输入此主机密码')}
                  />
                ) : (
                  <input
                    autoComplete="off"
                    spellCheck={false}
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder={t('输入主机生成的配对码')}
                  />
                )}
              </label>
              <label>
                {t('设备名称')}
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  required
                  maxLength={80}
                />
              </label>
              {passwordMode && (
                <>
                  <label className="remember-device">
                    <input
                      type="checkbox"
                      checked={remember}
                      onChange={(e) => setRemember(e.target.checked)}
                    />
                    {t('记住此设备（30 天）')}
                  </label>
                  <p className="form-note">{t('不勾选时使用浏览器会话登录，最长 12 小时。')}</p>
                </>
              )}
              <button className="primary" disabled={sending || !host}>
                {sending
                  ? t(passwordMode ? '正在登录…' : '正在配对…')
                  : t(passwordMode ? '登录此主机' : '配对并连接')}
                <ArrowUp size={16} />
              </button>
            </form>
          </section>
        ) : paired === null ? (
          <div className="center-note">{t('正在连接主机…')}</div>
        ) : !chat ? (
          <section className="welcome">
            <h2>{t('主机工作区')}</h2>
            <p>
              {snapshot?.ready ? host?.name : t('Codex 暂未就绪，请在主机检查登录与服务日志。')}
            </p>
            <div className="workspace-counts">
              <div>
                <strong>{snapshot?.chats.length ?? 0}</strong>
                <span>{t('全部聊天')}</span>
              </div>
              <div>
                <strong>{snapshot?.chats.filter((c) => c.status === 'running').length ?? 0}</strong>
                <span>{t('运行中')}</span>
              </div>
              <button onClick={() => setPanel('pending')}>
                <strong>{waiting}</strong>
                <span>
                  {t('待处理')} <ChevronRight size={13} />
                </span>
              </button>
            </div>
            {snapshot?.error && <pre>{snapshot.error}</pre>}
            <button className="primary" onClick={() => setPanel('new')} disabled={!snapshot?.ready}>
              <Plus size={17} />
              {t('新建聊天')}
            </button>
            {!!snapshot?.chats.length && (
              <div className="recent-chats">
                <h3>{t('最近活动')}</h3>
                {snapshot.chats
                  .slice()
                  .sort((a, b) => b.updatedAt - a.updatedAt)
                  .slice(0, 3)
                  .map((c) => (
                    <button key={c.id} onClick={() => setSelected(c.id)}>
                      <span>
                        {c.title}
                        <small>{c.cwd}</small>
                      </span>
                      <Badge chat={c} />
                      <ChevronRight size={15} />
                    </button>
                  ))}
              </div>
            )}
          </section>
        ) : (
          <>
            <div
              className="message-scroll"
              ref={scroller}
              onScroll={(e) => {
                const el = e.currentTarget;
                follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
                if (follow.current) setNewOutput(false);
              }}
            >
              <div className="messages">
                {chat.source === 'codex' && (
                  <section className="local-history-note" aria-label={t('本机聊天状态')}>
                    <div>
                      <strong>
                        {t(
                          chat.control === 'desktop'
                            ? chat.desktopConnected
                              ? '桌面同步 · 已连接'
                              : '桌面同步 · 已断开'
                            : chat.control === 'pocket'
                              ? '由 Pocket 继续'
                              : '本机聊天 · 历史查看',
                        )}
                      </strong>
                      <button
                        className="icon-button"
                        aria-label={t('刷新历史')}
                        title={t('刷新历史')}
                        disabled={loading}
                        onClick={() => void loadEntries(chat.id, undefined, true)}
                      >
                        <RefreshCw size={15} />
                      </button>
                    </div>
                    <p>
                      {t(
                        chat.control === 'desktop'
                          ? '与桌面端控制同一个任务。关闭手机页面不会停止任务。'
                          : chat.control === 'pocket'
                            ? '当前任务由 Pocket 控制。结束后可释放聊天，再回桌面端继续。'
                            : '当前显示已保存的历史。连接桌面后可实时查看、发消息、审批和停止。',
                      )}
                    </p>
                    {historyReadAt && (
                      <small>
                        {t('读取于')} {new Date(historyReadAt).toLocaleTimeString(getLocale())}
                      </small>
                    )}
                    {chat.control === 'pocket' && (
                      <button
                        disabled={busy(chat) || changingControl}
                        onClick={() => void changeControl('release')}
                      >
                        {t('释放聊天，返回历史查看')}
                      </button>
                    )}
                    {chat.control === 'desktop' && (
                      <button
                        disabled={changingControl}
                        onClick={() => void changeControl('desktop-disconnect')}
                      >
                        {t('断开同步，任务留在桌面继续')}
                      </button>
                    )}
                  </section>
                )}
                {loading && !entries.length && <p role="status">{t('正在加载历史…')}</p>}
                {hasMore && (
                  <button
                    className="load-more"
                    onClick={() =>
                      loadEntries(
                        chat.id,
                        chat.source === 'codex' ? (nativeCursor ?? undefined) : entries[0]?.order,
                      )
                    }
                    disabled={loading}
                  >
                    {loading ? t('正在加载…') : t('加载更早的记录')}
                  </button>
                )}
                {!entries.length && !loading && (
                  <div className="chat-empty">
                    <Terminal size={23} />
                    <p>
                      {t(chat.source === 'codex' ? '此聊天暂无可显示的历史。' : '工作目录已就绪。')}
                    </p>
                    <span>{t('描述你希望 Codex 完成的任务。')}</span>
                  </div>
                )}
                <ChatEntries entries={entries} />
                {pending.map((request) => (
                  <RequestCard
                    key={request.id}
                    request={request}
                    host={host!}
                    chat={chat}
                    onError={setError}
                  />
                ))}
                {chat.error && (
                  <div className="task-error" role="status">
                    {chat.error}
                  </div>
                )}
              </div>
            </div>
            {newOutput && (
              <button
                className="new-output"
                onClick={() => {
                  follow.current = true;
                  setNewOutput(false);
                  scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
                }}
              >
                <ChevronDown size={15} />
                {t('查看最新输出')}
              </button>
            )}
            {chat.source === 'codex' &&
            chat.control !== 'pocket' &&
            !(chat.control === 'desktop' && chat.desktopConnected) ? (
              <section className="local-continue">
                <p>{t('保持 Codex 桌面端打开，可直接连接正在运行的聊天。')}</p>
                <button
                  className="primary"
                  disabled={
                    !snapshot?.ready ||
                    connection !== '实时连接' ||
                    changingControl ||
                    chat.acceptsInput === false
                  }
                  onClick={() => void changeControl('desktop-connect')}
                >
                  {t(changingControl ? '正在连接聊天…' : '连接桌面同步')}
                </button>
                {chat.control !== 'desktop' && (
                  <details>
                    <summary>{t('其他继续方式')}</summary>
                    <p>{t('仅当原端已释放聊天时，才使用 Pocket 独立执行。')}</p>
                    <button
                      disabled={!snapshot?.ready || changingControl || chat.acceptsInput === false}
                      onClick={() => void changeControl('continue')}
                    >
                      {t('在 Pocket 中继续')}
                    </button>
                  </details>
                )}
              </section>
            ) : (
              host && (
                <MessageComposer
                  key={`${host.id}:${chat.id}`}
                  host={host}
                  chat={chat}
                  ready={!!snapshot?.ready}
                  connected={connection === '实时连接'}
                  queue={(snapshot?.queue ?? []).filter((r) => r.chatId === chat.id)}
                  onError={setError}
                  onStop={stop}
                  onSend={() => {
                    follow.current = true;
                  }}
                />
              )
            )}
          </>
        )}
      </main>
      {panel && (
        <div
          className="modal-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPanel(null);
          }}
        >
          <section
            ref={modalRef}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setPanel(null);
              if (e.key === 'Tab') {
                const items = [
                  ...e.currentTarget.querySelectorAll<HTMLElement>(
                    'button:not(:disabled),input,select,textarea',
                  ),
                ];
                const first = items[0],
                  last = items.at(-1);
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last?.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            <header>
              <h2 id="modal-title">
                {
                  {
                    new: t('新建聊天'),
                    hosts: t('切换主机'),
                    settings: t('设备与连接'),
                    pending: t('待处理列表'),
                    usage: t('账号额度'),
                    organize: t('整理聊天'),
                  }[panel]
                }
              </h2>
              <button className="icon-button" aria-label={t('关闭')} onClick={() => setPanel(null)}>
                <X size={20} />
              </button>
            </header>
            {panel === 'new' ? (
              <NewChat
                onCreate={(c) => {
                  setSelected(c.id);
                  setPanel(null);
                }}
                favorites={snapshot?.favorites ?? []}
              />
            ) : panel === 'hosts' ? (
              <HostPanel
                hosts={hosts}
                current={location.origin}
                onHosts={storeHosts}
                onOpen={openHost}
              />
            ) : panel === 'pending' ? (
              <PendingPanel
                snapshot={snapshot}
                onSelect={(id) => {
                  follow.current = true;
                  setSelected(id);
                  setPanel(null);
                  requestAnimationFrame(() =>
                    scroller.current?.scrollTo({ top: scroller.current.scrollHeight }),
                  );
                }}
              />
            ) : panel === 'usage' ? (
              <UsagePanel usage={snapshot?.usage} host={host} />
            ) : panel === 'organize' && chat ? (
              <OrganizePanel chat={chat} onDone={() => setPanel(null)} />
            ) : (
              <SettingsPanel
                paired={paired === true}
                onLogout={() => {
                  setPaired(false);
                  setSnapshot(null);
                  setSelected(null);
                  setPanel(null);
                }}
              />
            )}
          </section>
        </div>
      )}
    </div>
  );
}
function ChatEntries({ entries }: { entries: Entry[] }) {
  const groups: Entry[][] = [];
  const isActivity = (e: Entry) =>
    ['tool', 'change', 'info'].includes(e.kind) && !['failed', 'error'].includes(e.status);
  for (const entry of entries) {
    if (entry.kind === 'info' && !entry.text) continue;
    const previous = groups.at(-1);
    if (
      isActivity(entry) &&
      previous &&
      isActivity(previous[0]) &&
      previous[0].turnId === entry.turnId
    )
      previous.push(entry);
    else groups.push([entry]);
  }
  return groups.map((group) =>
    isActivity(group[0]) ? (
      <details className="activity-group" key={group[0].id}>
        <summary>
          <Terminal size={15} />
          <span>{t('执行记录 · {0} 项', { 0: group.length })}</span>
          {group.some((e) => ['running', 'inProgress', 'in_progress'].includes(e.status)) && (
            <small>{t('执行中')}</small>
          )}
          <ChevronDown size={14} />
        </summary>
        <div className="activity-items">
          {group.map((entry) => (
            <EntryView key={entry.id} entry={entry} />
          ))}
        </div>
      </details>
    ) : (
      <EntryView key={group[0].id} entry={group[0]} />
    ),
  );
}
function EntryView({ entry }: { entry: Entry }) {
  if (entry.kind === 'info' && !entry.text) return null;
  if (entry.kind === 'tool' || entry.kind === 'change' || entry.kind === 'info')
    return (
      <details
        className="tool-entry"
        open={['failed', 'error'].includes(entry.status) ? true : undefined}
      >
        <summary>
          <Terminal size={15} />
          <span>{entry.kind === 'change' ? t('文件修改') : entry.title}</span>
          <small>
            {entry.status === 'completed'
              ? t('已完成')
              : entry.status === 'running'
                ? t('执行中')
                : entry.status}
          </small>
          <ChevronDown size={14} />
        </summary>
        {entry.text && <pre>{entry.text}</pre>}
      </details>
    );
  return (
    <article className={'message ' + entry.kind}>
      <div className="message-label">
        {entry.kind === 'user' ? t('你') : 'Codex'}
        <span>
          {entry.status === 'queued'
            ? t('等待执行')
            : entry.status === 'uncertain'
              ? t('发送结果待确认')
              : entry.status === 'steered'
                ? t('已补充到当前任务')
                : entry.status === 'sending'
                  ? t('正在确认发送')
                  : entry.status === 'cancelled'
                    ? t('已取消')
                    : ''}
        </span>
      </div>
      <div className="message-body">
        {entry.kind === 'user' ? (
          <p>{entry.text}</p>
        ) : (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              img: ({ alt }) => (
                <span>
                  {t('[图片：')}
                  {alt}]
                </span>
              ),
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              ),
            }}
          >
            {entry.text || '…'}
          </ReactMarkdown>
        )}
      </div>
    </article>
  );
}
function RequestCard({
  request,
  host,
  chat,
  onError,
}: {
  request: PendingRequest;
  host: HostInfo;
  chat: Chat;
  onError: (v: string) => void;
}) {
  const [busy, setBusy] = useState(false),
    [answers, setAnswers] = useState<Record<string, string>>({}),
    [scope, setScope] = useState('accept');
  const sessionAllowed =
    !Array.isArray(request.params.availableDecisions) ||
    request.params.availableDecisions.includes('acceptForSession');
  const isFiles = request.method === 'item/fileChange/requestApproval';
  const isPermissions = request.method === 'item/permissions/requestApproval';
  const declineDecision =
    Array.isArray(request.params.availableDecisions) &&
    !request.params.availableDecisions.includes('decline') &&
    request.params.availableDecisions.includes('cancel')
      ? 'cancel'
      : 'decline';
  const network = request.params.networkApprovalContext;
  let changes = request.params.changes;
  if (typeof changes === 'string') {
    try {
      changes = JSON.parse(changes);
    } catch {}
  }
  const paths = Array.isArray(changes)
    ? changes.map((c: any) => c.path).filter((p: any) => typeof p === 'string')
    : [];
  const command =
    typeof request.params.command === 'string' ? request.params.command : t('未提供命令预览');
  const actionTitle =
    request.kind === 'question'
      ? t('回答 Codex 的问题')
      : network
        ? t('审批网络访问')
        : isFiles
          ? t('审批文件修改')
          : isPermissions
            ? t('审批额外权限')
            : t('审批命令执行');
  const submit = async (decision?: string) => {
    setBusy(true);
    try {
      await api(`/requests/${request.id}/respond`, {
        operationId: operation(),
        decision,
        answers:
          request.kind === 'question'
            ? Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, [v]]))
            : undefined,
      });
    } catch (e) {
      onError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <section className="request-card">
      <div className="request-heading">
        <ShieldCheck size={18} />
        <strong>{actionTitle}</strong>
      </div>
      <dl className="approval-context">
        <div>
          <dt>{t('主机')}</dt>
          <dd>
            {host.name}
            <span>{host.id.slice(0, 8)}</span>
          </dd>
        </div>
        <div>
          <dt>{t('目录')}</dt>
          <dd>{request.params.cwd ?? chat.cwd}</dd>
        </div>
      </dl>
      <p className="request-reason">
        {request.params.reason ||
          (request.kind === 'question'
            ? request.prompt
            : t('Codex 未提供具体原因，请检查操作内容。'))}
      </p>
      {request.kind === 'approval' ? (
        <>
          {network ? (
            <p className="approval-action">
              {network.protocol ?? t('网络')}://{network.host ?? t('未知目标')}
              {network.port ? ':' + network.port : ''}
            </p>
          ) : (
            !isFiles &&
            !isPermissions && (
              <div>
                <pre className="command-preview" aria-label={t('准备执行的命令')}>
                  {command.slice(0, 500)}
                  {command.length > 500 ? '…' : ''}
                </pre>
                {command.length > 500 && (
                  <details className="approval-details">
                    <summary>{t('展开完整命令')}</summary>
                    <pre>{command}</pre>
                  </details>
                )}
              </div>
            )
          )}
          {isFiles && (
            <p className="approval-action">
              {request.params.grantRoot
                ? t('授权目录：{0}', { 0: request.params.grantRoot })
                : t('检查下方文件修改详情后再决定')}
            </p>
          )}
          {isFiles && paths.length > 0 && (
            <ul className="approval-paths">
              {paths.map((path: string, i: number) => (
                <li key={path + i}>{path}</li>
              ))}
            </ul>
          )}
          {(isFiles || isPermissions) && (
            <details className="approval-details">
              <summary>{isFiles ? t('查看文件变更') : t('查看权限明细')}</summary>
              <pre>
                {typeof request.params.changes === 'string'
                  ? request.params.changes
                  : JSON.stringify(
                      request.params.permissions ??
                        request.params.changes ?? { 提示: t('Codex 未返回变更详情') },
                      null,
                      2,
                    )}
              </pre>
            </details>
          )}
          <label className="approval-scope">
            {t('批准范围')}
            <select
              aria-label={t('批准范围')}
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              disabled={busy}
            >
              <option value="accept">{isPermissions ? t('当前轮次') : t('仅本次操作')}</option>
              {sessionAllowed && (
                <option value="acceptForSession">{t('此 Codex 会话的同类操作')}</option>
              )}
            </select>
          </label>
          <p className="scope-note">
            {scope === 'acceptForSession'
              ? t('会话授权由 Codex 缓存；同一审批范围内的后续操作可能不再询问，进程重启后不保留。')
              : isPermissions
                ? t('权限仅授予当前执行轮次。')
                : t('批准当前操作，后续请求仍需单独处理。')}
          </p>
          <div className="request-actions">
            <button disabled={busy} onClick={() => submit(declineDecision)}>
              {t('拒绝')}
            </button>
            <button className="primary" disabled={busy} onClick={() => submit(scope)}>
              <Check size={15} />
              {busy
                ? t('提交中…')
                : scope === 'acceptForSession'
                  ? t('允许此会话范围')
                  : isPermissions
                    ? t('允许当前轮次')
                    : t('允许本次')}
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {(request.params.questions ?? []).map((q: any) => (
            <div className="question-field" key={q.id}>
              <label htmlFor={request.id + q.id}>{q.question ?? q.header}</label>
              {q.options?.length > 0 && (
                <div className="question-options">
                  {q.options.map((o: any) => (
                    <button
                      type="button"
                      key={o.label}
                      className={answers[q.id] === o.label ? 'chosen' : ''}
                      onClick={() => setAnswers((a) => ({ ...a, [q.id]: o.label }))}
                    >
                      {o.label}
                      {o.description && <small>{o.description}</small>}
                    </button>
                  ))}
                </div>
              )}
              <input
                id={request.id + q.id}
                required
                value={answers[q.id] ?? ''}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                placeholder={t('输入回答')}
              />
            </div>
          ))}
          <button className="primary" disabled={busy}>
            {busy ? t('提交中…') : t('提交回答')}
          </button>
        </form>
      )}
    </section>
  );
}
function NewChat({ onCreate, favorites }: { onCreate: (c: Chat) => void; favorites: string[] }) {
  const [title, setTitle] = useState(''),
    [cwd, setCwd] = useState(''),
    [model, setModel] = useState(''),
    [models, setModels] = useState<Array<{ id: string; name: string }>>([]),
    [dirs, setDirs] = useState<Array<{ name: string; path: string }>>([]),
    [busy, setBusy] = useState(false),
    [formError, setFormError] = useState(''),
    [savedDirs, setSavedDirs] = useState(favorites);
  useEffect(() => {
    api('/config')
      .then((c) => {
        setCwd(c.roots[0] ?? '');
        setModels(c.models);
      })
      .catch((e) => setFormError(e.message));
    api('/directories')
      .then(setDirs)
      .catch((e) => setFormError(e.message));
  }, []);
  async function browse(path: string) {
    setCwd(path);
    try {
      setDirs(await api('/directories?path=' + encodeURIComponent(path)));
    } catch (e) {
      setFormError((e as Error).message);
    }
  }
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setFormError('');
        try {
          onCreate(
            await api('/chats', { operationId: operation(), title, cwd, model: model || null }),
          );
        } catch (e) {
          setFormError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        {t('聊天名称')}
        <input
          autoFocus
          placeholder={t('例如：修复登录问题')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
        />
      </label>
      <label>
        {t('主机工作目录')}
        <input value={cwd} onChange={(e) => setCwd(e.target.value)} required />
      </label>
      <div className="favorite-directories">
        <button
          type="button"
          disabled={!cwd}
          onClick={async () => {
            try {
              setSavedDirs(
                await api('/favorites', {
                  operationId: operation(),
                  path: cwd,
                  saved: !savedDirs.includes(cwd),
                }),
              );
            } catch (e) {
              setFormError((e as Error).message);
            }
          }}
        >
          <Bookmark size={15} />
          {savedDirs.includes(cwd) ? t('取消收藏当前目录') : t('收藏当前目录')}
        </button>
        {savedDirs.map((p) => (
          <div key={p}>
            <button type="button" onClick={() => browse(p)}>
              <Folder size={14} />
              <span>{p}</span>
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={t('取消收藏 {0}', { 0: p })}
              onClick={async () => {
                try {
                  setSavedDirs(
                    await api('/favorites', { operationId: operation(), path: p, saved: false }),
                  );
                } catch (e) {
                  setFormError((e as Error).message);
                }
              }}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
      <div className="directory-list">
        <button
          type="button"
          onClick={() =>
            api('/directories')
              .then(setDirs)
              .catch((e) => setFormError(e.message))
          }
        >
          {t('允许的项目目录')}
        </button>
        {dirs.map((d) => (
          <button type="button" key={d.path} onClick={() => browse(d.path)}>
            <Folder size={15} />
            <span>{d.name}</span>
            <ChevronRight size={14} />
          </button>
        ))}
      </div>
      <label>
        {t('模型')}
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">{t('使用 Codex 默认模型')}</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <div className="form-note">{t('任务在所选目录执行。相同目录的任务按顺序运行。')}</div>
      {formError && (
        <p role="alert" className="form-error">
          {t(formError)}
        </p>
      )}
      <button className="primary" disabled={busy || !cwd}>
        {busy ? t('正在创建…') : t('创建聊天')}
        <Plus size={16} />
      </button>
    </form>
  );
}
function HostPanel({
  hosts,
  current,
  onHosts,
  onOpen,
}: {
  hosts: SavedHost[];
  current: string;
  onHosts: (h: SavedHost[]) => void;
  onOpen: (h: SavedHost) => void;
}) {
  const [name, setName] = useState(''),
    [url, setUrl] = useState(''),
    [error, setError] = useState('');
  return (
    <>
      <p className="modal-description">
        {t('切换主机后任务继续运行。每台主机独立登录，已授权的设备可直接进入。')}
      </p>
      <div className="host-list">
        {hosts.map((h) => (
          <div key={h.url}>
            <button onClick={() => onOpen(h)}>
              <Server size={18} />
              <span>
                {h.name}
                <small>{h.url}</small>
              </span>
              {h.url === current ? (
                <span className="current-label">{t('当前')}</span>
              ) : (
                <ChevronRight size={17} />
              )}
            </button>
            {h.url !== current && (
              <button
                className="icon-button"
                aria-label={t('移除主机 ') + h.name}
                onClick={() => onHosts(hosts.filter((v) => v.url !== h.url))}
              >
                <X size={15} />
              </button>
            )}
          </div>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            const origin = hostUrl(url);
            onHosts([
              ...hosts.filter((h) => h.url !== origin),
              { name: name || new URL(origin).hostname, url: origin },
            ]);
            setName('');
            setUrl('');
            setError('');
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <label>
          {t('主机名称')}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('例如：家里的开发机')}
            maxLength={80}
          />
        </label>
        <label>
          {t('主机地址')}
          <input
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://devbox.tailnet.ts.net"
          />
        </label>
        {error && (
          <p role="alert" className="form-error">
            {t(error)}
          </p>
        )}
        <button className="primary">
          <Plus size={16} />
          {t('添加主机')}
        </button>
      </form>
      <p className="form-note">{t('列表只保存主机名称和地址，不包含登录凭据。')}</p>
    </>
  );
}
function SettingsPanel({ onLogout, paired }: { onLogout: () => void; paired: boolean }) {
  const locale = useLocale();
  const [sessions, setSessions] = useState<any[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    if (!paired) return;
    api('/sessions')
      .then(setSessions)
      .catch((e) => setError(e.message));
  }, [paired]);
  return (
    <>
      <section className="password-settings">
        <h3>{t('主机密码')}</h3>
        <p className="form-note">
          {t('在主机终端运行 npm run password:set 设置或修改密码，重启后旧设备需重新登录。')}
        </p>
      </section>
      <section className="language-settings">
        <label htmlFor="interface-language">{t('界面语言')}</label>
        <select
          id="interface-language"
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
        >
          <option value="zh-CN" lang="zh-CN">
            简体中文
          </option>
          <option value="en" lang="en">
            English
          </option>
        </select>
        <p className="form-note">{t('语言设置保存在此浏览器，聊天内容保持原文。')}</p>
      </section>
      {!paired ? (
        <p className="form-note">{t('请先登录主机以管理设备。')}</p>
      ) : (
        <>
          <p className="modal-description">{t('已授权的设备可以访问此主机上的 Codex 聊天。')}</p>
          <div className="session-list">
            {sessions.map((s) => (
              <div key={s.id}>
                <span>
                  {s.label}
                  <small>
                    {s.current ? t('当前设备 · ') : ''}
                    {t('授权于')} {new Date(s.createdAt).toLocaleDateString(getLocale())}
                    <br />
                    {t('到期时间')} {new Date(s.expiresAt).toLocaleString(getLocale())}
                  </small>
                </span>
                <button
                  onClick={async () => {
                    try {
                      await api(`/sessions/${s.id}/revoke`, {});
                      if (s.current) onLogout();
                      else setSessions((list) => list.filter((v) => v.id !== s.id));
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  {t('撤销')}
                </button>
              </div>
            ))}
          </div>
          {error && <p role="alert">{t(error)}</p>}
          <button
            className="logout"
            onClick={async () => {
              try {
                await api('/logout', {});
                onLogout();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            {t('退出此主机')}
          </button>
          <p className="form-note">{t('退出不会停止主机上的任务。')}</p>
        </>
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
