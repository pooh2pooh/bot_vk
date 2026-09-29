import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PingvinusImageExtractor,
  extractPingvinusDescription,
  extractPingvinusPostText
} from '../sources/image-extractors/pingvinus-image-extractor.js';
import { truncateText } from '../core/text-utils.js';
import type { AtomItem } from '../core/atom-item.js';

const POST_URL = 'https://pingvinus.ru/gallery/5532';

/** Разметка поста pingvinus: картинка в .pictureThumb, текст в .text. */
const POST_PAGE = [
  '<html><body>',
  '<div class="banner"><img src="/themes/pingvinus3/images/banners/970x250-1.png"></div>',
  '<nav class="sidebar">',
  '<img src="/cr_images/userpicture/s/5508-0.jpg">',
  '<img src="/cr_images/userpicture/s/5509-0.png">',
  '</nav>',
  '<div class="maintitle"><h1>Enlightenment E27. Назад в будущее</h1></div>',
  '<article>',
  '<div class="pictureThumb">',
  '<a target="_blank" href="/cr_images/userpicture/n/5532-0.jpg">',
  '<img width="1000" height="563" src="/cr_images/userpicture/t/5532-0.jpg" alt="" />',
  '</a></div>',
  '<div class="extrelDistrGui c-mb"><div class="distr"><div class="extrels">',
  '<div class="title">Дистрибутив:</div><ul><li>antiX</li></ul></div></div></div>',
  '<div class="text">',
  '<p>Исходник: antiX-26</p>',
  '<h2>Предыстория</h2>',
  '<p>Прошлый мой скриншот заканчивался фразой:</p>',
  '<p>&quot;С темами беда на E27&nbsp;— их почти нет.&quot;</p>',
  '</div>',
  '</article>',
  '<footer><img src="/themes/pingvinus3/images/logo-symbol-footer.png"></footer>',
  '</body></html>'
].join('\n');

function extractorWithPage(
  page: string,
  options: { failWith?: Error } = {}
): { sut: PingvinusImageExtractor; calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
    sut: new PingvinusImageExtractor({
      fetchPage: async url => {
        calls.push(url);

        if (options.failWith) {
          throw options.failWith;
        }

        return page;
      }
    })
  };
}

function galleryItem(over: Partial<AtomItem> = {}): AtomItem {
  return { description: '', link: POST_URL, guid: `5532 at https://pingvinus.ru`, ...over };
}

describe('PingvinusImageExtractor', () => {
  it('берёт оригинал картинки из .pictureThumb', async () => {
    const { sut, calls } = extractorWithPage(POST_PAGE);

    const urls = await sut.extract(galleryItem());

    assert.deepEqual(urls, [
      'https://pingvinus.ru/cr_images/userpicture/n/5532-0.jpg'
    ]);
    assert.deepEqual(calls, [POST_URL]);
  });

  it('не тащит баннеры, сайдбар и футер', async () => {
    const { sut } = extractorWithPage(POST_PAGE);

    const urls = await sut.extract(galleryItem());

    assert.equal(urls.length, 1);
    assert.equal(urls.some(url => url.includes('5508')), false);
    assert.equal(urls.some(url => url.includes('themes')), false);
  });

  it('не ходит на страницы не-галереи', async () => {
    const { sut, calls } = extractorWithPage(POST_PAGE);
    const link = 'https://pingvinus.ru/news/5533';

    const urls = await sut.extract({ description: '', link });

    assert.deepEqual(urls, []);
    assert.deepEqual(calls, []);
  });

  it('кеширует страницу между вызовами', async () => {
    const { sut, calls } = extractorWithPage(POST_PAGE);

    await sut.extract(galleryItem());
    await sut.extract(galleryItem());
    await sut.extractFromUrl(POST_URL);
    await sut.extractTextFromUrl(POST_URL);

    assert.equal(calls.length, 1, 'страница должна грузиться один раз');
  });

  it('при сбое страницы не бросает, а отдаёт пустое', async () => {
    const { sut } = extractorWithPage('', { failWith: new Error('HTTP 500') });

    assert.deepEqual(await sut.extract(galleryItem()), []);
    assert.deepEqual(await sut.extractFromUrl(POST_URL), []);
    assert.equal(await sut.extractTextFromUrl(POST_URL), '');
  });

  it('достаёт текст поста для fallback', async () => {
    const { sut } = extractorWithPage(POST_PAGE);

    const text = await sut.extractTextFromUrl(POST_URL);

    assert.equal(text.includes('Исходник: antiX-26'), true);
    assert.equal(text.includes('Предыстория'), true);
    // "Дистрибутив:" встречается только в служебном блоке .extrelDistrGui,
    // которого в тексте поста быть не должно.
    assert.equal(
      text.includes('Дистрибутив:'),
      false,
      'служебный блок с характеристиками дистрибутива должен быть вырезан'
    );
  });

  it('не склеивает заголовок с текстом', async () => {
    const { sut } = extractorWithPage(POST_PAGE);

    const text = await sut.extractTextFromUrl(POST_URL);

    assert.equal(
      text.includes('ПредысторияПрошлый'),
      false,
      '<h2> и <p> должны разделяться переносом строки'
    );
    assert.equal(
      /\n\s*Прошлый/.test(text),
      true,
      `ожидался перенос перед "Прошлый", получено: ${JSON.stringify(text.slice(0, 120))}`
    );
  });

  it('вытесняет старые записи кеша при переполнении', async () => {
    const calls: string[] = [];
    const sut = new PingvinusImageExtractor({
      pageCacheSize: 1,
      fetchPage: async url => {
        calls.push(url);
        return POST_PAGE;
      }
    });

    await sut.extractFromUrl('https://pingvinus.ru/gallery/1');
    await sut.extractFromUrl('https://pingvinus.ru/gallery/2');
    await sut.extractFromUrl('https://pingvinus.ru/gallery/1');

    assert.equal(calls.length, 3, 'первый пост вытеснен и грузится заново');
  });
});

