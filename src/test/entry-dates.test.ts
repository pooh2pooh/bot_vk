import BetterSqlite3 from 'better-sqlite3';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { BotDatabase } from '../db/database.js';
import { toIsoDate } from '../core/text-utils.js';
import type { FeedEntry } from '../core/types.js';

const dirs: string[] = [];

function makeDb(): BotDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'bot-db-'));
  dirs.push(dir);

  return new BotDatabase(join(dir, 'test.db'));
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function entry(over: Partial<FeedEntry> = {}): FeedEntry {
  return {
    id: 'screenshots:https://example.com/1',
    sourceId: 'screenshots',
    title: 'пост',
    link: 'https://example.com/1',
    author: 'кто-то',
    content: 'текст',
    published: '2026-09-29T11:23:20.000Z',
    updated: '2026-09-29T11:23:20.000Z',
    imageUrls: [],
    ...over
  };
}

describe('toIsoDate', () => {
  it('переводит RFC-822 в ISO с переводом в UTC', () => {
    assert.equal(
      toIsoDate('Wed, 29 Jul 2026 18:52:45 +0300'),
      '2026-07-29T15:52:45.000Z'
    );
  });

  it('оставляет корректный ISO как есть', () => {
    const iso = '2026-09-29T11:23:20.000Z';
    assert.equal(toIsoDate(iso), iso);
  });

  it('возвращает null на мусоре, а не строку-обманку', () => {
    assert.equal(toIsoDate('не дата'), null);
    assert.equal(toIsoDate(''), null);
    assert.equal(toIsoDate('   '), null);
    assert.equal(toIsoDate(null), null);
    assert.equal(toIsoDate(undefined), null);
  });
});

describe('даты в базе: лексикографический порядок = хронологический', () => {
  /*
   * Регрессия: published писался сырой строкой RFC-822, и SQLite сравнивал
   * её как текст. "29 Jul" оказывался больше "23 Sep" (сравниваются символы),
   * поэтому getLatestEntry отдавал июльский пост вместо сентябрьского.
   */
  it('миграция чинит старую базу при следующем старте', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-db-legacy-'));
    dirs.push(dir);
    const path = join(dir, 'legacy.db');

    /*
     * Записываем в сыром RFC-822 — как было ДО фикса. Через сырой SQLite,
     * потому что сам класс мигрирует даты при создании.
     */
    const legacy = new BetterSqlite3(path);
    legacy.exec(`
      CREATE TABLE feed_entries (
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
    `);

    const insert = legacy.prepare(
      `INSERT INTO feed_entries
        (id, title, link, author, content, published, updated, first_seen_at, source, image_urls_json)
       VALUES (?, 't', ?, 'a', 'c', ?, ?, '2026-09-29T00:00:00.000Z', 'screenshots', '[]')`
    );

    for (const [link, published] of [
      [
        'https://www.linux.org.ru/gallery/workplaces/18348513',
        'Wed, 29 Jul 2026 18:52:45 +0300'
      ],
      [
        'https://www.linux.org.ru/gallery/workplaces/18384944',
        'Wed, 23 Sep 2026 04:41:51 +0300'
      ],
      [
        'https://www.linux.org.ru/gallery/screenshots/18389326',
        'Tue, 29 Sep 2026 14:23:20 +0300'
      ]
    ]) {
      insert.run(`screenshots:${link}`, link, published, published);
    }

    // Проверяем, что ДО миграции порядок сломан.
    const wrongBefore = legacy
      .prepare(
        `SELECT link FROM feed_entries WHERE source='screenshots' ORDER BY published DESC LIMIT 1`
      )
      .get() as { link: string };
    legacy.close();

    assert.equal(
      wrongBefore.link,
      'https://www.linux.org.ru/gallery/workplaces/18348513',
      'до фикса лексикографическая сортировка выбирала июльский пост'
    );

    // Тот же файл открываем через BotDatabase — срабатывает миграция.
    const db = new BotDatabase(path);
    const latest = db.getLatestEntry('screenshots');

    assert.equal(
      latest?.link,
      'https://www.linux.org.ru/gallery/screenshots/18389326',
      'после миграции последним считается пост от 29 сентября'
    );
    db.close();
  });

  it('миграция идемпотентна', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-db-idem-'));
    dirs.push(dir);
    const path = join(dir, 'idem.db');

    const first = new BotDatabase(path);
    first.addFeedEntry(
      entry({ published: toIsoDate('Tue, 29 Sep 2026 14:23:20 +0300')! })
    );
    const before = first.getLatestEntry('screenshots')?.published;
    first.close();

    const second = new BotDatabase(path);
    const after = second.getLatestEntry('screenshots')?.published;
    second.close();

    assert.equal(before, after);
    assert.equal(after, '2026-09-29T11:23:20.000Z');
  });

  it('новая запись пишет дату в ISO', () => {
    const db = makeDb();

    db.addFeedEntry(
      entry({ published: toIsoDate('Wed, 29 Jul 2026 18:52:45 +0300')! })
    );

    const row = db.getLatestEntry('screenshots');
    assert.equal(row?.published, '2026-07-29T15:52:45.000Z');
    db.close();
  });

  it('порядок записей совпадает с реальной хронологией', () => {
    const db = makeDb();

    const dates = [
      'Wed, 29 Jul 2026 18:52:45 +0300',
      'Wed, 2 Sep 2026 12:29:51 +0300',
      'Wed, 23 Sep 2026 04:41:51 +0300',
      'Tue, 29 Sep 2026 14:23:20 +0300'
    ];

    dates.forEach((raw, index) => {
      db.addFeedEntry(
        entry({
          id: `screenshots:${index}`,
          link: `https://example.com/${index}`,
          published: toIsoDate(raw)!
        })
      );
    });

    const latest = db.getLatestEntry('screenshots');
    assert.equal(latest?.id, 'screenshots:3', 'должен быть самый свежий пост');
    db.close();
  });
});
