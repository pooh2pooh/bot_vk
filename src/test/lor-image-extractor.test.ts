import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AtomItem } from '../core/atom-item.js';
import {
  LorImageExtractor,
  extractLorDescription
} from '../sources/image-extractors/lor-image-extractor.js';

const POST_URL = 'https://www.linux.org.ru/gallery/screenshots/18389326';
/** Экземпляр без доступа к сети: тесты ниже проверяют только разбор разметки. */
const extractor = new LorImageExtractor({
  fetchPage: async url => {
    throw new Error(`Тест не должен ходить в сеть, но попытался: ${url}`);
  }
});

function item(content: string): AtomItem {
  return { description: content };
}

describe('LorImageExtractor.extract', () => {
  it('находит обычные <img src>', async () => {
    const urls = await extractor.extract(
      item('<img src="https://www.linux.org.ru/images/gallery/500px.jpg">')
    );

    assert.deepEqual(urls, [
      'https://www.linux.org.ru/images/gallery/500px.jpg'
    ]);
  });

  it('из srcset берёт самый широкий вариант', async () => {
    const urls = await extractor.extract(
      item(
        '<img srcset="https://www.linux.org.ru/images/g/500px.jpg 500w, ' +
          'https://www.linux.org.ru/images/g/1000px.jpg 1000w, ' +
          'https://www.linux.org.ru/images/g/1500px.jpg 1500w">'
      )
    );

    assert.deepEqual(urls, ['https://www.linux.org.ru/images/g/1500px.jpg']);
  });

  it('предпочитает original.png обычным 500px.jpg', async () => {
    const urls = await extractor.extract(
      item(
        '<img src="https://www.linux.org.ru/images/g/500px.jpg">' +
          '<a href="https://www.linux.org.ru/images/g/original.png">оригинал</a>'
      )
    );

    assert.deepEqual(urls, ['https://www.linux.org.ru/images/g/original.png']);
  });

  it('original-like имена (original/full/master) приоритетнее ширины', async () => {
    const urls = await extractor.extract(
      item(
        '<img src="https://www.linux.org.ru/images/g/2000px.jpg">' +
          '<img src="https://www.linux.org.ru/images/g/master.jpg">'
      )
    );

    assert.deepEqual(urls, ['https://www.linux.org.ru/images/g/master.jpg']);
  });

  it('схлопывает варианты одной картинки в один URL', async () => {
    const urls = await extractor.extract(
      item(
        '<img src="https://www.linux.org.ru/images/g/500px.jpg">' +
          '<img src="https://www.linux.org.ru/images/g/1000px.jpg">' +
          '<img src="https://www.linux.org.ru/images/g/1000px.jpg">'
      )
    );

    assert.deepEqual(urls, ['https://www.linux.org.ru/images/g/1000px.jpg']);
  });

  it('разные директории остаются отдельными и идут в порядке появления', async () => {
    const urls = await extractor.extract(
      item(
        '<img src="https://www.linux.org.ru/images/b/100px.jpg">' +
          '<img src="https://www.linux.org.ru/images/a/200px.jpg">'
      )
    );

    assert.deepEqual(urls, [
      'https://www.linux.org.ru/images/b/100px.jpg',
      'https://www.linux.org.ru/images/a/200px.jpg'
    ]);
  });

  it('резолвит относительные пути в абсолютные', async () => {
    const urls = await extractor.extract(item('<img src="/images/g/800px.jpg">'));

    assert.deepEqual(urls, ['https://www.linux.org.ru/images/g/800px.jpg']);
  });

  it('ловит URL картинки, оставленный обычным текстом', async () => {
    const urls = await extractor.extract(
      item('<p>вот скрин /images/g/700px.jpg — смотрите</p>')
    );

    assert.deepEqual(urls, ['https://www.linux.org.ru/images/g/700px.jpg']);
  });

  it('ловит абсолютный URL картинки из текста', async () => {
    const urls = await extractor.extract(
      item('<p>https://www.linux.org.ru/photos/a/900px.jpg</p>')
    );

    assert.deepEqual(urls, ['https://www.linux.org.ru/photos/a/900px.jpg']);
  });

  it('игнорирует чужие домены в тегах', async () => {
    const urls = await extractor.extract(
      item(
        '<img src="https://evil.example.com/images/500px.jpg">' +
          '<a href="https://cdn.other.org/photos/x.png">x</a>'
      )
    );

    assert.deepEqual(urls, []);
  });

  it('не переписывает чужой URL из текста на linux.org.ru', async () => {
    const urls = await extractor.extract(
      item('<p>смотри https://evil.example.com/images/500px.jpg</p>')
    );

    assert.deepEqual(urls, []);
  });

  it('берёт LOR-URL из текста, но не хвост чужого URL', async () => {
    const urls = await extractor.extract(
      item(
        '<p>https://www.linux.org.ru/images/g/700px.jpg ' +
          'и https://evil.example.com/images/900px.jpg</p>'
      )
    );

    assert.deepEqual(urls, ['https://www.linux.org.ru/images/g/700px.jpg']);
  });

  it('игнорирует не-картинки и пути вне /images/ и /photos/', async () => {
    const urls = await extractor.extract(
      item(
        '<img src="https://www.linux.org.ru/images/readme.txt">' +
          '<img src="https://www.linux.org.ru/galleries/a.jpg">'
      )
    );

    assert.deepEqual(urls, []);
  });

  it('декодирует HTML-сущности в query-параметрах', async () => {
    const urls = await extractor.extract(
      item('<img src="https://www.linux.org.ru/images/g/500px.jpg?a=1&amp;b=2">')
    );

    assert.deepEqual(urls, [
      'https://www.linux.org.ru/images/g/500px.jpg?a=1&b=2'
    ]);
  });

  it('пустая разметка даёт пустой результат', async () => {
    assert.deepEqual(
      await extractor.extract(item('<p>просто текст без картинок</p>')),
      []
    );
  });
});

