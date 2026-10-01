import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';

import {
  fetchImage,
  fetchJson,
  fetchText,
  HttpStatusError,
  isPermanentHttpError,
  isTransientHttpError
} from '../core/http.js';

/**
 * Общий HTTP-слой.
 *
 * Это единственное место в проекте, где живут таймаут, User-Agent и разбор
 * отмены запроса. Здесь проверяется то, на чём держатся все повторы и вся
 * диагностика: понятное сообщение об ошибке вместо `SyntaxError` и сохранённый
 * HTTP-статус, по которому решается «повторять или нет».
 */

const OPTS = { timeoutMs: 1_000, userAgent: 'test-agent' };
const originalFetch = globalThis.fetch;

/** Подмена сети: тесты не должны ходить в интернет. */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = (async (url: string, init: RequestInit) =>
    handler(String(url), init)) as unknown as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('fetchText', () => {
  it('отдаёт тело ответа и шлёт User-Agent', async () => {
    let seen: RequestInit | undefined;

    stubFetch((_url, init) => {
      seen = init;

      return new Response('привет');
    });

    assert.equal(await fetchText('https://example.org', OPTS), 'привет');
    assert.deepEqual(
      (seen?.headers as Record<string, string>)['User-Agent'],
      'test-agent'
    );
  });

  it('ошибка HTTP сохраняет статус — по нему решается повтор', async () => {
    stubFetch(() => new Response('nope', { status: 404, statusText: 'Not Found' }));

    await assert.rejects(fetchText('https://example.org', OPTS), (error: Error) => {
      assert.ok(error instanceof HttpStatusError);
      assert.equal(error.status, 404);
      assert.match(error.message, /HTTP 404 Not Found/);
      assert.match(error.message, /https:\/\/example\.org/);
      return true;
    });
  });

  it('таймаут становится понятной ошибкой, а не AbortError', async () => {
    // Иначе каждый вызывающий код повторял бы одну и ту же проверку
    // `error.name === 'AbortError'` и забывал её в одном месте.
    stubFetch(
      url =>
        new Promise<Response>((_resolve, reject) => {
          setTimeout(
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            5
          ).unref?.();
          void url;
        })
    );

    await assert.rejects(
      fetchText('https://example.org', { timeoutMs: 1, userAgent: 'test' }),
      /Request timeout after 1 ms/
    );
  });
});

describe('fetchJson', () => {
  it('разбирает ответ и отправляет JSON-тело методом POST', async () => {
    let seen: RequestInit | undefined;

    stubFetch((_url, init) => {
      seen = init;

      return new Response(JSON.stringify({ choices: [{ text: 'ок' }] }));
    });

    const data = await fetchJson<{ choices: { text: string }[] }>(
      'https://api.example.org/v1',
      { model: 'm', prompt: 'p' },
      { ...OPTS, headers: { Authorization: 'Bearer key' } }
    );

    assert.equal(data.choices[0]?.text, 'ок');
    assert.equal(seen?.method, 'POST');
    assert.equal(seen?.body, '{"model":"m","prompt":"p"}');
    assert.deepEqual(seen?.headers as Record<string, string>, {
      'Content-Type': 'application/json',
      Authorization: 'Bearer key',
      'User-Agent': 'test-agent'
    });
  });

  it('текст ошибки API попадает в сообщение', async () => {
    // «Access denied by security policy» сразу говорит, что повтор не поможет.
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: { message: 'Access denied' } }), {
          status: 403,
          statusText: 'Forbidden'
        })
    );

    await assert.rejects(fetchJson('https://api.example.org', {}, OPTS), (error: Error) => {
      assert.ok(error instanceof HttpStatusError);
      assert.equal(error.status, 403);
      assert.match(error.message, /Access denied/);
      return true;
    });
  });

  it('HTML вместо JSON называет себя, а не падает SyntaxError', async () => {
    stubFetch(
      () =>
        new Response('<html><body>Gateway</body></html>', {
          status: 200,
          statusText: 'OK'
        })
    );

    await assert.rejects(
      fetchJson('https://api.example.org', {}, OPTS),
      /Expected JSON from https:\/\/api\.example\.org, got: <html>/
    );
  });
});

