import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FeedItem } from '../core/feed-item.js';
import { LorSite } from '../sources/sites/lor.js';
import type { PageContext, PageLoader } from '../core/page-based-site.js';

/** Контекст источника по умолчанию; интересует только `pageCacheSize` и потолок. */
const CTX: PageContext = {
  timeoutMs: 30_000,
  userAgent: 'test',
  pageCacheSize: 500,
  maxParallelPages: 4
};

/** Собирает стратегию с подменённой загрузкой страницы. */
function lorSite(loadPage: PageLoader, pageCacheSize = CTX.pageCacheSize): LorSite {
  return new LorSite({ ...CTX, pageCacheSize }, loadPage);
}

/** То же, но с заданным размером кеша страниц. */
function lorSiteWithCache(pageCacheSize: number, loadPage: PageLoader): LorSite {
  return lorSite(loadPage, pageCacheSize);
}

/** Загрузчик, который падает: вызывающий сам решает, что делать с ошибкой. */
function failing(url: string): never {
  throw new Error(`Тест не должен ходить в сеть, но попытался: ${url}`);
}

const POST_URL = 'https://www.linux.org.ru/gallery/screenshots/18389326';
/** Экземпляр без доступа к сети: тесты ниже проверяют только разбор разметки. */
const site = lorSite(failing);

function item(content: string): FeedItem {
  return { content };
}

