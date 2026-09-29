import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { BoundedCache } from '../core/bounded-cache.js';
import { BotDatabase } from '../db/database.js';
import { RssSourceAdapter } from '../sources/rss-source-adapter.js';
import { VKSender } from '../vk/sender.js';
import type { AtomItem } from '../core/atom-item.js';
import type { DescriptionExtractor } from '../core/description-extractor.js';
import type { ImageExtractor } from '../core/image-extractor.js';

function tempDbPath(name: string): string {
  return join(
    mkdtempSync(join(tmpdir(), 'bot-test-')),
    `${name}.db`
  );
}

function feedEntry(id: string) {
  return {
    id,
    sourceId: 'src',
    title: 'Заголовок',
    link: `https://example.org/${id}`,
    author: 'Автор',
    content: 'Текст',
    published: '2026-09-29T10:00:00.000Z',
    updated: '2026-09-29T10:00:00.000Z',
    imageUrls: []
  };
}

describe('BoundedCache', () => {
  it('возвращает сохранённое значение', () => {
    const cache = new BoundedCache<number>(2);
    cache.set('a', 1);
    assert.equal(cache.get('a'), 1);
  });

  it('вытесняет самый старый элемент при переполнении', () => {
    const cache = new BoundedCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    assert.equal(cache.get('a'), undefined, 'самый старый вытеснен');
    assert.equal(cache.get('b'), 2);
    assert.equal(cache.get('c'), 3);
    assert.equal(cache.size, 2);
  });

  it('перезапись ключа не вытесняет лишнего', () => {
    const cache = new BoundedCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10);

    assert.equal(cache.size, 2, 'ключ обновился, а не размножился');
    assert.equal(cache.get('a'), 10);
    assert.equal(cache.get('b'), 2);
  });

  it('при размере 0 ничего не хранит и не зацикливается', () => {
    const cache = new BoundedCache<number>(0);
    cache.set('a', 1);
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.size, 0);
  });
});

describe('VKSender: повторы загрузки картинки', () => {
  /**
   * Подменяет сеть счётчиком обращений и возвращает sender. Паузы между
   * попытками отключены, иначе проверка повторов шла бы на секунды.
   *
   * Заглушка VK не просто пустая: если она бросает исключение, повторяется всё
   * сообщение целиком, и счётчик запросов к картинке измерял бы уже другое.
   * Поэтому messages.send здесь всегда успешен, и мы видим ровно те попытки,
   * которые сделал downloadImage.
   */
  function senderWithResponse(
    respond: () => Response,
    retries = 3
  ): {
    sut: VKSender;
    calls: () => number;
    uploads: () => number;
    restore: () => void;
  } {
    const original = globalThis.fetch;
    let calls = 0;
    let uploads = 0;

    globalThis.fetch = (async () => {
      calls++;
      return respond();
    }) as typeof globalThis.fetch;

    const vk = {
      upload: {
        messagePhoto: async () => {
          uploads++;
          return { type: 'photo', id: 1 };
        }
      },
      api: { messages: { send: async () => 1 } }
    };

    return {
      sut: new VKSender({
        vk: vk as never,
        imageDownloadRetries: retries,
        sleep: async () => undefined
      }),
      calls: () => calls,
      uploads: () => uploads,
      restore: () => {
        globalThis.fetch = original;
      }
    };
  }

  it('не повторяет запрос после 404', async () => {
    const { sut, calls, restore } = senderWithResponse(
      () => new Response('nope', { status: 404, statusText: 'Not Found' })
    );

    try {
      await sut.send(1, 'текст', ['https://example.org/a.png']);
      assert.equal(calls(), 1, 'битый URL повторять бессмысленно');
      assert.equal(sut.consumeImageErrors().length, 1, 'ошибка не потерялась');
    } finally {
      restore();
    }
  });

  it('повторяет запрос после 500', async () => {
    const { sut, calls, restore } = senderWithResponse(
      () => new Response('boom', { status: 500, statusText: 'Server Error' })
    );

    try {
      await sut.send(1, 'текст', ['https://example.org/a.png']);
      assert.equal(calls(), 3, 'временная ошибка сервера должна повторяться');
    } finally {
      restore();
    }
  });

  it('повторяет запрос после 429 — там сервер сам просит подождать', async () => {
    const { sut, calls, restore } = senderWithResponse(
      () =>
        new Response('slow down', {
          status: 429,
          statusText: 'Too Many Requests'
        }),
      2
    );

    try {
      await sut.send(1, 'текст', ['https://example.org/a.png']);
      assert.equal(calls(), 2);
    } finally {
      restore();
    }
  });

  it('не заливает в VK страницу, отданную вместо картинки', async () => {
    const { sut, uploads, restore } = senderWithResponse(
      () =>
        new Response('<html></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' }
        })
    );

    try {
      // Сообщение должно уйти, но БЕЗ вложения: HTML, названный картинкой,
      // — это битая ссылка, а не повод отменять весь пост.
      await sut.send(1, 'текст', ['https://example.org/a.png']);

      assert.equal(uploads(), 0, 'HTML не заливается как фото');
      assert.deepEqual(
        sut.consumeImageErrors().map(error => error.url),
        ['https://example.org/a.png'],
        'причина отказа видна в логах'
      );
    } finally {
      restore();
    }
  });
});

