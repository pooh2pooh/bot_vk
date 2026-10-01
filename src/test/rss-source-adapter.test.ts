import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compileFilter } from '../core/filter.js';
import { itemEntryId, itemHtmlContent, toIsoDate, toFeedEntry } from '../core/feed-item.js';
import { PLAIN_SITE_STRATEGY } from '../core/site-strategy.js';
import { RssSourceAdapter } from '../sources/rss-source-adapter.js';
import type { FeedItem } from '../core/feed-item.js';
import type { SiteStrategy } from '../core/site-strategy.js';

/**
 * Адаптер превращает элементы фида в записи конвейера. Здесь проверяются
 * правила, которые он решает САМ, независимо от сайта: что считается новой
 * записью, что отбрасывается до разбора страницы и почему даты обязаны быть
 * в ISO.
 */

function atomItem(overrides: FeedItem = {}): FeedItem {
  return {
    title: 'Заголовок поста',
    link: 'https://example.org/post/1',
    id: 'tag:example.org,2026:1',
    published: 'Wed, 30 Sep 2026 17:00:16 +0300',
    description: '<p>Текст поста</p>',
    ...overrides
  };
}

function atomFeed(...items: FeedItem[]): string {
  const entries = items
    .map(
      item => `
    <entry>
      <title>${item.title ?? ''}</title>
      <link href="${item.link ?? ''}" />
      <id>${item.id ?? ''}</id>
      <published>${item.published ?? ''}</published>
      <updated>${item.published ?? ''}</updated>
      <content type="html">${item.description ?? ''}</content>
    </entry>`
    )
    .join('');

  return `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">${entries}
</feed>`;
}

/** Считает, сколько элементов фида дошли до стратегии. */
function countingStrategy(counts: { images: number }): SiteStrategy {
  return {
    images: async () => {
      counts.images++;

      return ['https://example.org/1.png'];
    },
    description: item => itemHtmlContent(item),
    imagesFromUrl: async () => ['https://example.org/from-page.png'],
    postText: async () => 'текст со страницы'
  };
}

function adapter(
  options: {
    strategy?: SiteStrategy;
    includeFilter?: string;
    requireImages?: boolean;
    counts?: { images: number };
  } = {}
): RssSourceAdapter {
  return new RssSourceAdapter({
    sourceId: 'src',
    feedUrl: 'https://example.org/feed.atom',
    timeoutMs: 1_000,
    userAgent: 'test',
    strategy: options.strategy ?? countingStrategy(options.counts ?? { images: 0 }),
    includeFilter: options.includeFilter
      ? compileFilter(options.includeFilter, 'test')
      : undefined,
    requireImages: options.requireImages ?? false
  });
}

/** Подменяет сеть так, чтобы фид читался из памяти. */
async function withFeed<T>(xml: string, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;

  globalThis.fetch = (async () =>
    new Response(xml, {
      headers: { 'content-type': 'application/atom+xml' }
    })) as typeof globalThis.fetch;

  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

describe('RssSourceAdapter: элемент фида', () => {
  it('превращает элемент в запись с ключом sourceId:rawId', async () => {
    const entries = await withFeed(atomFeed(atomItem()), () => adapter({}).fetch());

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.id, 'src:tag:example.org,2026:1');
    assert.equal(entries[0]?.sourceId, 'src');
    assert.equal(entries[0]?.content, 'Текст поста', 'HTML превращён в текст');
  });

  it('переводит даты в ISO — иначе порядок публикации ломается', async () => {
    const entries = await withFeed(atomFeed(atomItem()), () => adapter({}).fetch());

    // В RFC-822 строка "Wed, 30 Sep" сравнивается с датами ЛЕКСИКОГРАФИЧЕСКИ,
    // то есть "29 Jul" оказывался больше "23 Sep" и «последний пост» выбирался
    // неверно.
    assert.equal(entries[0]?.published, '2026-09-30T14:00:16.000Z');
    assert.match(entries[0]?.published ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });

  it('выбрасывает запись без id, заголовка или ссылки', async () => {
    const feed = atomFeed(
      atomItem({ id: undefined }),
      atomItem({ title: undefined }),
      atomItem({ link: undefined }),
      atomItem()
    );

    const entries = await withFeed(feed, () => adapter({}).fetch());

    assert.equal(entries.length, 1, 'осталась только корректная запись');
  });
});

describe('RssSourceAdapter: отсев до разбора', () => {
  it('не разбирает записи из skipIds — экономим запросы к чужому сайту', async () => {
    const counts = { images: 0 };
    const feed = atomFeed(atomItem({ id: 'a' }), atomItem({ id: 'b' }));

    const entries = await withFeed(feed, () =>
      adapter({ counts }).fetch({ skipIds: new Set(['src:a']) })
    );

    assert.equal(counts.images, 1, 'разобран только необработанный пост');
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.id, 'src:b');
  });

  it('skipIds ждёт полный id sourceId:rawId, а не сырой id фида', async () => {
    const counts = { images: 0 };
    const feed = atomFeed(atomItem({ id: 'a' }));

    const entries = await withFeed(feed, () =>
      adapter({ counts }).fetch({ skipIds: new Set(['a']) })
    );

    assert.equal(entries.length, 1, 'сырой id не совпал и пост не отброшен');
    assert.equal(counts.images, 1);
  });

  it('не разбирает записи, не проходящие includeFilter', async () => {
    const counts = { images: 0 };
    const feed = atomFeed(
      atomItem({ id: 'a', title: '[Stable Update] Пакеты' }),
      atomItem({ id: 'b', title: 'Обычная новость' })
    );

    const entries = await withFeed(feed, () =>
      adapter({ counts, includeFilter: '^\\[Stable Update\\]' }).fetch()
    );

    assert.equal(counts.images, 1);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.id, 'src:a');
  });

  it('проверяет includeFilter по заголовку целиком, а не по началу подстроки', async () => {
    const counts = { images: 0 };
    // Описание начинается с совпадения, заголовок — нет. Проверка по
    // «заголовок + описание» нашла бы здесь оба поста.
    const feed = atomFeed(
      atomItem({ id: 'a', title: 'Новость', description: '[Stable Update] в тексте' })
    );

    const entries = await withFeed(feed, () =>
      adapter({ counts, includeFilter: '^\\[Stable Update\\]' }).fetch()
    );

    assert.equal(entries.length, 0);
    assert.equal(counts.images, 0, 'отсев до разбора экономит запрос');
  });

  it('requireImages выбрасывает запись без картинок', async () => {
    const feed = atomFeed(atomItem());
    const noImages: SiteStrategy = {
      images: async () => [],
      description: item => itemHtmlContent(item)
    };

    const withImages = await withFeed(feed, () => adapter({}).fetch());
    assert.equal(withImages.length, 1);

    const without = await withFeed(feed, () =>
      adapter({ strategy: noImages, requireImages: true }).fetch()
    );

    assert.equal(without.length, 0, 'пост без картинки не проходит');
  });
});