describe('fetchImage', () => {
  it('отдаёт буфер и MIME-тип без параметров', async () => {
    stubFetch(
      () =>
        new Response(Buffer.from([1, 2, 3]), {
          headers: { 'content-type': 'image/png; charset=binary' }
        })
    );

    const image = await fetchImage('https://example.org/a.png', OPTS);

    assert.deepEqual([...image.buffer], [1, 2, 3]);
    assert.equal(image.contentType, 'image/png');
  });

  it('не принимает не-картинку', async () => {
    stubFetch(() => new Response('<html>', { headers: { 'content-type': 'text/html' } }));

    await assert.rejects(fetchImage('https://example.org/a', OPTS), /Not an image/);
  });

  it('отвергает пустой ответ', async () => {
    // VK всё равно не примет файл нулевого размера, но понятная ошибка
    // попадёт в лог администратора, а не «загрузка прошла, картинки нет».
    stubFetch(() => new Response('', { headers: { 'content-type': 'image/png' } }));

    await assert.rejects(fetchImage('https://example.org/a.png', OPTS), /Image is empty/);
  });

  it('отвергает файл больше потолка', async () => {
    stubFetch(
      () =>
        new Response(Buffer.alloc(26 * 1024 * 1024), {
          headers: { 'content-type': 'image/png' }
        })
    );

    await assert.rejects(fetchImage('https://example.org/a.png', OPTS), /Image is too large/);
  });
});

describe('isPermanentHttpError', () => {
  it('4xx повторять бессмысленно — это битый URL', () => {
    assert.equal(isPermanentHttpError(new HttpStatusError(404, 'x')), true);
    assert.equal(isPermanentHttpError(new HttpStatusError(400, 'x')), true);
  });

  it('408 и 429 сервер просит повторить', () => {
    assert.equal(isPermanentHttpError(new HttpStatusError(408, 'x')), false);
    assert.equal(isPermanentHttpError(new HttpStatusError(429, 'x')), false);
  });

  it('5xx и всё остальное — повторять', () => {
    assert.equal(isPermanentHttpError(new HttpStatusError(500, 'x')), false);
    assert.equal(isPermanentHttpError(new HttpStatusError(503, 'x')), false);
    assert.equal(isPermanentHttpError(new Error('сеть легла')), false);
  });
});
describe('isTransientHttpError', () => {
  it('временные сбои повторяются', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      assert.equal(
        isTransientHttpError(new HttpStatusError(status, 'x')),
        true,
        `${status} временный`
      );
    }
  });

  it('постоянные сбои повторов не получают', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      assert.equal(
        isTransientHttpError(new HttpStatusError(status, 'x')),
        false,
        `${status} постоянный`
      );
    }
  });

  it('обрыв сети и таймаут считаются временными', () => {
    assert.equal(isTransientHttpError(new Error('socket hang up')), true);
  });

  it('что-то не-Error повтором не лечится', () => {
    assert.equal(isTransientHttpError('строка'), false);
    assert.equal(isTransientHttpError(null), false);
  });
});

describe('Retry-After', () => {
  it('читается в секундах', () => {
    assert.equal(new HttpStatusError(429, 'x', '30').retryAfterMs, 30_000);
  });

  it('дробные секунды не округляются вниз', () => {
    assert.equal(new HttpStatusError(429, 'x', '2.5').retryAfterMs, 2_500);
  });

  it('читается как HTTP-дата', () => {
    const future = new Date(Date.now() + 45_000).toUTCString();

    assert.equal(
      new HttpStatusError(503, 'x', future).retryAfterMs !== undefined,
      true,
      'дата в будущем распознана'
    );
  });

  it('дата в прошлом даёт ноль, а не отрицательную задержку', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();

    assert.equal(new HttpStatusError(503, 'x', past).retryAfterMs, 0);
  });

  it('отсутствующий или нечитаемый заголовок даёт undefined', () => {
    assert.equal(new HttpStatusError(429, 'x').retryAfterMs, undefined);
    assert.equal(new HttpStatusError(429, 'x', '').retryAfterMs, undefined);
    assert.equal(new HttpStatusError(429, 'x', 'завтра').retryAfterMs, undefined);
    assert.equal(new HttpStatusError(429, 'x', '-5').retryAfterMs, undefined);
  });
});
