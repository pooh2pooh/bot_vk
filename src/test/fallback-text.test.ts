import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SourcePipeline } from '../pipeline/source-pipeline.js';
import type { BotDatabase } from '../db/database.js';
import type { Enricher } from '../core/enricher.js';
import type { SourceAdapter } from '../core/source-adapter.js';
import type { FeedEntry } from '../core/types.js';
import type { TemplateManager } from '../templates/manager.js';
import type { VKSender } from '../vk/sender.js';

const LONG_TEXT =
  'Первый абзац поста описывает, что вообще происходило и почему это важно. ' +
  'Второй абзац продолжает рассуждение и добавляет деталей. ' +
  'Третий абзац всё ещё продолжается и не собирается заканчиваться. ' +
  'Четвёртый абзац — вот тут текст точно переваливает за двести символов.';

function entry(over: Partial<FeedEntry> = {}): FeedEntry {
  return {
    id: 'pingvinus:https://pingvinus.ru/gallery/5532',
    sourceId: 'pingvinus',
    title: 'Enlightenment E27',
    link: 'https://pingvinus.ru/gallery/5532',
    author: 'автор',
    content: LONG_TEXT,
    published: '2026-09-29T11:23:20.000Z',
    updated: '2026-09-29T11:23:20.000Z',
    imageUrls: ['https://pingvinus.ru/cr_images/userpicture/n/5532-0.jpg'],
    ...over
  };
}

function harness(options: {
  entry?: FeedEntry;
  enrichFails?: boolean;
  fallbackTextLimit?: number;
  fetchOriginalText?: (link: string) => Promise<string>;
  textFetchThrows?: Error;
}) {
  const rendered: string[] = [];

  const db = {
    getLatestEntry: () => options.entry ?? entry(),
    markSent: () => undefined
  } as unknown as BotDatabase;

  const adapter: SourceAdapter = {
    sourceId: 'pingvinus',
    fetch: async () => [],
    reextractImages: async () => null
  };

  const enricher: Enricher = {
    enrich: async (e: FeedEntry) => {
      if (options.enrichFails) {
        throw new Error('ИИ не ответил');
      }

      return { entry: { ...e, content: 'Комментарий ИИ' } };
    }
  };

  const sender = {
    send: async () => undefined,
    consumeImageErrors: () => []
  } as unknown as VKSender;

  const pipeline = new SourcePipeline({
    sourceId: 'pingvinus',
    sourceName: 'pingvinus',
    adapter,
    enricher,
    db,
    templates: {
      // Шаблон получает content уже готовым к подстановке.
      render: (_id: string, data: { content: string }) => {
        rendered.push(data.content);
        return data.content;
      }
    } as unknown as TemplateManager,
    sender,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined
    } as never,
    targetChat: 1,
    fallbackTextLimit: options.fallbackTextLimit,
    fetchOriginalText: options.fetchOriginalText
  });

  return { pipeline, rendered };
}

describe('fallback, когда AI не ответил', () => {
  it('укорачивает текст автора до лимита', async () => {
    const h = harness({
      enrichFails: true,
      fallbackTextLimit: 200,
      entry: entry()
    });

    await h.pipeline.resendLatest();

    const content = h.rendered[0] ?? '';
    assert.equal(content.length <= 200, true, `длина ${content.length}`);
  });

  it('режет по границе слова и ставит многоточие', async () => {
    const h = harness({
      enrichFails: true,
      fallbackTextLimit: 200,
      entry: entry()
    });

    await h.pipeline.resendLatest();

    const content = h.rendered[0] ?? '';
    assert.equal(content.endsWith('…'), true);
    assert.equal(
      /\s$/.test(content.slice(0, -1)),
      false,
      'перед многоточием не должно оставаться пробела'
    );
  });

  it('не трогает текст, если он короче лимита', async () => {
    const short = 'Короткий текст поста.';
    const h = harness({
      enrichFails: true,
      fallbackTextLimit: 200,
      entry: entry({ content: short })
    });

    await h.pipeline.resendLatest();

    assert.equal(h.rendered[0], short);
  });

  it('берёт текст со страницы, если в фиде он пустой', async () => {
    const fromPage = 'Текст прямо со страницы поста, которого нет в RSS.';
    const seen: string[] = [];
    const h = harness({
      enrichFails: true,
      fallbackTextLimit: 200,
      fetchOriginalText: async link => {
        seen.push(link);
        return fromPage;
      },
      entry: entry({ content: '' })
    });

    await h.pipeline.resendLatest();

    assert.deepEqual(seen, ['https://pingvinus.ru/gallery/5532']);
    assert.equal(h.rendered[0], fromPage);
  });

  it('ошибка получения текста не отменяет отправку', async () => {
    const h = harness({
      enrichFails: true,
      fallbackTextLimit: 200,
      fetchOriginalText: async () => {
        throw new Error('сеть легла');
      },
      entry: entry({ content: '' })
    });

    await h.pipeline.resendLatest();

    assert.equal(h.rendered.length, 1, 'пост всё равно должен уйти');
    assert.equal((h.rendered[0] ?? '').length, 0);
  });

  it('без fallbackTextLimit текст не укорачивается', async () => {
    const h = harness({ enrichFails: true, entry: entry() });

    await h.pipeline.resendLatest();

    assert.equal(h.rendered[0], LONG_TEXT);
  });

  it('при успешном ИИ текст автора не используется', async () => {
    const h = harness({ enrichFails: false, fallbackTextLimit: 200, entry: entry() });

    await h.pipeline.resendLatest();

    assert.equal(h.rendered[0], 'Комментарий ИИ');
  });
});