describe('BotDatabase: перевод дат в ISO', () => {
  /** База со старым форматом дат, как она была до миграции. */
  function legacyDb(path: string): void {
    const raw = new Database(path);

    raw.exec(`
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

    const insert = raw.prepare(
      `INSERT INTO feed_entries
         (id, title, link, author, content, published, updated, first_seen_at, source)
       VALUES (?, 't', 'https://example.org', 'a', 'c', ?, ?, '2026-01-01T00:00:00.000Z', 'src')`
    );

    insert.run('src:1', 'Wed, 29 Jul 2026 18:52:45 +0300', 'Wed, 29 Jul 2026 18:52:45 +0300');
    insert.run('src:2', 'Thu, 23 Sep 2026 09:00:00 +0300', 'Thu, 23 Sep 2026 09:00:00 +0300');

    raw.close();
  }

  function readDates(path: string, id: string): { published: string; updated: string } {
    const raw = new Database(path, { readonly: true });
    const row = raw
      .prepare(`SELECT published, updated FROM feed_entries WHERE id = ?`)
      .get(id) as { published: string; updated: string };
    raw.close();
    return row;
  }

  it('переводит сохранённые RFC-822 даты в ISO при первом открытии', () => {
    const path = tempDbPath('legacy');
    legacyDb(path);

    const db = new BotDatabase(path);
    db.close();

    const row = readDates(path, 'src:1');

    assert.equal(row.published, '2026-07-29T15:52:45.000Z');
    assert.equal(row.updated, '2026-07-29T15:52:45.000Z');
  });

  it('после перевода даты сортируются хронологически, а не лексикографически', () => {
    const path = tempDbPath('legacy-order');
    legacyDb(path);

    const db = new BotDatabase(path);

    // Июльский пост НЕ должен считаться «последним»: в RFC-822 строка
    // "Wed, 29 Jul" больше "Thu, 23 Sep" посимвольно.
    const latest = db.getLatestEntry('src');

    assert.equal(latest?.id, 'src:2');

    db.close();
  });

  it('повторное открытие не трогает уже переведённые даты', () => {
    const path = tempDbPath('legacy-twice');
    legacyDb(path);

    new BotDatabase(path).close();
    const first = readDates(path, 'src:1');

    new BotDatabase(path).close();
    const second = readDates(path, 'src:1');

    assert.deepEqual(second, first, 'миграция идемпотентна');
  });
});

describe('BotDatabase: учёт обработанных записей', () => {
  it('getHandledEntryIds отдаёт отправленные и проигнорированные', () => {
    const db = new BotDatabase(tempDbPath('handled'));

    db.addFeedEntry(feedEntry('src:1'));
    db.addFeedEntry(feedEntry('src:2'));
    db.addFeedEntry(feedEntry('src:3'));

    db.markSent('src:1');
    db.markIgnored('src:2');

    const handled = db.getHandledEntryIds();

    assert.equal(handled.has('src:1'), true, 'отправленный');
    assert.equal(handled.has('src:2'), true, 'проигнорированный');
    assert.equal(handled.has('src:3'), false, 'новый');

    db.close();
  });

  it('getEntryHandledStatus согласован с getHandledEntryIds', () => {
    const db = new BotDatabase(tempDbPath('consistent'));

    db.addFeedEntry(feedEntry('src:1'));
    db.markIgnored('src:1');

    assert.equal(db.getEntryHandledStatus('src:1'), true);
    assert.equal(db.getEntryHandledStatus('src:missing'), false);

    db.close();
  });

  it('markSent снимает отметку игнора, чтобы resend не считался дублем', () => {
    const db = new BotDatabase(tempDbPath('unignore'));

    db.addFeedEntry(feedEntry('src:1'));
    db.markIgnored('src:1');
    assert.equal(db.getEntryHandledStatus('src:1'), true);

    db.markSent('src:1');

    assert.equal(db.getEntryHandledStatus('src:1'), true);
    db.close();
  });
});

describe('RssSourceAdapter: skipIds', () => {
  const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>t</title>
<item>
  <title>Один</title>
  <link>https://example.org/1</link>
  <guid isPermaLink="false">1</guid>
  <description>x</description>
  <pubDate>Tue, 29 Sep 2026 10:00:02 +0300</pubDate>
</item>
<item>
  <title>Два</title>
  <link>https://example.org/2</link>
  <guid isPermaLink="false">2</guid>
  <description>x</description>
  <pubDate>Tue, 29 Sep 2026 11:00:02 +0300</pubDate>
</item>
</channel></rss>`;

  function adapter(extracted: string[]): {
    sut: RssSourceAdapter;
    restore: () => void;
  } {
    const original = globalThis.fetch;

    globalThis.fetch = (async () =>
      new Response(FEED, { status: 200 })) as typeof globalThis.fetch;

    const imageExtractor: ImageExtractor = {
      extract: async (item: AtomItem) => {
        extracted.push(item.guid ?? '');
        return [`https://example.org/${item.guid}.png`];
      }
    };

    const extractDescription: DescriptionExtractor = item =>
      String(item.description ?? '');

    const sut = new RssSourceAdapter({
      sourceId: 'src',
      url: 'https://example.org/rss',
      timeoutMs: 1000,
      userAgent: 'test',
      requireImages: false,
      imageExtractor,
      extractDescription
    });

    return {
      sut,
      restore: () => {
        globalThis.fetch = original;
      }
    };
  }

  it('не разбирает записи, перечисленные в skipIds', async () => {
    const extracted: string[] = [];
    const { sut, restore } = adapter(extracted);

    try {
      const entries = await sut.fetch({ skipIds: new Set(['src:1']) });

      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.id, 'src:2');
      assert.deepEqual(
        extracted,
        ['2'],
        'экстрактор не вызывался для уже обработанной записи'
      );
    } finally {
      restore();
    }
  });

  it('без skipIds разбирает весь фид', async () => {
    const extracted: string[] = [];
    const { sut, restore } = adapter(extracted);

    try {
      const entries = await sut.fetch();
      assert.equal(entries.length, 2);
      assert.deepEqual(extracted, ['1', '2']);
    } finally {
      restore();
    }
  });

  it('skipIds ждёт полный id вида sourceId:rawId, а не сырой guid', async () => {
    const extracted: string[] = [];
    const { sut, restore } = adapter(extracted);

    try {
      const entries = await sut.fetch({
        skipIds: new Set(['1', 'src:999'])
      });

      assert.equal(entries.length, 2, 'чужой формат id не должен ничего отбрасывать');
    } finally {
      restore();
    }
  });

  it('reextractImages игнорирует skipIds — он ищет запись, а не отбрасывает', async () => {
    const extracted: string[] = [];
    const { sut, restore } = adapter(extracted);

    try {
      const images = await sut.reextractImages('src:1');

      assert.deepEqual(images, ['https://example.org/1.png']);
      assert.deepEqual(extracted, ['1', '2'], 'фид разобран целиком');
    } finally {
      restore();
    }
  });
});
