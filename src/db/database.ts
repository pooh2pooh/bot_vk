import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  Admin,
  FeedEntry,
  FeedSource
} from '../types.js';

interface FeedEntryRow {
  id: string;
  title: string;
  link: string;
  author: string;
  content: string;
  published: string;
  updated: string;
  source: FeedSource;
  image_urls_json: string;
}

export class BotDatabase {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });

    this.db = new Database(path);

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    this.migrate();
  }

  private migrate(): void {
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
        source TEXT NOT NULL DEFAULT 'forum',
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
    `);

    // Миграция существующей bot.db.
    this.addColumnIfMissing(
      'source',
      "TEXT NOT NULL DEFAULT 'forum'"
    );
    this.addColumnIfMissing(
      'image_urls_json',
      "TEXT NOT NULL DEFAULT '[]'"
    );
    this.addColumnIfMissing(
      'ignored_at',
      'TEXT'
    );

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_feed_entries_source_published
      ON feed_entries(source, published);
    `);
  }

  private addColumnIfMissing(
    column: string,
    definition: string
  ): void {
    const columns = this.db
      .prepare('PRAGMA table_info(feed_entries)')
      .all() as Array<{ name: string }>;

    if (
      columns.some(existing => existing.name === column)
    ) {
      return;
    }

    this.db.exec(
      `ALTER TABLE feed_entries ADD COLUMN ${column} ${definition}`
    );
  }

  close(): void {
    this.db.close();
  }

  hasFeedEntry(id: string): boolean {
    const row = this.db
      .prepare(`
        SELECT 1
        FROM feed_entries
        WHERE id = ?
        LIMIT 1
      `)
      .get(id);

    return Boolean(row);
  }

  addFeedEntry(entry: FeedEntry): void {
    this.db
      .prepare(`
        INSERT OR IGNORE INTO feed_entries (
          id,
          title,
          link,
          author,
          content,
          published,
          updated,
          first_seen_at,
          source,
          image_urls_json
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
        entry.source,
        JSON.stringify(entry.imageUrls)
      );
  }

  markSent(id: string): void {
    this.db
      .prepare(`
        UPDATE feed_entries
        SET sent_at = ?,
            ignored_at = NULL
        WHERE id = ?
      `)
      .run(new Date().toISOString(), id);
  }

  markIgnored(id: string): void {
    this.db
      .prepare(`
        UPDATE feed_entries
        SET ignored_at = ?
        WHERE id = ?
          AND sent_at IS NULL
      `)
      .run(new Date().toISOString(), id);
  }

  getLatestEntry(
    source: FeedSource = 'forum'
  ): FeedEntry | null {
    const row = this.db
      .prepare(`
        SELECT
          id,
          title,
          link,
          author,
          content,
          published,
          updated,
          source,
          image_urls_json
        FROM feed_entries
        WHERE source = ?
        ORDER BY published DESC, first_seen_at DESC
        LIMIT 1
      `)
      .get(source) as FeedEntryRow | undefined;

    return row ? this.toFeedEntry(row) : null;
  }

  getEntry(id: string): FeedEntry | null {
    const row = this.db
      .prepare(`
        SELECT
          id,
          title,
          link,
          author,
          content,
          published,
          updated,
          source,
          image_urls_json
        FROM feed_entries
        WHERE id = ?
        LIMIT 1
      `)
      .get(id) as FeedEntryRow | undefined;

    return row ? this.toFeedEntry(row) : null;
  }

  private toFeedEntry(row: FeedEntryRow): FeedEntry {
    let imageUrls: string[] = [];

    try {
      const parsed = JSON.parse(
        row.image_urls_json
      ) as unknown;

      if (Array.isArray(parsed)) {
        imageUrls = parsed.filter(
          (value): value is string =>
            typeof value === 'string'
        );
      }
    } catch {
      imageUrls = [];
    }

    return {
      id: row.id,
      title: row.title,
      link: row.link,
      author: row.author,
      content: row.content,
      published: row.published,
      updated: row.updated,
      source: row.source,
      imageUrls
    };
  }

  getEntrySentStatus(id: string): boolean {
    const row = this.db
      .prepare(`
        SELECT sent_at
        FROM feed_entries
        WHERE id = ?
        LIMIT 1
      `)
      .get(id) as { sent_at: string | null } | undefined;

    return Boolean(row?.sent_at);
  }

  getEntryIgnoredStatus(id: string): boolean {
    const row = this.db
      .prepare(`
        SELECT ignored_at
        FROM feed_entries
        WHERE id = ?
        LIMIT 1
      `)
      .get(id) as { ignored_at: string | null } | undefined;

    return Boolean(row?.ignored_at);
  }

  getEntryHandledStatus(id: string): boolean {
    const row = this.db
      .prepare(`
        SELECT sent_at, ignored_at
        FROM feed_entries
        WHERE id = ?
        LIMIT 1
      `)
      .get(id) as {
        sent_at: string | null;
        ignored_at: string | null;
      } | undefined;

    return Boolean(
      row?.sent_at || row?.ignored_at
    );
  }

  addAdmin(
    userId: number,
    role: 'owner' | 'admin' = 'admin'
  ): void {
    this.db
      .prepare(`
        INSERT INTO admins (
          user_id,
          role,
          created_at
        )
        VALUES (?, ?, ?)
        ON CONFLICT(user_id)
        DO UPDATE SET role = excluded.role
      `)
      .run(
        userId,
        role,
        new Date().toISOString()
      );
  }

  removeAdmin(userId: number): void {
    this.db
      .prepare(`
        DELETE FROM admins
        WHERE user_id = ?
      `)
      .run(userId);
  }

  isAdmin(userId: number): boolean {
    const row = this.db
      .prepare(`
        SELECT 1
        FROM admins
        WHERE user_id = ?
        LIMIT 1
      `)
      .get(userId);

    return Boolean(row);
  }

  isOwner(userId: number): boolean {
    const row = this.db
      .prepare(`
        SELECT 1
        FROM admins
        WHERE user_id = ?
          AND role = 'owner'
        LIMIT 1
      `)
      .get(userId);

    return Boolean(row);
  }

  getAdmins(): Admin[] {
    return this.db
      .prepare(`
        SELECT
          user_id AS userId,
          role,
          created_at AS createdAt
        FROM admins
        ORDER BY
          CASE role
            WHEN 'owner' THEN 0
            ELSE 1
          END,
          user_id
      `)
      .all() as Admin[];
  }

  getSetting(key: string): string | null {
    const row = this.db
      .prepare(`
        SELECT value
        FROM settings
        WHERE key = ?
        LIMIT 1
      `)
      .get(key) as { value: string } | undefined;

    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(`
        INSERT INTO settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key)
        DO UPDATE SET value = excluded.value
      `)
      .run(key, value);
  }

  getStats(): {
    totalEntries: number;
    sentEntries: number;
    admins: number;
  } {
    const entries = this.db
      .prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sent
        FROM feed_entries
      `)
      .get() as {
        total: number;
        sent: number | null;
      };

    const admins = this.db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM admins
      `)
      .get() as { count: number };

    return {
      totalEntries: entries.total,
      sentEntries: entries.sent ?? 0,
      admins: admins.count
    };
  }
}
