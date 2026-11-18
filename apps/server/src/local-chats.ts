import type { Chat, Entry } from '../../../packages/types.ts';
import type { AgentTransport } from './service.ts';
import { PocketError, Store } from './store.ts';

const textOf = (value: unknown): string =>
  typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
const time = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value * 1000 : fallback;
export const nativeEntryId = (chat: Chat, turnId: string, itemId: string) =>
  chat.source === 'codex' ? `${chat.id}:native:${turnId}:${itemId}` : `${chat.id}:${itemId}`;

export function historyEntry(chat: Chat, turn: any, item: any, index: number): Entry {
  const kind: Entry['kind'] =
    item.type === 'userMessage'
      ? 'user'
      : item.type === 'agentMessage'
        ? 'assistant'
        : item.type === 'fileChange'
          ? 'change'
          : ['reasoning', 'plan', 'contextCompaction'].includes(item.type)
            ? 'info'
            : 'tool';
  const text =
    item.type === 'userMessage'
      ? (item.content ?? [])
          .map(
            (part: any) =>
              part.text ??
              (['image', 'localImage'].includes(part.type) ? '[图片]' : `[${part.type ?? '附件'}]`),
          )
          .join('\n')
      : item.type === 'reasoning'
        ? (item.summary ?? []).map(textOf).join('\n')
        : textOf(
            item.text ?? item.aggregatedOutput ?? item.output ?? item.result ?? item.changes ?? '',
          );
  return {
    id: nativeEntryId(chat, turn.id, String(item.id ?? index)),
    chatId: chat.id,
    turnId: turn.id,
    kind,
    title:
      kind === 'user'
        ? '你'
        : kind === 'assistant'
          ? 'Codex'
          : (item.command ?? item.tool ?? item.type),
    text: text.length > 250000 ? '[较早输出已截断]\n' + text.slice(-240000) : text,
    status: item.status ?? turn.status,
    createdAt: time(turn.startedAt, chat.createdAt),
    command: item.command,
    cwd: item.cwd,
    changes: item.changes,
  };
}

/** Read-only discovery/history. Opening a chat must never resume a writer. */
export class LocalChats {
  private requests = new Map<string, Promise<any>>();
  private historyCache = new Map<string, { at: number; value: any }>();
  constructor(
    private store: Store,
    private agent: () => AgentTransport,
  ) {}
  private single<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.requests.get(key);
    if (previous) return previous;
    const promise = work().finally(() => this.requests.delete(key));
    this.requests.set(key, promise);
    return promise;
  }
  invalidate(id: string) {
    for (const key of this.historyCache.keys())
      if (key.startsWith(id + ':')) this.historyCache.delete(key);
  }
  async list(cursor?: string) {
    return this.single('list:' + (cursor ?? ''), async () => {
      const result = await this.agent().request('thread/list', {
        limit: 50,
        cursor,
        sortKey: 'updated_at',
        modelProviders: [],
        sourceKinds: ['cli', 'vscode', 'appServer', 'exec'],
        archived: false,
      });
      if (!Array.isArray(result.data)) throw new PocketError(502, 'Codex 返回的聊天列表无效');
      const known = new Map(this.store.chats().map((c) => [c.nativeId ?? c.id, c]));
      let count = 0;
      const seen = new Set<string>();
      this.store.batch(() => {
        for (const thread of result.data) {
          if (typeof thread.id !== 'string' || typeof thread.cwd !== 'string' || thread.ephemeral)
            continue;
          if (seen.has(thread.id)) continue;
          seen.add(thread.id);
          const old = known.get(thread.id);
          if (old && (old.source !== 'codex' || old.control === 'pocket')) continue;
          const chat: Chat = {
            ...old,
            id: old?.id ?? `codex:${thread.id}`,
            nativeId: thread.id,
            source: 'codex',
            control: 'history',
            title: old?.customTitle
              ? old.title
              : (thread.name || thread.preview || '本机 Codex 聊天').slice(0, 120),
            cwd: thread.cwd,
            model: thread.model ?? null,
            status: 'history',
            turnId: null,
            historyMode: thread.historyMode ?? 'legacy',
            acceptsInput: thread.canAcceptDirectInput !== false,
            createdAt: time(thread.createdAt, Date.now()),
            updatedAt: time(thread.updatedAt, Date.now()),
            error: null,
          };
          if (JSON.stringify(old) !== JSON.stringify(chat)) this.store.putChat(chat);
          known.set(thread.id, chat);
          count++;
        }
      });
      return { nextCursor: result.nextCursor ?? null, count, updatedAt: Date.now() };
    });
  }
  async turns(threadId: string, cursor?: string, limit = 10) {
    try {
      const page = await this.agent().request('thread/turns/list', {
        threadId,
        cursor,
        limit,
        sortDirection: 'desc',
        itemsView: 'full',
      });
      if (!Array.isArray(page.data)) throw new Error('Codex 返回的历史无效');
      return page;
    } catch (error) {
      // Compatibility with older servers only; other errors must remain visible.
      if (!/method not found|unknown (method|variant).*thread\/turns\/list/i.test(String(error)))
        throw error;
      const result = await this.agent().request('thread/read', { threadId, includeTurns: true });
      const all = [...(result.thread.turns ?? [])].reverse();
      const offset = cursor ? Number(cursor) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new PocketError(400, '历史游标无效');
      return {
        data: all.slice(offset, offset + limit),
        nextCursor: offset + limit < all.length ? String(offset + limit) : null,
      };
    }
  }
  async history(chat: Chat, cursor?: string) {
    const key = `${chat.id}:${cursor ?? ''}`;
    let cached = this.historyCache.get(key);
    if (!cached || Date.now() - cached.at > 2000) {
      const value = await this.single('history:' + key, () => this.turns(chat.nativeId!, cursor));
      cached = { at: Date.now(), value };
      this.historyCache.set(key, cached);
      if (this.historyCache.size > 100)
        this.historyCache.delete(this.historyCache.keys().next().value!);
    }
    const page = cached.value;
    const local = this.store.entries(chat.id, undefined, 1000);
    const claimed = new Set<string>();
    let entries: Entry[] = [...page.data].reverse().flatMap((turn: any) =>
      (turn.items ?? []).map((item: any, index: number) => {
        const entry = historyEntry(chat, turn, item, index);
        // A sent Pocket message also appears as a native userMessage after persistence.
        // Match once per turn and exact text, preserving its operation ID across refreshes.
        const own = local.find(
          (e) =>
            !claimed.has(e.id) &&
            (e.id === entry.id ||
              (entry.kind === 'user' &&
                e.kind === 'user' &&
                e.turnId === entry.turnId &&
                e.text === entry.text)),
        );
        if (own) claimed.add(own.id);
        return own ?? entry;
      }),
    );
    if (!cursor) {
      const firstTime = entries[0]?.createdAt ?? 0;
      const turns = new Set(page.data.map((t: any) => t.id));
      entries = [
        ...entries,
        ...local.filter(
          (e) =>
            !claimed.has(e.id) && (e.createdAt >= firstTime || (e.turnId && turns.has(e.turnId))),
        ),
      ];
    }
    return {
      entries,
      hasMore: !!page.nextCursor,
      nextCursor: page.nextCursor ?? null,
      cursor: this.store.cursor(),
      readAt: cached.at,
    };
  }
}
