import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SourcePipeline } from '../pipeline/source-pipeline.js';
import type { BotDatabase } from '../db/database.js';
import type { Enricher } from '../core/enricher.js';
import type { SourceAdapter } from '../core/source-adapter.js';
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
  reextractImages?: (id: string, link?: string) => Promise<string[] | null>;
  reextractThrows?: Error;
  hasUpdateMethod?: boolean;
  entry?: FeedEntry;
  captureInfo?: string[];
}) {
  const sent: { message: string; imageUrls: string[] }[] = [];
  const updates: { id: string; imageUrls: string[] }[] = [];
  const warnings: string[] = [];
  const infos: string[] = options.captureInfo ?? [];

  const db = {
    getLatestEntry: () => options.entry ?? STORED,
    markSent: () => undefined,
    updateEntryImages: (id: string, imageUrls: string[]) => {
      updates.push({ id, imageUrls });
    }
  } as unknown as BotDatabase;

  const adapter: SourceAdapter = {
    sourceId: 'screenshots',
    fetch: async () => [],
    ...(options.hasUpdateMethod === false
      ? {}
      : {
          reextractImages: async (id: string, link?: string) => {
            if (options.reextractThrows) {
              throw options.reextractThrows;
            }
            return options.reextractImages
              ? options.reextractImages(id, link)
              : null;
          }
        })
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
    enricher: { enrich: async (e: FeedEntry) => ({ entry: e }) } as Enricher,
    db,
    templates: { render: () => 'текст поста' } as unknown as TemplateManager,
    sender,
    logger: {
      info: (m: string) => infos.push(m),
      warn: (m: string) => warnings.push(m),
      error: () => undefined,
      debug: () => undefined
    } as never,
    targetChat: 1
  });

  return { pipeline, sent, updates, warnings, infos };
}

describe('resendLatest: переизвлечение картинок', () => {
  it('отправляет свежие картинки, а не сохранённые в базе', async () => {
    const h = harness({ reextractImages: async () => FRESH });

    await h.pipeline.resendLatest();

    assert.deepEqual(h.sent[0]?.imageUrls, FRESH);
  });

  it('обновляет запись в базе, чтобы следующий resend тоже был верным', async () => {
    const h = harness({ reextractImages: async () => FRESH });

    await h.pipeline.resendLatest();

    assert.equal(h.updates.length, 1);
    assert.deepEqual(h.updates[0]?.imageUrls, FRESH);
  });

  it('не трогает базу, если картинки не изменились', async () => {
    const h = harness({
      reextractImages: async () => STORED.imageUrls
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
    const h = harness({ reextractImages: async () => [] });

    await h.pipeline.resendLatest();

    assert.deepEqual(
      h.sent[0]?.imageUrls,
      STORED.imageUrls,
      'пустой список не должен отправлять пост без картинок'
    );
  });

  it('пост, выпавший из фида, отправляется по сохранённым данным', async () => {
    const h = harness({ reextractImages: async () => null });

    await h.pipeline.resendLatest();

    assert.deepEqual(h.sent[0]?.imageUrls, STORED.imageUrls);
  });

  it('адаптеру передаётся link: пост старше окна фида ищется по странице', async () => {
    const seen: { id: string; link?: string }[] = [];
    const { pipeline } = harness({
      reextractImages: async (id, link) => {
        seen.push({ id, link });
        return FRESH;
      }
    });

    await pipeline.resendLatest();

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.id, STORED.id);
    assert.equal(
      seen[0]?.link,
      STORED.link,
      'без link адаптер не сможет сходить на страницу поста'
    );
  });

  it('адаптер без reextractImages работает как раньше', async () => {
    const h = harness({ hasUpdateMethod: false });

    await h.pipeline.resendLatest();

    assert.deepEqual(h.sent[0]?.imageUrls, STORED.imageUrls);
  });

  it('в лог попадает число отправленных картинок', async () => {
    const infos: string[] = [];
    const { pipeline } = harness({
      reextractImages: async () => FRESH,
      captureInfo: infos
    });

    await pipeline.resendLatest();

    assert.ok(
      infos.some(line => line.includes('images=2')),
      `в логе должно быть images=2, получено: ${JSON.stringify(infos)}`
    );
  });
});
