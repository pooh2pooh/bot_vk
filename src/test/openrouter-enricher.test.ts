/**
 * OpenRouterEnricher: повторы при временных сбоях и поведение без них.
 *
 * Enricher шёл в сеть при каждом посте и падал на первом же 429, поэтому пост
 * уходил с текстом автора навсегда. Эти тесты фиксируют границу: временный
 * сбой повторяется, постоянный — нет, исчерпание повторов пробрасывается.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { FeedEntry } from '../core/types.js';
import { OpenRouterEnricher } from '../enrich/openrouter-enricher.js';

const ENTRY: FeedEntry = {
  id: 'lor:1',
  sourceId: 'lor',
  title: 'Заголовок поста',
  link: 'https://www.linux.org.ru/news/1',
  author: 'Автор',
  content: 'Текст поста для пересказа.',
  published: '2026-10-01T12:00:00.000Z',
  updated: '2026-10-01T12:00:00.000Z',
  imageUrls: []
};

const originalFetch = globalThis.fetch;

/** Задержки фиксируются вместо реального ожидания. */
function createEnricher(handler: () => Response | Promise<Response>): {
  enricher: OpenRouterEnricher;
  delays: number[];
} {
  const delays: number[] = [];

  const enricher = new OpenRouterEnricher({
    apiKey: 'test-key',
    model: 'test/model:free',
    modelName: 'Тестовая модель',
    timeoutMs: 1_000,
    maxTokens: 100,
    maxAttempts: 3,
    retryDelayMs: 100,
    sleep: async ms => {
      delays.push(ms);
    }
  });

  globalThis.fetch = (async () => handler()) as unknown as typeof globalThis.fetch;

  return { enricher, delays };
}

function rateLimited(retryAfter?: string): Response {
  return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
    status: 429,
    statusText: 'Too Many Requests',
    headers: retryAfter ? { 'retry-after': retryAfter } : {}
  });
}

function answer(content: string, finishReason = 'stop'): Response {
  return new Response(
    JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('повторы при временном сбое', () => {
  it('повторяет 429 и отдаёт сгенерированный текст без fallback', async () => {
    let calls = 0;
    const { enricher, delays } = createEnricher(() => {
      calls++;

      return calls < 3 ? rateLimited() : answer('Сгенерированный текст');
    });

    await enricher.loadPrompt('templates/ai_comment.txt');
    const result = await enricher.enrich(ENTRY);

    assert.equal(calls, 3, 'два отказа и третий успешный ответ');
    assert.equal(result.entry.content, 'Сгенерированный текст');
    assert.equal(result.entry.author, 'Тестовая модель');
    assert.equal(delays.length, 2, 'ожидание только между попытками');
  });

  it('уважает Retry-After: серверный ответ главнее своей задержки', async () => {
    let calls = 0;
    const { enricher, delays } = createEnricher(() => {
      calls++;

      return calls === 1 ? rateLimited('7') : answer('Текст');
    });

    await enricher.loadPrompt('templates/ai_comment.txt');
    await enricher.enrich(ENTRY);

    assert.deepEqual(delays, [7_000], 'Retry-After: 7 секунд');
  });

  it('не ждёт дольше потолка, даже если сервер просит час', async () => {
    let calls = 0;
    const { enricher, delays } = createEnricher(() => {
      calls++;

      return calls === 1 ? rateLimited('3600') : answer('Текст');
    });

    await enricher.loadPrompt('templates/ai_comment.txt');
    await enricher.enrich(ENTRY);

    assert.deepEqual(delays, [15_000], 'минута превращается в 15 секунд');
  });

  it('своя задержка растёт, если сервер не прислал Retry-After', async () => {
    let calls = 0;
    const { enricher, delays } = createEnricher(() => {
      calls++;

      return calls < 3 ? rateLimited() : answer('Текст');
    });

    await enricher.loadPrompt('templates/ai_comment.txt');
    await enricher.enrich(ENTRY);

    assert.deepEqual(delays, [100, 200], 'попытка × базовая задержка');
  });

  it('исчерпание попыток пробрасывает ошибку, а не возвращает пустой текст', async () => {
    const { enricher } = createEnricher(() => rateLimited());

    await enricher.loadPrompt('templates/ai_comment.txt');

    await assert.rejects(() => enricher.enrich(ENTRY), /429/);
  });
});

describe('постоянные сбои повторов не получают', () => {
  for (const status of [400, 401, 403, 404]) {
    it(`${status} — одна попытка и без задержек`, async () => {
      let calls = 0;
      const { enricher, delays } = createEnricher(() => {
        calls++;

        return new Response(JSON.stringify({ error: { message: 'nope' } }), {
          status,
          statusText: 'error'
        });
      });

      await enricher.loadPrompt('templates/ai_comment.txt');

      await assert.rejects(() => enricher.enrich(ENTRY), new RegExp(String(status)));
      assert.equal(calls, 1, 'битый ключ не выжигает лимит запросов');
      assert.deepEqual(delays, [], 'ждать нечего');
    });
  }

  it('maxAttempts: 1 отключает повторы полностью', async () => {
    let calls = 0;
    const delays: number[] = [];

    const enricher = new OpenRouterEnricher({
      apiKey: 'test-key',
      model: 'test/model:free',
      modelName: 'Тестовая модель',
      timeoutMs: 1_000,
      maxTokens: 100,
      maxAttempts: 1,
      sleep: async ms => {
        delays.push(ms);
      }
    });

    globalThis.fetch = (async () => {
      calls++;

      return rateLimited();
    }) as unknown as typeof globalThis.fetch;

    await enricher.loadPrompt('templates/ai_comment.txt');

    await assert.rejects(() => enricher.enrich(ENTRY), /429/);
    assert.equal(calls, 1);
    assert.deepEqual(delays, []);
  });
});

describe('повтор при сбое и починка ответа не мешают друг другу', () => {
  it('сначала 429, потом обрезанный ответ, и только затем починка', async () => {
    const calls: string[] = [];
    const { enricher, delays } = createEnricher(() => {
      const step = calls.length;

      calls.push(String(step));

      if (step === 0) {
        return rateLimited();
      }

      if (step === 1) {
        return answer('Обрезанный пос', 'length');
      }

      return answer('Итоговый текст', 'stop');
    });

    await enricher.loadPrompt('templates/ai_comment.txt');
    const result = await enricher.enrich(ENTRY);

    assert.equal(result.entry.content, 'Итоговый текст');
    assert.equal(calls.length, 3, 'повтор после 429, затем запрос на починку');
    assert.deepEqual(delays, [100], 'ожидание было только у повтора после 429');
  });

  it('починка тоже повторяется, если провайдер её отклонил по лимиту', async () => {
    let calls = 0;
    const { enricher } = createEnricher(() => {
      calls++;

      if (calls === 1) {
        return answer('Обрезанный пос', 'length');
      }

      return calls === 2 ? rateLimited() : answer('Итоговый текст', 'stop');
    });

    await enricher.loadPrompt('templates/ai_comment.txt');
    const result = await enricher.enrich(ENTRY);

    assert.equal(result.entry.content, 'Итоговый текст');
    assert.equal(calls, 3, 'исходный ответ, 429, повтор починки');
  });
});