describe('RssSourceAdapter: переотправка и fallback-текст', () => {
  it('отдаёт картинки и текст со страницы по прямой ссылке', async () => {
    const sut = adapter({ strategy: countingStrategy({ images: 0 }) });

    assert.deepEqual(await sut.imagesForPost('https://example.org/gallery/1'), [
      'https://example.org/from-page.png'
    ]);
    assert.equal(await sut.postText('https://example.org/gallery/1'), 'текст со страницы');
  });

  it('у стратегии без этих возможностей — пусто, а не ошибка', async () => {
    const sut = adapter({ strategy: PLAIN_SITE_STRATEGY });

    assert.deepEqual(await sut.imagesForPost('https://example.org/1'), []);
    assert.equal(await sut.postText('https://example.org/1'), '');
  });
});

describe('itemEntryId', () => {
  it('собирает полный id из источника и ключа фида', () => {
    assert.equal(itemEntryId('src', atomItem()), 'src:tag:example.org,2026:1');
  });

  it('null, если у элемента нет ни id, ни guid', () => {
    assert.equal(itemEntryId('src', { title: 't' }), null);
  });
});

describe('toIsoDate', () => {
  it('принимает RFC-822 и приводит к UTC', () => {
    assert.equal(toIsoDate('Wed, 30 Sep 2026 17:00:16 +0300'), '2026-09-30T14:00:16.000Z');
  });

  it('уже ISO оставляет без изменений', () => {
    assert.equal(toIsoDate('2026-09-30T14:00:16.000Z'), '2026-09-30T14:00:16.000Z');
  });

  it('мусор и пусто — null, а не выдуманная дата', () => {
    assert.equal(toIsoDate('не дата'), null);
    assert.equal(toIsoDate(''), null);
    assert.equal(toIsoDate(undefined), null);
  });
});

describe('toFeedEntry', () => {
  it('description стратегии проходит через разбор разметки', () => {
    const entry = toFeedEntry('src', atomItem(), {
      images: [],
      description: '<p>Текст <b>поста</b></p>',
      requireImages: false
    });

    assert.equal(entry?.content, 'Текст поста');
  });

  it('раскрывает сущности ровно один раз', () => {
    // Стратегии возвращают разметку, разбор делает адаптер. Если бы стратегия
    // раскрывала HTML сама, адаптер раскрыл бы второй раз — и куски, где
    // автор написал «&lt;b&gt;» буквально, исчезли бы вместе с настоящими
    // тегами. Здесь экранированный угловой виден в тексте поста.
    const entry = toFeedEntry('src', atomItem(), {
      images: [],
      description: '<p>A &amp; B &lt;b&gt;жирный&lt;/b&gt;</p>',
      requireImages: false
    });

    assert.equal(entry?.content, 'A & B <b>жирный</b>');
  });

  it('requireImages без картинок даёт null', () => {
    assert.equal(
      toFeedEntry('src', atomItem(), {
        images: [],
        description: '',
        requireImages: true
      }),
      null
    );
  });
});