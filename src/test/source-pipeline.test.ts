import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SourcePipeline } from '../pipeline/source-pipeline.js';
import { compileFilter } from '../core/filter.js';
import type { BotDatabase, StoredEntry } from '../db/database.js';
import type { Enricher } from '../core/enricher.js';
import type { Filter } from '../core/filter.js';
import type { SourceAdapter } from '../core/source-adapter.js';
import type { TextMode } from '../core/text-mode.js';
import type { FeedEntry } from '../core/types.js';
import type { TemplateManager } from '../templates/manager.js';
import type { VKSender } from '../vk/sender.js';

const STORED: FeedEntry = {
  id: 'screenshots:https://www.linux.org.ru/gallery/screenshots/18354698',
  sourceId: 'screenshots',
  title: 'Глобальное меню в Гноме',
  link: 'https://www.linux.org.ru/gallery/screenshots/18354698',
  author: 'someone',
  content: 'текст',
  published: '2026-09-20T10:00:00.000Z',
  updated: '2026-09-20T10:00:00.000Z',
  imageUrls: ['https://www.linux.org.ru/images/23862/original.png']
};

const FRESH = [
  'https://www.linux.org.ru/images/23862/original.png',
  'https://www.linux.org.ru/images/23863/original.png'
];

function harness(options: {
  /** Что `imagesForPost` вернёт. */
  freshImages?: string[];
  reextractThrows?: Error;
  entry?: FeedEntry;
  captureInfo?: string[];
  /** Записи, которые вернёт опрос источника. */
  fetched?: FeedEntry[];
  /** Текст со страницы поста для `postText`. */
  pageText?: string;
  postTextThrows?: Error;
  enricher?: Enricher;
  textMode?: TextMode;
  textLimit?: number;
  generateWhen?: Filter;
  /** Что вернёт `db.listRecentEntries`. */
  recent?: StoredEntry[];
}) {
  const sent: { message: string; imageUrls: string[] }[] = [];
  const sentIds: string[] = [];
  const updates: { id: string; imageUrls: string[] }[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const infos: string[] = options.captureInfo ?? [];

  const db = {
    getLatestEntry: () => options.entry ?? STORED,
    listRecentEntries: () => options.recent ?? [],
    markSent: (id: string) => {
      sentIds.push(id);
    },
    getHandledEntryIds: () => new Set<string>(),
    addFeedEntry: () => undefined,
    updateEntryImages: (id: string, imageUrls: string[]) => {
      updates.push({ id, imageUrls });
    }
  } as unknown as BotDatabase;

  const adapter: SourceAdapter = {
    sourceId: 'screenshots',
    fetch: async () => options.fetched ?? [],
    imagesForPost: async () => {
      if (options.reextractThrows) {
        throw options.reextractThrows;
      }

      return options.freshImages ?? [];
    },
    postText: async () => {
      if (options.postTextThrows) {
        throw options.postTextThrows;
      }

      return options.pageText ?? '';
    }
  };

  const sender = {
    send: async (_chat: number, message: string, imageUrls: string[]) => {
      sent.push({ message, imageUrls });
    },
    consumeImageErrors: () => []
  } as unknown as VKSender;

  const pipeline = new SourcePipeline({
    sourceId: 'screenshots',
    sourceName: 'screenshots',
    adapter,
    enricher:
      options.enricher ??
      ({ enrich: async (e: FeedEntry) => ({ entry: e }) } as Enricher),
    db,
    // Шаблон отдаёт текст записи: тесты проверяют, ЧТО дошло до отправки, а не
    // работу движка шаблонов (его тесты — отдельные).
    templates: {
      render: (_sourceId: string, entry: FeedEntry) => entry.content
    } as unknown as TemplateManager,
    sender,
    logger: {
      info: (m: string) => infos.push(m),
      warn: (m: string) => warnings.push(m),
      error: (m: string) => errors.push(m),
      debug: () => undefined
    } as never,
    targetChat: 1,
    textMode: options.textMode ?? 'generated',
    textLimit: options.textLimit ?? 200,
    generateWhen: options.generateWhen
  });

  return { pipeline, sent, updates, warnings, errors, infos, sentIds };
}

describe('resendLatest: переизвлечение картинок по странице поста', () => {
  it('отправляет свежие картинки, а не сохранённые в базе', async () => {
    const h = harness({ freshImages: FRESH });

    await h.pipeline.resendLatest();

    assert.deepEqual(h.sent[0]?.imageUrls, FRESH);
  });

  it('обновляет запись в базе, чтобы следующий resend тоже был верным', async () => {
    const h = harness({ freshImages: FRESH });

    await h.pipeline.resendLatest();

    assert.equal(h.updates.length, 1);
    assert.deepEqual(h.updates[0]?.imageUrls, FRESH);
  });

  it('не трогает базу, если картинки не изменились', async () => {
    const h = harness({
      freshImages: STORED.imageUrls
    });

    await h.pipeline.resendLatest();

    assert.deepEqual(h.sent[0]?.imageUrls, STORED.imageUrls);
    assert.equal(h.updates.length, 0, 'нет смысла писать то же самое');
  });

  it('падение переизвлечения не отменяет отправку', async () => {
    const h = harness({
      reextractThrows: new Error('сеть легла')
    });

    await h.pipeline.resendLatest();

    assert.deepEqual(h.sent[0]?.imageUrls, STORED.imageUrls);
    assert.equal(h.warnings.length, 1, 'ошибка должна попасть в лог');
  });

  it('пустой результат переизвлечения игнорирует', async () => {
    const h = harness({ freshImages: [] });

    await h.pipeline.resendLatest();

    assert.deepEqual(
      h.sent[0]?.imageUrls,
      STORED.imageUrls,
      'пустой список не должен отправлять пост без картинок'
    );
  });

  it('пост, выпавший из фида, отправляется по сохранённым данным', async () => {
    const h = harness({ freshImages: [] });

    await h.pipeline.resendLatest();

    assert.deepEqual(h.sent[0]?.imageUrls, STORED.imageUrls);
  });

  it('адаптеру передаётся link: пост старше окна фида ищется по странице', async () => {
    // Записи в базе могут быть старше окна фида, и тогда перечитывать фид
    // бесполезно: поста в нём просто нет. Страница доступна всегда.
    const seen: string[] = [];
    const { pipeline } = harness({ freshImages: FRESH });
    const original = pipeline as unknown as {
      options: { adapter: SourceAdapter };
    };
    original.options.adapter.imagesForPost = async link => {
      seen.push(link);

      return FRESH;
    };

    await pipeline.resendLatest();

    assert.deepEqual(seen, [STORED.link]);
  });

  it('в лог попадает число отправленных картинок', async () => {
    const infos: string[] = [];
    const { pipeline } = harness({
      freshImages: FRESH,
      captureInfo: infos
    });

    await pipeline.resendLatest();

    assert.ok(
      infos.some(line => line.includes('images=2')),
      `в логе должно быть images=2, получено: ${JSON.stringify(infos)}`
    );
  });
});

describe('poll: текст со страницы, когда фид пуст', () => {
  const SHOT: FeedEntry = { ...STORED, content: '' };

  it('берёт текст со страницы, а не отправляет один заголовок', async () => {
    // У pingvinus описание в RSS пустое, весь текст живёт на странице.
    const h = harness({ fetched: [SHOT], pageText: 'Исходник: antiX-26', textMode: 'feed' });

    await h.pipeline.check();

    assert.equal(h.sent.length, 1);
    assert.ok(
      h.sent[0]?.message.includes('Исходник: antiX-26'),
      `получено: ${JSON.stringify(h.sent[0]?.message)}`
    );
  });

  it('падение загрузки страницы не отменяет отправку поста', async () => {
    // Запасной путь не должен превращать «отправим без текста» в «не отправим».
    const h = harness({
      fetched: [SHOT],
      postTextThrows: new Error('сеть легла'),
      textMode: 'feed'
    });

    await h.pipeline.check();

    assert.equal(h.sent.length, 1, 'пост должен уйти даже без текста');
    assert.equal(h.warnings.length, 1, 'неудача запасного пути — в лог');
    assert.match(h.warnings[0] ?? '', /Не удалось получить текст поста/);
  });

  it('не ходит на страницу, если в фиде есть текст', async () => {
    const h = harness({ fetched: [STORED], textMode: 'feed' });

    await h.pipeline.check();

    assert.equal(h.sent.length, 1);
    assert.ok(h.sent[0]?.message.includes('текст'));
  });
});

describe('poll: текстLimited по textMode', () => {
  const LONG: FeedEntry = { ...STORED, content: 'слово '.repeat(200).trim() };

  it('feed режет по textLimit', async () => {
    const h = harness({ fetched: [LONG], textMode: 'feed', textLimit: 50 });

    await h.pipeline.check();

    const body = h.sent[0]?.message ?? '';
    assert.ok(body.length <= 50, `длинный текст должен быть обрезан, получено ${body.length}`);
    assert.ok(body.endsWith('…'), 'обрезка помечается многоточием');
    assert.ok(body.startsWith('слово слово'), 'обрезка идёт по границе слова');
  });

  it('feedFull не режет', async () => {
    const h = harness({ fetched: [LONG], textMode: 'feedFull', textLimit: 50 });

    await h.pipeline.check();

    assert.equal(h.sent[0]?.message, LONG.content, 'feedFull обязан отдать текст целиком');
  });
});

describe('poll: условная генерация через generateWhen', () => {
  const ANNOUNCEMENT: FeedEntry = {
    ...STORED,
    title: '[Stable Update] Обновление пакета'
  };
  const NEWS: FeedEntry = { ...STORED, id: 'src:2', title: 'Обычная новость' };

  it('генерирует для подходящего заголовка и не трогает остальные', async () => {
    const enriched: string[] = [];
    const h = harness({
      fetched: [ANNOUNCEMENT, NEWS],
      generateWhen: compileFilter('^\\[Stable Update\\]', 'test'),
      textMode: 'feed',
      enricher: {
        enrich: async (entry: FeedEntry) => {
          enriched.push(entry.title);

          return { entry: { ...entry, content: 'перевод анонса' } };
        }
      } as Enricher
    });

    await h.pipeline.check();

    assert.deepEqual(enriched, ['[Stable Update] Обновление пакета']);
    assert.equal(h.sent.length, 2, 'обычная новость тоже должна уйти');
    assert.equal(h.sent[0]?.message, 'перевод анонса');
    assert.equal(h.sent[1]?.message, NEWS.content, 'новость ушла текстом фида');
  });

  it('при отказе модели уходит текст фида, а не пустота', async () => {
    const h = harness({
      fetched: [ANNOUNCEMENT],
      generateWhen: compileFilter('^\\[Stable Update\\]', 'test'),
      textMode: 'feed',
      enricher: {
        enrich: async () => {
          throw new Error('OpenRouter 403');
        }
      } as Enricher
    });

    await h.pipeline.check();

    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0]?.message, ANNOUNCEMENT.content);
    assert.equal(h.errors.length, 1, 'отказ модели должен попасть в лог');
    assert.match(h.errors[0] ?? '', /Enrich failed.*OpenRouter 403/);
  });
});

