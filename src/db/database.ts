import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Admin, FeedEntry } from '../types.js';

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
        sent_at TEXT
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
          first_seen_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        entry.id,
        entry.title,
        entry.link,
        entry.author,
        entry.content,
        entry.published,
        entry.updated,
        new Date().toISOString()
      );
  }

  markSent(id: string): void {
    this.db
      .prepare(`
        UPDATE feed_entries
        SET sent_at = ?
        WHERE id = ?
      `)
      .run(new Date().toISOString(), id);
  }

  getLatestEntry(): FeedEntry | null {
    const row = this.db
      .prepare(`
        SELECT
          id,
          title,
          link,
          author,
          content,
          published,
          updated
        FROM feed_entries
        ORDER BY published DESC
        LIMIT 1
      `)
      .get() as FeedEntry | undefined;

    return row ?? null;
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
          updated
        FROM feed_entries
        WHERE id = ?
        LIMIT 1
      `)
      .get(id) as FeedEntry | undefined;

    return row ?? null;
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

  addAdmin(userId: number, role: 'owner' | 'admin' = 'admin'): void {
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