describe('extractPingvinusPostText', () => {
  it('возвращает пустую строку, если блока .text нет', () => {
    assert.equal(extractPingvinusPostText('<html><body></body></html>'), '');
  });

  it('берёт .text из статьи, а не из сайдбара', () => {
    const html =
      '<div class="text">подвал</div><article><div class="text">пост</div></article>';
    const text = extractPingvinusPostText(html);
    assert.equal(text.includes('пост'), true);
    assert.equal(text.includes('подвал'), false);
  });
});

describe('extractPingvinusDescription', () => {
  it('вырезает картинку и ссылку "читать далее"', () => {
    const html = extractPingvinusDescription({
      description:
        '<div class="pictureThumb"><img src="/x.jpg"></div>' +
        '<p>Текст поста</p>' +
        '<p><a href="/gallery/5532">Читать далее</a></p>'
    });

    assert.equal(html.includes('pictureThumb'), false);
    assert.equal(html.includes('Читать далее'), false);
    assert.equal(html.includes('Текст поста'), true);
  });
});

describe('truncateText для fallback', () => {
  it('не трогает короткий текст', () => {
    assert.equal(truncateText('Всем привет', 200), 'Всем привет');
  });

  it('режет по границе слова, а не по символу', () => {
    const text = 'Первые слова подряд идут вот тут конец';
    const cut = truncateText(text, 20);

    assert.equal(cut.length <= 20, true);
    assert.equal(cut.endsWith('…'), true);
    assert.equal(
      /\s$/.test(cut.slice(0, -1)),
      false,
      'перед многоточием не должно висеть пробела'
    );
  });

  it('результат всегда влезает в лимит', () => {
    for (const length of [1, 5, 50, 199, 200, 201, 1000]) {
      const cut = truncateText('а'.repeat(length), 200);
      assert.equal(
        cut.length <= 200,
        true,
        `для длины ${length} получилось ${cut.length}`
      );
    }
  });

  it('не зацикливается на тексте без пробелов', () => {
    const cut = truncateText('б'.repeat(5000), 200);
    assert.equal(cut.length, 200);
    assert.equal(cut.endsWith('…'), true);
  });

  it('пустая строка и пробелы дают пустую строку', () => {
    assert.equal(truncateText('', 200), '');
    assert.equal(truncateText('   ', 200), '');
  });

  it('лимит 0 даёт пустую строку', () => {
    assert.equal(truncateText('что-то', 0), '');
  });
});