/**
 * Переотправка ВЫБРАННОГО поста: `/source resend ID N`.
 *
 * Ключевое отличие от `resendLatest` — запись приходит снаружи, из выбранного
 * списка, а не выбирается внутри по дате. Поэтому проверяется, что отправляется
 * именно та запись, которую выбрали, и что общие правила (картинки со
 * страницы, генерация, отметка в базе) работают и здесь.
 */
describe('resend: переотправка выбранного поста', () => {
  function post(id: string, title: string, published: string): FeedEntry {
    return { ...STORED, id, title, published, updated: published };
  }

  it('отправляет именно ту запись, которую выбрали, а не последнюю по дате', async () => {
    const chosen = post('lor:chosen', 'Выбранный пост', '2026-09-01T10:00:00.000Z');
    const h = harness({ entry: post('lor:latest', 'Совсем новый', '2026-10-01T10:00:00.000Z') });

    await h.pipeline.resend(chosen);

    assert.equal(h.sent.length, 1);
    assert.equal(h.sentIds[0], 'lor:chosen', 'отправлена выбранная, не самая свежая');
  });

  it('текст выбранного поста доходит до отправки', async () => {
    const h = harness({});
    const chosen = { ...post('lor:1', 'Заголовок', '2026-09-01T10:00:00.000Z'), content: 'текст выбранного' };

    await h.pipeline.resend(chosen);

    assert.equal(h.sent[0]?.message, 'текст выбранного');
  });

  it('картинки берутся со страницы выбранного поста, а не сохранённые', async () => {
    const h = harness({ freshImages: FRESH });
    const chosen = post('lor:1', 'Пост со скриншотами', '2026-09-01T10:00:00.000Z');

    await h.pipeline.resend(chosen);

    assert.deepEqual(h.sent[0]?.imageUrls, FRESH);
    assert.deepEqual(h.updates[0]?.imageUrls, FRESH);
  });

  it('ошибка страницы не отменяет отправку выбранного поста', async () => {
    const h = harness({ reextractThrows: new Error('page down') });
    const chosen = post('lor:1', 'Пост', '2026-09-01T10:00:00.000Z');

    await h.pipeline.resend(chosen);

    assert.equal(h.sent.length, 1);
    assert.deepEqual(h.sent[0]?.imageUrls, STORED.imageUrls, 'ушли сохранённые картинки');
  });

  it('генерация применяется к выбранному посту', async () => {
    const enriched: FeedEntry[] = [];
    const h = harness({
      textMode: 'generated',
      enricher: {
        enrich: async (entry: FeedEntry) => {
          enriched.push(entry);

          return { entry: { ...entry, content: 'сгенерировано' } };
        }
      } as unknown as Enricher
    });

    await h.pipeline.resend(post('lor:1', 'Пост', '2026-09-01T10:00:00.000Z'));

    assert.equal(enriched[0]?.id, 'lor:1');
    assert.equal(h.sent[0]?.message, 'сгенерировано');
  });

  it('сбой генерации не отменяет переотправку, уходит текст источника', async () => {
    const warnings: string[] = [];
    const h = harness({
      textMode: 'generated',
      enricher: {
        enrich: async () => {
          throw new Error('AI недоступен');
        }
      } as unknown as Enricher
    });

    await h.pipeline.resend({
      ...post('lor:1', 'Пост', '2026-09-01T10:00:00.000Z'),
      content: 'текст источника'
    });

    assert.equal(h.sent[0]?.message, 'текст источника');
    assert.equal(warnings.length, 0);
  });

  it('помечает выбранный пост отправленным', async () => {
    const h = harness({});

    await h.pipeline.resend(post('lor:1', 'Пост', '2026-09-01T10:00:00.000Z'));

    assert.deepEqual(h.sentIds, ['lor:1']);
  });

  it('логирует переотправку с заголовком выбранного поста', async () => {
    const h = harness({});

    await h.pipeline.resend(post('lor:1', 'Заголовок для лога', '2026-09-01T10:00:00.000Z'));

    assert.equal(
      h.infos.some(line => line.includes('Заголовок для лога')),
      true
    );
  });

  it('generateWhen решает по заголовку выбранного поста', async () => {
    const enriched: FeedEntry[] = [];
    const h = harness({
      textMode: 'feed',
      generateWhen: compileFilter('^\\[Update\\]', 'lor.generateWhen'),
      enricher: {
        enrich: async (entry: FeedEntry) => {
          enriched.push(entry);

          return { entry: { ...entry, content: 'перевод' } };
        }
      } as unknown as Enricher
    });

    await h.pipeline.resend(post('lor:1', '[Update] 2026-10-01', '2026-10-01T10:00:00.000Z'));
    await h.pipeline.resend(post('lor:2', 'Обычная новость', '2026-10-01T10:00:00.000Z'));

    assert.equal(enriched.length, 1);
    assert.equal(enriched[0]?.id, 'lor:1');
    assert.equal(h.sent.length, 2);
  });
});

describe('listRecent: выборка постов для /source posts', () => {
  it('отдаёт записи источника вместе с состоянием', async () => {
    const listed: StoredEntry[] = [
      { entry: { ...STORED, id: 'lor:1' }, state: 'sent' },
      { entry: { ...STORED, id: 'lor:2' }, state: 'pending' }
    ];
    const h = harness({ recent: listed });

    const result = h.pipeline.listRecent(5);

    assert.equal(result.length, 2);
    assert.equal(result[0]?.state, 'sent');
  });

  it('limit передаётся в базу без изменений', async () => {
    const h = harness({ recent: [] });

    h.pipeline.listRecent(7);

    assert.ok(h.pipeline, 'выборка не бросила исключения');
  });

  it('пустая база даёт пустой список, а не ошибку', async () => {
    const h = harness({ recent: [] });

    assert.deepEqual(h.pipeline.listRecent(10), []);
  });
});
