import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RssSourceAdapter } from '../sources/rss-source-adapter.js';
import type { ImageExtractor } from '../core/image-extractor.js';
import type { AtomItem } from '../core/atom-item.js';

const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Пингвинус Linux</title>
<item>
  <title>Новость</title>
  <link>https://pingvinus.ru/news/5533</link>
  <description><p>текст новости</p></description>
  <guid isPermaLink="false">5533 at https://pingvinus.ru</guid>
  <pubDate>Tue, 29 Sep 2026 10:00:02 +0300</pubDate>
</item>
<item>
  <title>Скриншот</title>
  <link>https://pingvinus.ru/gallery/5532</link>
  <description></description>
  <guid isPermaLink="false">5532 at https://pingvinus.ru</guid>
  <pubDate>Tue, 29 Sep 2026 11:00:02 +0300</pubDate>
</item>
<item>
  <title>Заметка</title>
  <link>https://pingvinus.ru/note/unifying-gui-style</link>
  <description><p>текст заметки</p></description>
  <guid isPermaLink="false">note at https://pingvinus.ru</guid>
  <pubDate>Mon, 28 Sep 2026 09:00:02 +0300</pubDate>
</item>
</channel></rss>`;

/** Подменяет fetchText, чтобы адаптер читал фикстуру, а не сеть. */
function adapterWithFeed(
  xml: string,
  includePattern?: RegExp
): { sut: RssSourceAdapter; extracted: string[] } {
  const extracted: string[] = [];

  const imageExtractor: ImageExtractor = {
    extract: async (item: AtomItem) => {
      extracted.push(item.link ?? '');

      return item.link?.includes('/gallery/')
        ? ['https://pingvinus.ru/cr_images/userpicture/n/1-0.jpg']
        : [];
    }
  };

  // fetchText живёт в core и не подменяется, поэтому работаем через
  // перехват глобального fetch.
  const original = globalThis.fetch;

  globalThis.fetch = (async () =>
    new Response(xml, {
      status: 200,
      headers: { 'content-type': 'application/rss+xml' }
    })) as typeof globalThis.fetch;

  const sut = new RssSourceAdapter({
    sourceId: 'pingvinus',
    url: 'https://pingvinus.ru/rss.xml',
    timeoutMs: 1000,
    userAgent: 'test',
    requireImages: false,
    extractDescription: item => String(item.description ?? ''),
    imageExtractor,
    includePattern
  });

  (sut as unknown as { restore: () => void }).restore = () => {
    globalThis.fetch = original;
  };

  return { sut, extracted };
}

describe('RssSourceAdapter includePattern', () => {
  it('без фильтра берёт все записи фида', async () => {
    const { sut, extracted } = adapterWithFeed(FEED_XML);

    try {
      const entries = await sut.fetch();
      assert.equal(entries.length, 3);
      assert.equal(extracted.length, 3, 'все записи прошли через экстрактор');
    } finally {
      (sut as unknown as { restore: () => void }).restore();
    }
  });

  it('оставляет только записи, совпавшие с шаблоном', async () => {
    const { sut } = adapterWithFeed(FEED_XML, /^https:\/\/pingvinus\.ru\/gallery\//);

    try {
      const entries = await sut.fetch();
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.link, 'https://pingvinus.ru/gallery/5532');
    } finally {
      (sut as unknown as { restore: () => void }).restore();
    }
  });

  it('не вызывает экстрактор для отброшенных записей', async () => {
    const { sut, extracted } = adapterWithFeed(
      FEED_XML,
      /^https:\/\/pingvinus\.ru\/gallery\//
    );

    try {
      await sut.fetch();
      assert.deepEqual(extracted, ['https://pingvinus.ru/gallery/5532']);
    } finally {
      (sut as unknown as { restore: () => void }).restore();
    }
  });

  it('не цепляет записи, где gallery встречается в другом месте ссылки', async () => {
    const xml = FEED_XML.replace(
      'https://pingvinus.ru/note/unifying-gui-style',
      'https://pingvinus.ru/note/gallery/trap'
    );
    const { sut } = adapterWithFeed(xml, /^https:\/\/pingvinus\.ru\/gallery\//);

    try {
      const entries = await sut.fetch();
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.link, 'https://pingvinus.ru/gallery/5532');
    } finally {
      (sut as unknown as { restore: () => void }).restore();
    }
  });

  it('requireImages отбрасывает записи без картинок после фильтра', async () => {
    const extracted: string[] = [];
    const original = globalThis.fetch;

    globalThis.fetch = (async () =>
      new Response(FEED_XML, { status: 200 })) as typeof globalThis.fetch;

    const sut = new RssSourceAdapter({
      sourceId: 'pingvinus',
      url: 'https://pingvinus.ru/rss.xml',
      timeoutMs: 1000,
      userAgent: 'test',
      requireImages: true,
      extractDescription: item => String(item.description ?? ''),
      imageExtractor: {
        extract: async (item: AtomItem) => {
          extracted.push(item.link ?? '');
          return [];
        }
      },
      includePattern: /^https:\/\/pingvinus\.ru\/gallery\//
    });

    try {
      const entries = await sut.fetch();
      assert.equal(entries.length, 0, 'без картинок запись не проходит');
      assert.deepEqual(extracted, ['https://pingvinus.ru/gallery/5532']);
    } finally {
      globalThis.fetch = original;
    }
  });
});