/*
 * Дальше — поведение, ради которого экстрактор ходит на страницу поста.
 * Фикстуры взяты с реального поста linux.org.ru/gallery/screenshots/18389326:
 * в RSS попадает только картинка 24116, на странице их четыре.
 */


const FEED_DESCRIPTION =  '<div class="medium-image-container">' +
  '<a href="https://www.linux.org.ru/images/24116/original.png">' +
  '<img src="https://www.linux.org.ru/images/24116/1000px.jpg" ' +
  'srcset="images/24116/500px.jpg 500w, images/24116/1000px.jpg 1000w">' +
  '</a></div><p>Текст поста</p>';

function slide(id: number): string {
  return (
    `<a href="https://www.linux.org.ru/images/${id}/original.png">` +
    `<img src="https://www.linux.org.ru/images/${id}/1000px.jpg" ` +
    `srcset="images/${id}/500px.jpg 500w, images/${id}/1000px.jpg 1000w, ` +
    `https://www.linux.org.ru/images/${id}/original.png 1440w"></a>`
  );
}

const POST_PAGE = [
  '<html><body><header>',
  '<img src="https://www.linux.org.ru/images/99999/avatar.png">',
  '</header>',
  '<div class="msg-container">',
  '<div class="slider-parent">',
  '<div class="swiffy-slider"><div class="slider-container">',
  slide(24116),
  slide(24117),
  slide(24118),
  slide(24119),
  '</div></div></div>',
  '<p>Обсуждение</p>',
  '<div class="other-gallery"><img src="https://www.linux.org.ru/images/88888/1000px.jpg"></div>',
  '</div></body></html>'
].join('\n');

function galleryItem(description: string, link = POST_URL): AtomItem {
  return { description, link, guid: link };
}

