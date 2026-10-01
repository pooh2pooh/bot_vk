import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { VKSender } from '../vk/sender.js';

/**
 * Повторы загрузки картинок.
 *
 * Ошибки картинок НЕ отменяют отправку сообщения: пост с одним экраном лучше,
 * чем никакого поста. Но молчаливая потеря картинки тоже недопустима, поэтому
 * отправитель копит ошибки, и планер оповещает о них администратора.
 */

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

