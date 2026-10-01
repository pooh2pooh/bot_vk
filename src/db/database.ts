import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Admin, FeedEntry } from '../core/types.js';

/**
 * Состояние записи в базе.
 *
 * `skipped` и `pending` — не одно и то же: первое означает «бот увидел пост и
 * решил его не слать», второе — «видел, но ещё не решал». Оба закрывают
 * отправку, но показывать их в списке по-разному полезно.
 */
export type EntryState = 'sent' | 'skipped' | 'pending';

/** Запись из базы вместе с её состоянием — для показа админу. */
export interface StoredEntry {
  entry: FeedEntry;
  state: EntryState;
}

interface FeedEntryRow {
  id: string;
  title: string;
  link: string;
  author: string;
  content: string;
  published: string;
  updated: string;
  source: string;
  image_urls_json: string;
}

export class BotDatabase {
  private readonly db: Database.Database;

  /**
   * Готовые prepared statements.
   *
   * better-sqlite3 компилирует SQL при каждом .prepare(), а конвейер дёргает
   * одни и те же запросы тысячи раз за жизнь процесса. Кеш убирает повторную
   * компиляцию и заодно убирает разбросанные по методам .prepare() в одну
   * точку.
   */
  private readonly statements = new Map<string, Database.Statement>();

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });

    this.db = new Database(path);

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    this.createSchema();
  }

  /**
   * Схема создаётся целиком и всегда: `CREATE TABLE IF NOT EXISTS` ничего не
   * ломает в существующей базе, поэтому отдельных версий схемы не нужно.
   *
   * Раньше здесь же была миграция, переводившая сохранённые даты в ISO: тогда
   * даты писались в формате RFC-822, и SQLite сравнивал их как текст, из-за
   * чего «последний пост» выбирался неверно. Сейчас ISO гарантирован на входе
   * (`core/feed-item.ts`), поэтому и чинить старые строки незачем: legacy-миграция
   * была удалена вместе с причиной.
   */
  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feed_entries (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        link TEXT NOT NULL,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        published TEXT NOT NULL,
        updated TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        sent_at TEXT,
        source TEXT NOT NULL DEFAULT 'default',
        image_urls_json TEXT NOT NULL DEFAULT '[]',
        ignored_at TEXT
      );

      CREATE TABLE IF NOT EXISTS admins (
        user_id INTEGER PRIMARY KEY,
        role TEXT NOT NULL CHECK(role IN ('owner', 'admin')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_feed_entries_published
      ON feed_entries(published);

      CREATE INDEX IF NOT EXISTS idx_feed_entries_sent
      ON feed_entries(sent_at);

      CREATE INDEX IF NOT EXISTS idx_feed_entries_source_published
      ON feed_entries(source, published);
    `);
  }

  /** Компилирует запрос один раз и переиспользует его дальше. */
  private statement(sql: string): Database.Statement {
    const cached = this.statements.get(sql);

    if (cached) {
      return cached;
    }

    const prepared = this.db.prepare(sql);
    this.statements.set(sql, prepared);

    return prepared;
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }

  hasFeedEntry(id: string): boolean {
    const row = this
      .statement(`SELECT 1 FROM feed_entries WHERE id = ? LIMIT 1`)
      .get(id);

    return Boolean(row);
  }

  addFeedEntry(entry: FeedEntry): void {
    this
      .statement(`
        INSERT OR IGNORE INTO feed_entries (
          id, title, link, author, content, published, updated,
          first_seen_at, source, image_urls_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        entry.id,
        entry.title,
        entry.link,
        entry.author,
        entry.content,
        entry.published,
        entry.updated,
        new Date().toISOString(),
        entry.sourceId,
        JSON.stringify(entry.imageUrls)
      );
  }

  /**
   * Перезаписывает список картинок уже сохранённой записи.
   *
   * Нужно, когда логика извлечения картинок изменилась, а записи в базе
   * содержат результат старой разметки: без этого каждый resend отправлял бы
   * заведомо устаревший список вложений.
   */
  updateEntryImages(id: string, imageUrls: string[]): void {
    this
      .statement(`UPDATE feed_entries SET image_urls_json = ? WHERE id = ?`)
      .run(JSON.stringify(imageUrls), id);
  }

  markSent(id: string): void {
    this
      .statement(`
        UPDATE feed_entries
        SET sent_at = ?, ignored_at = NULL
        WHERE id = ?
      `)
      .run(new Date().toISOString(), id);
  }

  markIgnored(id: string): void {
    this
      .statement(`
        UPDATE feed_entries
        SET ignored_at = ?
        WHERE id = ? AND sent_at IS NULL
      `)
      .run(new Date().toISOString(), id);
  }

  getLatestEntry(sourceId: string): FeedEntry | null {
    const row = this
      .statement(`
        SELECT id, title, link, author, content, published, updated, source, image_urls_json
        FROM feed_entries
        WHERE source = ?
        ORDER BY published DESC, first_seen_at DESC
        LIMIT 1
      `)
      .get(sourceId) as FeedEntryRow | undefined;

    return row ? this.toFeedEntry(row) : null;
  }

  /**
   * Последние записи источника, свежие сверху.
   *
   * Отдельный метод, а не параметр у `getLatestEntry`: показ списка и выбор
   * поста админом — разные задачи, и смешивать их значило бы тащить в
   * `getLatestEntry` параметры, которые ему не нужны ни в одном сценарии.
   *
   * Порядок ОБЯЗАН совпадать с `getLatestEntry`: иначе «пост №1» в списке и
   * «последний пост» указывали бы на разные записи, что для человека
   * неразличимо и потому крайне запутывает.
   */
  listRecentEntries(sourceId: string, limit: number): StoredEntry[] {
    const rows = this
      .statement(`
        SELECT id, title, link, author, content, published, updated, source,
               image_urls_json, sent_at, ignored_at
        FROM feed_entries
        WHERE source = ?
        ORDER BY published DESC, first_seen_at DESC
        LIMIT ?
      `)
      .all(sourceId, limit) as (FeedEntryRow & {
      sent_at: string | null;
      ignored_at: string | null;
    })[];

    return rows.map(row => ({
      entry: this.toFeedEntry(row),
      state: row.sent_at ? 'sent' : row.ignored_at ? 'skipped' : 'pending'
    }));
  }

  private toFeedEntry(row: FeedEntryRow): FeedEntry {
    let imageUrls: string[] = [];

    try {
      const parsed = JSON.parse(row.image_urls_json) as unknown;

      if (Array.isArray(parsed)) {
        imageUrls = parsed.filter(
          (value): value is string => typeof value === 'string'
        );
      }
    } catch {
      imageUrls = [];
    }

    return {
      id: row.id,
      sourceId: row.source,
      title: row.title,
      link: row.link,
      author: row.author,
      content: row.content,
      published: row.published,
      updated: row.updated,
      imageUrls
    };
  }

  /**
   * Обработана ли запись: отправлена ИЛИ помечена проигнорированной.
   *
   * Единая точка правды о «пост уже не новый». Отдельные проверки sent/ignored
   * в разных местах обязаны были сходиться, и любая из них не совпала бы —
   * пост отправился бы повторно или, наоборот, потерялся.
   */
  getEntryHandledStatus(id: string): boolean {
    return this.handledFlags(id).handled;
  }

  /**
   * Все обработанные записи одним запросом.
   *
   * Нужно конвейеру перед разбором фида: он отдаёт адаптеру id уже известных
   * постов, чтобы адаптер не извлекал для них картинки и не ходил на страницы.
   * Один SELECT вместо запроса на каждый элемент фида.
   */
  getHandledEntryIds(): ReadonlySet<string> {
    const rows = this.statement(
      `SELECT id FROM feed_entries WHERE sent_at IS NOT NULL OR ignored_at IS NOT NULL`
    ).all() as { id: string }[];

    return new Set(rows.map(row => row.id));
  }

  private handledFlags(id: string): { handled: boolean } {
    const row = this
      .statement(`SELECT sent_at, ignored_at FROM feed_entries WHERE id = ? LIMIT 1`)
      .get(id) as { sent_at: string | null; ignored_at: string | null } | undefined;

    return { handled: Boolean(row?.sent_at || row?.ignored_at) };
  }

  addAdmin(userId: number, role: 'owner' | 'admin' = 'admin'): void {
    this
      .statement(`
        INSERT INTO admins (user_id, role, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET role = excluded.role
      `)
      .run(userId, role, new Date().toISOString());
  }

  removeAdmin(userId: number): void {
    this.statement(`DELETE FROM admins WHERE user_id = ?`).run(userId);
  }

  isAdmin(userId: number): boolean {
    const row = this
      .statement(`SELECT 1 FROM admins WHERE user_id = ? LIMIT 1`)
      .get(userId);

    return Boolean(row);
  }

  isOwner(userId: number): boolean {
    const row = this
      .statement(`SELECT 1 FROM admins WHERE user_id = ? AND role = 'owner' LIMIT 1`)
      .get(userId);

    return Boolean(row);
  }

  getAdmins(): Admin[] {
    return this
      .statement(`
        SELECT user_id AS userId, role, created_at AS createdAt
        FROM admins
        ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, user_id
      `)
      .all() as Admin[];
  }

  getSetting(key: string): string | null {
    const row = this
      .statement(`SELECT value FROM settings WHERE key = ? LIMIT 1`)
      .get(key) as { value: string } | undefined;

    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this
      .statement(`
        INSERT INTO settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run(key, value);
  }

  /** Персистентный override enabled-флага источника (переживает рестарт). */
  getSourceEnabledOverride(sourceId: string): boolean | null {
    const value = this.getSetting(`source_enabled:${sourceId}`);
    return value === null ? null : value === '1';
  }

  setSourceEnabledOverride(sourceId: string, enabled: boolean): void {
    this.setSetting(`source_enabled:${sourceId}`, enabled ? '1' : '0');
  }

  getStats(): { totalEntries: number; sentEntries: number; admins: number } {
    const entries = this
      .statement(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sent
        FROM feed_entries
      `)
      .get() as { total: number; sent: number | null };

    const admins = this
      .statement(`SELECT COUNT(*) AS count FROM admins`)
      .get() as { count: number };

    return {
      totalEntries: entries.total,
      sentEntries: entries.sent ?? 0,
      admins: admins.count
    };
  }

  getEntriesPerSource(): Record<string, number> {
    const rows = this
      .statement(`SELECT source, COUNT(*) AS count FROM feed_entries GROUP BY source`)
      .all() as Array<{ source: string; count: number }>;

    return Object.fromEntries(rows.map(row => [row.source, row.count]));
  }
}