function extractorWithPage(
  page: string,
  options: { failWith?: Error } = {}
): { extractor: LorImageExtractor; calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
    extractor: new LorImageExtractor({
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

describe('LorImageExtractor: догрузка страницы поста', () => {
  it('забирает ВСЕ скриншоты поста, а не только первый из фида', async () => {
    const { extractor: sut, calls } = extractorWithPage(POST_PAGE);

    const urls = await sut.extract(galleryItem(FEED_DESCRIPTION));

    assert.deepEqual(urls, [
      'https://www.linux.org.ru/images/24116/original.png',
      'https://www.linux.org.ru/images/24117/original.png',
      'https://www.linux.org.ru/images/24118/original.png',
      'https://www.linux.org.ru/images/24119/original.png'
    ]);
    assert.deepEqual(calls, [POST_URL]);
  });

  it('не тащит картинки вне галереи со страницы', async () => {
    const { extractor: sut } = extractorWithPage(POST_PAGE);
    const urls = await sut.extract(galleryItem(FEED_DESCRIPTION));

    assert.equal(urls.some(url => url.includes('99999')), false);
    assert.equal(urls.some(url => url.includes('88888')), false);
  });

  it('кеширует разбор: повторный poll страницу не грузит', async () => {
    const { extractor: sut, calls } = extractorWithPage(POST_PAGE);
    const entry = galleryItem(FEED_DESCRIPTION);

    const first = await sut.extract(entry);
    const second = await sut.extract(entry);
    const third = await sut.extract(entry);

    assert.deepEqual(first, second);
    assert.deepEqual(second, third);
    assert.equal(calls.length, 1, 'страница должна запрашиваться один раз');
  });

  it('разные посты кешируются независимо', async () => {
    const { extractor: sut, calls } = extractorWithPage(POST_PAGE);

    await sut.extract(
      galleryItem(FEED_DESCRIPTION, 'https://www.linux.org.ru/gallery/screenshots/1')
    );
    await sut.extract(
      galleryItem(FEED_DESCRIPTION, 'https://www.linux.org.ru/gallery/screenshots/2')
    );

    assert.equal(calls.length, 2);
  });

  it('вытесняет самый старый пост при переполнении кеша', async () => {
    const calls: string[] = [];
    const bounded = new LorImageExtractor({
      pageCacheSize: 1,
      fetchPage: async url => {
        calls.push(url);
        return POST_PAGE;
      }
    });

    const first = galleryItem(
      FEED_DESCRIPTION,
      'https://www.linux.org.ru/gallery/screenshots/1'
    );
    const second = galleryItem(
      FEED_DESCRIPTION,
      'https://www.linux.org.ru/gallery/screenshots/2'
    );

    await bounded.extract(first);
    await bounded.extract(second);
    assert.equal(calls.length, 2, 'второй пост вытеснил первый из кеша');

    // Кеш на одну запись: после вставки first пост second уже вытеснен.
    await bounded.extract(first);
    assert.equal(calls.length, 3, 'вытесненный пост грузится заново');

    await bounded.extract(second);
    assert.equal(
      calls.length,
      4,
      'при кеше на одну запись второй пост тоже вытеснен'
    );
  });

  it('держит в кеше все посты, пока не упрётся в лимит', async () => {
    const calls: string[] = [];
    const sut = new LorImageExtractor({
      pageCacheSize: 2,
      fetchPage: async url => {
        calls.push(url);
        return POST_PAGE;
      }
    });

    const first = galleryItem(
      FEED_DESCRIPTION,
      'https://www.linux.org.ru/gallery/screenshots/1'
    );
    const second = galleryItem(
      FEED_DESCRIPTION,
      'https://www.linux.org.ru/gallery/screenshots/2'
    );

    await sut.extract(first);
    await sut.extract(second);
    assert.equal(calls.length, 2);

    // Оба в кеше — ни одного нового запроса.
    await sut.extract(first);
    await sut.extract(second);
    assert.equal(calls.length, 2, 'оба поста в кеше, запросов не добавилось');
  });

  it('при сбое страницы отдаёт то, что есть в фиде, и не падает', async () => {
    const { extractor: sut } = extractorWithPage('', {
      failWith: new Error('HTTP 503')
    });

    const urls = await sut.extract(galleryItem(FEED_DESCRIPTION));

    assert.deepEqual(urls, ['https://www.linux.org.ru/images/24116/original.png']);
  });

  it('если в фиде пусто и страница не пришла — пробрасывает ошибку на backoff', async () => {
    const { extractor: sut } = extractorWithPage('', {
      failWith: new Error('HTTP 503')
    });

    await assert.rejects(
      () => sut.extract(galleryItem('<p>без картинок</p>')),
      /HTTP 503/
    );
  });

  it('не ходит на страницу обычных тем форума', async () => {
    const { extractor: sut, calls } = extractorWithPage(POST_PAGE);
    const link = 'https://www.linux.org.ru/forum/talks/18389236';

    const urls = await sut.extract({
      description: '<img src="https://www.linux.org.ru/images/24116/1000px.jpg">',
      link,
      guid: link
    });

    assert.deepEqual(urls, [
      'https://www.linux.org.ru/images/24116/1000px.jpg'
    ]);
    assert.deepEqual(calls, []);
  });

  it('fetchPageImages: false оставляет только поведение фида', async () => {
    const calls: string[] = [];
    const disabled = new LorImageExtractor({
      fetchPageImages: false,
      fetchPage: async url => {
        calls.push(url);
        return POST_PAGE;
      }
    });

    const urls = await disabled.extract(galleryItem(FEED_DESCRIPTION));

    assert.deepEqual(urls, ['https://www.linux.org.ru/images/24116/original.png']);
    assert.deepEqual(calls, []);
  });

  it('дубликаты картинок из фида и страницы схлопываются', async () => {
    const { extractor: sut } = extractorWithPage(POST_PAGE);

    const urls = await sut.extract(galleryItem(FEED_DESCRIPTION));

    assert.equal(new Set(urls).size, urls.length);
  });

  it('работает без маркера slider-container (вся страница)', async () => {
    const pageWithoutSlider =
      '<html><body>' +
      '<img src="https://www.linux.org.ru/images/24116/1000px.jpg">' +
      '<img src="https://www.linux.org.ru/images/24117/1000px.jpg">' +
      '</body></html>';
    const { extractor: sut } = extractorWithPage(pageWithoutSlider);

    const urls = await sut.extract(galleryItem(FEED_DESCRIPTION));

    assert.deepEqual(urls, [
      'https://www.linux.org.ru/images/24116/original.png',
      'https://www.linux.org.ru/images/24116/1000px.jpg',
      'https://www.linux.org.ru/images/24117/1000px.jpg'
    ]);
  });
});

/*
 * extractFromUrl — путь для resend постов, которых уже нет в фиде.
 * Фикстуры отражают реальную разметку gallery/workplaces.
 */
describe('LorImageExtractor.extractFromUrl', () => {
  const WORKPLACES = [
    '<html><body><div class="msg-container">',
    '<div class="slider-parent"><div class="swiffy-slider">',
    '<div class="slider-container">',
    slide(23786),
    slide(23787),
    slide(23788),
    slide(23789),
    '</div></div></div>',
    '<img src="https://www.linux.org.ru/images/99999/avatar.png">',
    '</div></body></html>'
  ].join('\n');

  it('достаёт все слайды поста, которого нет в фиде', async () => {
    const { extractor: sut, calls } = extractorWithPage(WORKPLACES);
    const url = 'https://www.linux.org.ru/gallery/workplaces/18348513';

    const urls = await sut.extractFromUrl!(url);

    assert.deepEqual(urls, [
      'https://www.linux.org.ru/images/23786/original.png',
      'https://www.linux.org.ru/images/23787/original.png',
      'https://www.linux.org.ru/images/23788/original.png',
      'https://www.linux.org.ru/images/23789/original.png'
    ]);
    assert.deepEqual(calls, [url]);
  });

  it('не тащит аватарки и прочее вне галереи', async () => {
    const { extractor: sut } = extractorWithPage(WORKPLACES);

    const urls = await sut.extractFromUrl!(
      'https://www.linux.org.ru/gallery/workplaces/18348513'
    );

    assert.equal(urls.some(url => url.includes('99999')), false);
  });

  it('кеширует страницу между extract и extractFromUrl', async () => {
    const { extractor: sut, calls } = extractorWithPage(WORKPLACES);
    const url = 'https://www.linux.org.ru/gallery/workplaces/18348513';

    await sut.extract(galleryItem(FEED_DESCRIPTION, url));
    await sut.extractFromUrl!(url);

    assert.equal(calls.length, 1, 'страница должна грузиться один раз');
  });

  it('на сбое страницы возвращает пустой массив, а не бросает', async () => {
    const { extractor: sut } = extractorWithPage('', {
      failWith: new Error('HTTP 500')
    });

    const urls = await sut.extractFromUrl!(
      'https://www.linux.org.ru/gallery/workplaces/18348513'
    );

    assert.deepEqual(urls, []);
  });

  it('не ходит на страницы не-галереи', async () => {
    const { extractor: sut, calls } = extractorWithPage(WORKPLACES);

    const urls = await sut.extractFromUrl!(
      'https://www.linux.org.ru/forum/talks/18348513'
    );

    assert.deepEqual(urls, []);
    assert.deepEqual(calls, [], 'обычные темы не должны дёргать сеть');
  });

  it('выключенный fetchPageImages отключает и extractFromUrl', async () => {
    const calls: string[] = [];
    const sut = new LorImageExtractor({
      fetchPageImages: false,
      fetchPage: async url => {
        calls.push(url);
        return WORKPLACES;
      }
    });

    const urls = await sut.extractFromUrl!(
      'https://www.linux.org.ru/gallery/workplaces/18348513'
    );

    assert.deepEqual(urls, []);
    assert.deepEqual(calls, []);
  });
});

describe('extractLorDescription', () => {
  it('вырезает блоки с картинками и строку тегов', async () => {
    const html = extractLorDescription(
      item(
        '<div class="medium-image-container"><img src="a.jpg"></div>' +
          '<p>Собственно текст поста</p>' +
          '<p class="tags">#screenshot #linux</p>'
      )
    );

    assert.equal(html.includes('medium-image-container'), false);
    assert.equal(html.includes('<img'), false);
    assert.equal(html.includes('#screenshot'), false);
    assert.equal(html.includes('Собственно текст поста'), true);
  });

  it('вырезает <picture> и <figure> целиком', async () => {
    const html = extractLorDescription(
      item(
        '<figure><picture><source srcset="a.png"><img src="a.png"></picture>' +
          '<figcaption>подпись</figcaption></figure><p>Текст</p>'
      )
    );

    assert.equal(html.includes('<picture'), false);
    assert.equal(html.includes('<figure'), false);
    assert.equal(html.includes('подпись'), false);
    assert.equal(html.includes('Текст'), true);
  });
});
