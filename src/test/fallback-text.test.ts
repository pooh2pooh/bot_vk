import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SourcePipeline } from '../pipeline/source-pipeline.js';
import type { BotDatabase } from '../db/database.js';
import type { Enricher } from '../core/enricher.js';
import type { SourceAdapter } from '../core/source-adapter.js';
import type { FeedEntry } from '../core/types.js';
import type { TemplateManager } from '../templates/manager.js';
import type { VKSender } from '../vk/sender.js';

/**
 * Откат на текст источника, когда генерация не удалась.
 *
 * Отдельный файл, а не часть тестов пайплайна: проверяется граница обрезки
 * финального текста сообщения. Обрезанный многоточием текст автора в 200
 * символов уходил в чат, и пользователю было непонятно, что пост не целиком.
 */

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
  textLimit?: number;
  pageText?: string;
  textMode?: 'feed' | 'feedFull' | 'generated';
}) {
  const rendered: string[] = [];

  const db = {
    // `resendLatest` берёт первую запись списка, а не отдельный запрос.
    listEntries: () => [{ entry: options.entry ?? entry(), state: 'sent' }],
    markSent: () => undefined,
    updateEntryImages: () => undefined
  } as unknown as BotDatabase;

  const adapter: SourceAdapter = {
    sourceId: 'pingvinus',
    fetch: async () => [],
    imagesForPost: async () => [],
    postText: async () => options.pageText ?? ''
  };

  const enricher: Enricher = {
    enrich: async (e: FeedEntry) => {
      if (options.enrichFails) {
        throw new Error('ИИ не ответил');
      }

      return { entry: { ...e, content: 'Комментарий ИИ' } };
    }
  };

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
    sender: {
      send: async () => undefined,
      consumeImageErrors: () => []
    } as unknown as VKSender,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined
    } as never,
    targetChat: 1,
    textMode: options.textMode ?? 'feed',
    textLimit: options.textLimit ?? 200
  });

  return { pipeline, rendered };
}

describe('откат на текст источника', () => {
  it('укорачивает текст автора до textLimit', async () => {
    const h = harness({ enrichFails: true, textLimit: 200 });

    await h.pipeline.resendLatest();

    const content = h.rendered[0] ?? '';
    assert.equal(content.length <= 200, true, `длина ${content.length}`);
  });

  it('режет по границе слова и ставит многоточие', async () => {
    const h = harness({ enrichFails: true, textLimit: 200 });

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
    const h = harness({ enrichFails: true, textLimit: 200, entry: entry({ content: short }) });

    await h.pipeline.resendLatest();

    assert.equal(h.rendered[0], short);
  });

  it('feedFull отдаёт текст автора целиком', async () => {
    const h = harness({
      enrichFails: true,
      textMode: 'feedFull',
      textLimit: 200,
      entry: entry()
    });

    await h.pipeline.resendLatest();

    assert.equal(h.rendered[0], LONG_TEXT);
  });

  it('берёт текст со страницы, если в фиде он пустой', async () => {
    // У pingvinus описание в RSS пустое: без этого ушёл бы один заголовок.
    const fromPage = 'Текст прямо со страницы поста, которого нет в RSS.';
    const h = harness({
      enrichFails: true,
      textLimit: 200,
      pageText: fromPage,
      entry: entry({ content: '' })
    });

    await h.pipeline.resendLatest();

    assert.equal(h.rendered[0], fromPage);
  });

  it('ошибка получения текста не отменяет отправку', async () => {
    const h = harness({
      enrichFails: true,
      textLimit: 200,
      entry: entry({ content: '' })
    });

    await h.pipeline.resendLatest();

    assert.equal(h.rendered.length, 1, 'пост всё равно должен уйти');
    assert.equal((h.rendered[0] ?? '').length, 0);
  });

  it('при успешной генерации текст автора не используется', async () => {
    const h = harness({
      enrichFails: false,
      textMode: 'generated',
      textLimit: 200,
      entry: entry()
    });

    await h.pipeline.resendLatest();

    assert.equal(h.rendered[0], 'Комментарий ИИ');
  });

  it('успешная генерация не обрезается textLimit', async () => {
    // Лимит в конфиге ограничивает ТЕКСТ ИСТОЧНИКА. Обрезать сгенерированный
    // текст значило бы выкинуть половину смысла, за который модель заплатила.
    const h = harness({
      enrichFails: false,
      textMode: 'generated',
      textLimit: 20,
      entry: entry()
    });

    await h.pipeline.resendLatest();

    assert.equal(h.rendered[0], 'Комментарий ИИ');
  });
});