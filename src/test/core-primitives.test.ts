import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BoundedCache } from '../core/bounded-cache.js';
import he from 'he';

import { createImageUrlMatcher, imagePath } from '../core/image-url.js';
import { stripDecodedMarkup, toPlainText, truncateText } from '../core/text.js';

/**
 * Примитивы core/: кеш и текст. Здесь же проверяется то, что молча портило бы
 * сообщения — обрезка по границе слова и разбор сущностей.
 */

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

describe('toPlainText', () => {
  it('раскрывает сущности и убирает неразрывные пробелы', () => {
    assert.equal(
      toPlainText('a&nbsp;b &mdash; c &amp; d'),
      'a b — c & d'
    );
  });

  it('ставит перенос и по открывающим блочным тегам', () => {
    // Только закрывающих тегов было мало: заголовок склеивался с текстом.
    assert.equal(
      toPlainText('<h2>Предыстория</h2><p>Текст</p>'),
      'Предыстория\n\nТекст'
    );
  });

  it('не раскрывает сущности второй раз', () => {
    // Текст, где автор написал «&lt;b&gt;» буквально. Второе раскрытие
    // превратило бы его в настоящий тег, и он был бы вырезан вместе с
    // разметкой — потерялся бы кусок текста поста.
    const alreadyDecoded = he.decode('&amp;lt;b&amp;gt;жирный&amp;lt;/b&amp;gt;');

    // Сущности остались сущностями: повторного раскрытия не было, и «теги»,
    // написанные автором буквально, не вырезались как настоящая разметка.
    assert.equal(stripDecodedMarkup(alreadyDecoded), '&lt;b&gt;жирный&lt;/b&gt;');
  });
});

describe('truncateText', () => {
  it('короче лимита — возвращается как есть', () => {
    assert.equal(truncateText('коротко', 100), 'коротко');
  });

  it('режет по границе слова, а не по полуслове', () => {
    const result = truncateText('одно два три четыре пять', 12);

    assert.ok(result.endsWith('…'), 'многоточие означает обрезку');
    assert.ok(!result.includes('три ч'), 'слово не разрезано');
  });

  it('без пробела режет жёстко и не зацикливается', () => {
    // Один длинный токен (например URL) обязан обрезаться, иначе цикл искал
    // бы последний пробел вечно.
    const result = truncateText('x'.repeat(50), 10);

    assert.equal(result.length, 10);
  });

  it('не добавляет многоточие, если обрезки не было', () => {
    const text = 'ровно десять';

    assert.equal(truncateText(text, text.length), text);
  });
});

describe('imagePath', () => {
  const rule = createImageUrlMatcher({
    baseUrl: 'https://pingvinus.ru',
    hostnames: ['pingvinus.ru'],
    pathPattern: imagePath('/cr_images/userpicture/', 'n')
  });

  it('берёт оригинал из каталога n', () => {
    assert.equal(
      rule('/cr_images/userpicture/n/5532-0.jpg'),
      'https://pingvinus.ru/cr_images/userpicture/n/5532-0.jpg'
    );
  });

  it('не путает расширение с любым символом', () => {
    // Точка в регулярке должна быть экранированной: иначе `5532-0xjpg`
    // проходил бы как картинка, и VK получал бы битый адрес.
    assert.equal(rule('/cr_images/userpicture/n/5532-0xjpg'), null);
  });

  it('не берёт превью из каталога t и аватары из s', () => {
    assert.equal(rule('/cr_images/userpicture/t/5532-0.jpg'), null);
    assert.equal(rule('/cr_images/userpicture/s/5532-0.jpg'), null);
  });

  it('не берёт чужой домен и не-HTTP схему', () => {
    assert.equal(rule('https://evil.example.org/cr_images/userpicture/n/x.jpg'), null);
    assert.equal(rule('data:image/png;base64,AAAA'), null);
  });

  it('раскрывает двойное экранирование в атрибуте', () => {
    assert.equal(
      rule('/cr_images/userpicture/n/5532-0.jpg?a=1&amp;b=2'),
      'https://pingvinus.ru/cr_images/userpicture/n/5532-0.jpg?a=1&b=2'
    );
  });

  it('мусор вместо URL — null, а не исключение', () => {
    assert.equal(rule('не ссылка'), null);
    assert.equal(rule(''), null);
  });
});