describe('LorSite.images', () => {
  it('находит обычные <img src>', async () => {
    const urls = await site.images(
      item('<img src="https://www.linux.org.ru/images/gallery/500px.jpg">')
    );

    assert.deepEqual(urls, [
      'https://www.linux.org.ru/images/gallery/500px.jpg'
    ]);
  });

  it('из srcset берёт самый широкий вариант', async () => {
    const urls = await site.images(
      item(
        '<img srcset="https://www.linux.org.ru/images/g/500px.jpg 500w, ' +
          'https://www.linux.org.ru/images/g/1000px.jpg 1000w, ' +
          'https://www.linux.org.ru/images/g/1500px.jpg 1500w">'
      )
    );

    assert.deepEqual(urls, ['https://www.linux.org.ru/images/g/1500px.jpg']);
  });

  it('предпочитает original.png обычным 500px.jpg', async () => {
    const urls = await site.images(
      item(
        '<img src="https://www.linux.org.ru/images/g/500px.jpg">' +
          '<a href="https://www.linux.org.ru/images/g/original.png">оригинал</a>'
      )
    );

    assert.deepEqual(urls, ['https://www.linux.org.ru/images/g/original.png']);
  });

  it('original-like имена (original/full/master) приоритетнее ширины', async () => {
    const urls = await site.images(
      item(
        '<img src="https://www.linux.org.ru/images/g/2000px.jpg">' +
          '<img src="https://www.linux.org.ru/images/g/master.jpg">'
      )
    );

    assert.deepEqual(urls, ['https://www.linux.org.ru/images/g/master.jpg']);
  });

  it('схлопывает варианты одной картинки в один URL', async () => {
    const urls = await site.images(
      item(
        '<img src="https://www.linux.org.ru/images/g/500px.jpg">' +
          '<img src="https://www.linux.org.ru/images/g/1000px.jpg">' +
          '<img src="https://www.linux.org.ru/images/g/1000px.jpg">'
      )
    );

    assert.deepEqual(urls, ['https://www.linux.org.ru/images/g/1000px.jpg']);
  });

  it('разные директории остаются отдельными и идут в порядке появления', async () => {
    const urls = await site.images(
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
    const urls = await site.images(item('<img src="/images/g/800px.jpg">'));

    assert.deepEqual(urls, ['https://www.linux.org.ru/images/g/800px.jpg']);
  });

  it('ловит URL картинки, оставленный обычным текстом', async () => {
    const urls = await site.images(
      item('<p>вот скрин /images/g/700px.jpg — смотрите</p>')
    );

    assert.deepEqual(urls, ['https://www.linux.org.ru/images/g/700px.jpg']);
  });

  it('ловит абсолютный URL картинки из текста', async () => {
    const urls = await site.images(
      item('<p>https://www.linux.org.ru/photos/a/900px.jpg</p>')
    );

    assert.deepEqual(urls, ['https://www.linux.org.ru/photos/a/900px.jpg']);
  });

  it('игнорирует чужие домены в тегах', async () => {
    const urls = await site.images(
      item(
        '<img src="https://evil.example.com/images/500px.jpg">' +
          '<a href="https://cdn.other.org/photos/x.png">x</a>'
      )
    );

    assert.deepEqual(urls, []);
  });

  it('не переписывает чужой URL из текста на linux.org.ru', async () => {
    const urls = await site.images(
      item('<p>смотри https://evil.example.com/images/500px.jpg</p>')
    );

    assert.deepEqual(urls, []);
  });

  it('берёт LOR-URL из текста, но не хвост чужого URL', async () => {
    const urls = await site.images(
      item(
        '<p>https://www.linux.org.ru/images/g/700px.jpg ' +
          'и https://evil.example.com/images/900px.jpg</p>'
      )
    );

    assert.deepEqual(urls, ['https://www.linux.org.ru/images/g/700px.jpg']);
  });

  it('игнорирует не-картинки и пути вне /images/ и /photos/', async () => {
    const urls = await site.images(
      item(
        '<img src="https://www.linux.org.ru/images/readme.txt">' +
          '<img src="https://www.linux.org.ru/galleries/a.jpg">'
      )
    );

    assert.deepEqual(urls, []);
  });

  it('декодирует HTML-сущности в query-параметрах', async () => {
    const urls = await site.images(
      item('<img src="https://www.linux.org.ru/images/g/500px.jpg?a=1&amp;b=2">')
    );

    assert.deepEqual(urls, [
      'https://www.linux.org.ru/images/g/500px.jpg?a=1&b=2'
    ]);
  });

  it('пустая разметка даёт пустой результат', async () => {
    assert.deepEqual(
      await site.images(item('<p>просто текст без картинок</p>')),
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

function galleryItem(description: string, link = POST_URL): FeedItem {
  return { content: description, link, id: link };
}

function siteWithPage(
  page: string,
  options: { failWith?: Error } = {}
): { site: LorSite; calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
    site: lorSite(async url => {
        calls.push(url);

        if (options.failWith) {
          throw options.failWith;
        }

        return page;
        })
  };
}

describe('LorSite: догрузка страницы поста', () => {
  it('забирает ВСЕ скриншоты поста, а не только первый из фида', async () => {
    const { site: sut, calls } = siteWithPage(POST_PAGE);

    const urls = await sut.images(galleryItem(FEED_DESCRIPTION));

    assert.deepEqual(urls, [
      'https://www.linux.org.ru/images/24116/original.png',
      'https://www.linux.org.ru/images/24117/original.png',
      'https://www.linux.org.ru/images/24118/original.png',
      'https://www.linux.org.ru/images/24119/original.png'
    ]);
    assert.deepEqual(calls, [POST_URL]);
  });

  it('не тащит картинки вне галереи со страницы', async () => {
    const { site: sut } = siteWithPage(POST_PAGE);
    const urls = await sut.images(galleryItem(FEED_DESCRIPTION));

    assert.equal(urls.some(url => url.includes('99999')), false);
    assert.equal(urls.some(url => url.includes('88888')), false);
  });

  it('кеширует разбор: повторный poll страницу не грузит', async () => {
    const { site: sut, calls } = siteWithPage(POST_PAGE);
    const entry = galleryItem(FEED_DESCRIPTION);

    const first = await sut.images(entry);
    const second = await sut.images(entry);
    const third = await sut.images(entry);

    assert.deepEqual(first, second);
    assert.deepEqual(second, third);
    assert.equal(calls.length, 1, 'страница должна запрашиваться один раз');
  });

  it('разные посты кешируются независимо', async () => {
    const { site: sut, calls } = siteWithPage(POST_PAGE);

    await sut.images(
      galleryItem(FEED_DESCRIPTION, 'https://www.linux.org.ru/gallery/screenshots/1')
    );
    await sut.images(
      galleryItem(FEED_DESCRIPTION, 'https://www.linux.org.ru/gallery/screenshots/2')
    );

    assert.equal(calls.length, 2);
  });

  it('вытесняет самый старый пост при переполнении кеша', async () => {
    const calls: string[] = [];
    const bounded = lorSiteWithCache(1, async url => {
        calls.push(url);
        return POST_PAGE;
        });

    const first = galleryItem(
      FEED_DESCRIPTION,
      'https://www.linux.org.ru/gallery/screenshots/1'
    );
    const second = galleryItem(
      FEED_DESCRIPTION,
      'https://www.linux.org.ru/gallery/screenshots/2'
    );

    await bounded.images(first);
    await bounded.images(second);
    assert.equal(calls.length, 2, 'второй пост вытеснил первый из кеша');

    // Кеш на одну запись: после вставки first пост second уже вытеснен.
    await bounded.images(first);
    assert.equal(calls.length, 3, 'вытесненный пост грузится заново');

    await bounded.images(second);
    assert.equal(
      calls.length,
      4,
      'при кеше на одну запись второй пост тоже вытеснен'
    );
  });

  it('держит в кеше все посты, пока не упрётся в лимит', async () => {
    const calls: string[] = [];
    const sut = lorSiteWithCache(2, async url => {
        calls.push(url);
        return POST_PAGE;
        });

    const first = galleryItem(
      FEED_DESCRIPTION,
      'https://www.linux.org.ru/gallery/screenshots/1'
    );
    const second = galleryItem(
      FEED_DESCRIPTION,
      'https://www.linux.org.ru/gallery/screenshots/2'
    );

    await sut.images(first);
    await sut.images(second);
    assert.equal(calls.length, 2);

    // Оба в кеше — ни одного нового запроса.
    await sut.images(first);
    await sut.images(second);
    assert.equal(calls.length, 2, 'оба поста в кеше, запросов не добавилось');
  });

  it('при сбое страницы отдаёт то, что есть в фиде, и не падает', async () => {
    const { site: sut } = siteWithPage('', {
      failWith: new Error('HTTP 503')
    });

    const urls = await sut.images(galleryItem(FEED_DESCRIPTION));

    assert.deepEqual(urls, ['https://www.linux.org.ru/images/24116/original.png']);
  });

  it('если в фиде пусто и страница не пришла — пробрасывает ошибку на backoff', async () => {
    const { site: sut } = siteWithPage('', {
      failWith: new Error('HTTP 503')
    });

    await assert.rejects(
      () => sut.images(galleryItem('<p>без картинок</p>')),
      /HTTP 503/
    );
  });

  it('не ходит на страницу обычных тем форума', async () => {
    const { site: sut, calls } = siteWithPage(POST_PAGE);
    const link = 'https://www.linux.org.ru/forum/talks/18389236';

    const urls = await sut.images({
      description: '<img src="https://www.linux.org.ru/images/24116/1000px.jpg">',
      link,
      id: link
    });

    assert.deepEqual(urls, [
      'https://www.linux.org.ru/images/24116/1000px.jpg'
    ]);
    assert.deepEqual(calls, []);
  });


  it('дубликаты картинок из фида и страницы схлопываются', async () => {
    const { site: sut } = siteWithPage(POST_PAGE);

    const urls = await sut.images(galleryItem(FEED_DESCRIPTION));

    assert.equal(new Set(urls).size, urls.length);
  });

  it('работает без маркера slider-container (вся страница)', async () => {
    const pageWithoutSlider =
      '<html><body>' +
      '<img src="https://www.linux.org.ru/images/24116/1000px.jpg">' +
      '<img src="https://www.linux.org.ru/images/24117/1000px.jpg">' +
      '</body></html>';
    const { site: sut } = siteWithPage(pageWithoutSlider);

    const urls = await sut.images(galleryItem(FEED_DESCRIPTION));

    assert.deepEqual(urls, [
      'https://www.linux.org.ru/images/24116/original.png',
      'https://www.linux.org.ru/images/24116/1000px.jpg',
      'https://www.linux.org.ru/images/24117/1000px.jpg'
    ]);
  });
});

/*
 * imagesFromUrl — путь для resend постов, которых уже нет в фиде.
 * Фикстуры отражают реальную разметку gallery/workplaces.
 */
describe('LorSite.imagesFromUrl', () => {
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
    const { site: sut, calls } = siteWithPage(WORKPLACES);
    const url = 'https://www.linux.org.ru/gallery/workplaces/18348513';

    const urls = await sut.imagesFromUrl(url);

    assert.deepEqual(urls, [
      'https://www.linux.org.ru/images/23786/original.png',
      'https://www.linux.org.ru/images/23787/original.png',
      'https://www.linux.org.ru/images/23788/original.png',
      'https://www.linux.org.ru/images/23789/original.png'
    ]);
    assert.deepEqual(calls, [url]);
  });

  it('не тащит аватарки и прочее вне галереи', async () => {
    const { site: sut } = siteWithPage(WORKPLACES);

    const urls = await sut.imagesFromUrl(
      'https://www.linux.org.ru/gallery/workplaces/18348513'
    );

    assert.equal(urls.some(url => url.includes('99999')), false);
  });

  it('кеширует страницу между images и imagesFromUrl', async () => {
    const { site: sut, calls } = siteWithPage(WORKPLACES);
    const url = 'https://www.linux.org.ru/gallery/workplaces/18348513';

    await sut.images(galleryItem(FEED_DESCRIPTION, url));
    await sut.imagesFromUrl(url);

    assert.equal(calls.length, 1, 'страница должна грузиться один раз');
  });

  it('на сбое страницы возвращает пустой массив, а не бросает', async () => {
    const { site: sut } = siteWithPage('', {
      failWith: new Error('HTTP 500')
    });

    const urls = await sut.imagesFromUrl(
      'https://www.linux.org.ru/gallery/workplaces/18348513'
    );

    assert.deepEqual(urls, []);
  });

  it('не ходит на страницы не-галереи', async () => {
    const { site: sut, calls } = siteWithPage(WORKPLACES);

    const urls = await sut.imagesFromUrl(
      'https://www.linux.org.ru/forum/talks/18348513'
    );

    assert.deepEqual(urls, []);
    assert.deepEqual(calls, [], 'обычные темы не должны дёргать сеть');
  });

});

describe('LorSite.description', () => {
  it('вырезает блоки с картинками и строку тегов', async () => {
    const html = site.description(
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
    const html = site.description(
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
