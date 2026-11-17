import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Chat, Entry, PendingRequest, PocketEvent } from '../../../packages/types.ts';

export class PocketError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export class Store extends EventEmitter {
  db: Database.Database;
  private bufferedEvents: PocketEvent[] | null = null;
  constructor(path: string) {
    super();
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries(position INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,chat_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS entries_chat ON entries(chat_id,position);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,chat_id TEXT,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,status TEXT NOT NULL,result TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS queue(position INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT UNIQUE NOT NULL,chat_id TEXT NOT NULL,text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,label TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pairing(hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
    `);
    if (!this.meta('hostId')) this.setMeta('hostId', randomUUID());
  }
  meta(key: string) {
    return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as any)?.value as
      string | undefined;
  }
  setMeta(key: string, value: string) {
    this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key, value);
  }
  batch<T>(fn: () => T): T {
    if (this.bufferedEvents) return fn();
    const events: PocketEvent[] = [];
    this.bufferedEvents = events;
    let result: T;
    try {
      result = this.db.transaction(fn)();
    } finally {
      this.bufferedEvents = null;
    }
    for (const event of events) this.emit('event', event);
    return result;
  }
  chats(): Chat[] {
    return (this.db.prepare('SELECT body FROM chats').all() as any[])
      .map((r) => JSON.parse(r.body))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  chat(id: string): Chat {
    const r = this.db.prepare('SELECT body FROM chats WHERE id=?').get(id) as any;
    if (!r) throw new PocketError(404, '聊天不存在');
    return JSON.parse(r.body);
  }
  putChat(chat: Chat) {
    this.commit('chat', chat.id, chat, () =>
      this.db
        .prepare('INSERT OR REPLACE INTO chats VALUES(?,?)')
        .run(chat.id, JSON.stringify(chat)),
    );
  }
  patchChat(id: string, patch: Partial<Chat>) {
    const chat = { ...this.chat(id), ...patch, updatedAt: Date.now() };
    this.putChat(chat);
    return chat;
  }
  entries(id: string, before?: number, limit = 60): Entry[] {
    return (
      this.db
        .prepare(
          'SELECT position,body FROM entries WHERE chat_id=? AND position<? ORDER BY position DESC LIMIT ?',
        )
        .all(id, before ?? Number.MAX_SAFE_INTEGER, limit) as any[]
    )
      .reverse()
      .map((r) => ({ ...JSON.parse(r.body), order: r.position }));
  }
  entry(id: string): Entry | undefined {
    const r = this.db.prepare('SELECT body FROM entries WHERE id=?').get(id) as any;
    return r && JSON.parse(r.body);
  }
  putEntry(entry: Entry) {
    entry = {
      ...entry,
      title: entry.title.slice(0, 800),
      text:
        entry.text.length > 250000 ? '[较早输出已截断]\n' + entry.text.slice(-240000) : entry.text,
    };
    this.commit('entry', entry.chatId, entry, () =>
      this.db
        .prepare(
          'INSERT INTO entries(id,chat_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
        )
        .run(entry.id, entry.chatId, JSON.stringify(entry)),
    );
  }
  requests(): PendingRequest[] {
    return (this.db.prepare('SELECT body FROM requests').all() as any[]).map((r) =>
      JSON.parse(r.body),
    );
  }
  putRequest(request: PendingRequest) {
    this.commit('request', request.chatId, request, () =>
      this.db
        .prepare('INSERT OR REPLACE INTO requests VALUES(?,?)')
        .run(request.id, JSON.stringify(request)),
    );
  }
  cursor() {
    return (this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM events').get() as any)
      .n as number;
  }
  replay(after: number): PocketEvent[] | null {
    const oldest = (this.db.prepare('SELECT MIN(seq) AS n FROM events').get() as any).n;
    if (after > this.cursor() || (oldest && after < oldest - 1)) return null;
    return (
      this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq').all(after) as any[]
    ).map((r) => ({ seq: r.seq, type: r.type, chatId: r.chat_id, data: JSON.parse(r.data) }));
  }
  private commit(type: string, chatId: string | null, data: unknown, update: () => unknown) {
    const event = this.db.transaction(() => {
      update();
      const info = this.db
        .prepare('INSERT INTO events(type,chat_id,data) VALUES(?,?,?)')
        .run(type, chatId, JSON.stringify(data));
      const seq = Number(info.lastInsertRowid);
      if (seq % 200 === 0) this.db.prepare('DELETE FROM events WHERE seq<?').run(seq - 2000);
      return { seq, type, chatId, data };
    })();
    if (this.bufferedEvents) this.bufferedEvents.push(event);
    else this.emit('event', event);
  }
  beginOperation(id: string, input: unknown) {
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const existing = this.operation(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new PocketError(409, '操作标识已用于另一条指令');
      return existing;
    }
    this.db
      .prepare('INSERT INTO operations(id,fingerprint,status) VALUES(?,?,?)')
      .run(id, fingerprint, 'pending');
    return null;
  }
  operation(id: string): any {
    const r = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as any;
    return r && { ...r, result: r.result && JSON.parse(r.result) };
  }
  completeOperation(id: string, result: unknown) {
    this.db
      .prepare("UPDATE operations SET status='done',result=? WHERE id=?")
      .run(JSON.stringify(result), id);
  }
  failOperation(id: string, error: string) {
    this.db.prepare("UPDATE operations SET status='uncertain',error=? WHERE id=?").run(error, id);
  }
  close() {
    this.db.close();
  }
}
