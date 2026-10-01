import he from 'he';

/**
 * Правила допустимой картинки для одного сайта.
 *
 * Вынесены в данные, потому что у каждого сайта свои: свой домен, свой каталог,
 * свои расширения. Проверка домена обязательна: без неё в сообщение тянулись бы
 * картинки с чужих хостов, на которые ссылается разметка поста.
 */
export interface ImageUrlRule {
  /** Адрес сайта: относительные ссылки резолвятся относительно него. */
  baseUrl: string;
  /** Допустимые домены. Регистр и `www.` нормализуются. */
  hostnames: readonly string[];
  /** Путь, под который попадает картинка сайта. */
  pathPattern: RegExp;
}

/**
 * Возвращает функцию «значение атрибута → абсолютный URL картинки».
 *
 * Готовая функция, а не разбор на месте: атрибутов в разметке сотни, и
 * URL-разбор с try/catch внутри цикла — это ровно то место, где молча
 * проскакивают битые ссылки. null означает «это не наша картинка».
 *
 * Что отбрасывается:
 *  - не http(s) — `data:` и `javascript:` в сообщение не годятся;
 *  - чужой домен;
 *  - путь вне каталога картинок сайта (иконки, логотипы, аватары);
 *  - нераскрываемый URL.
 */
export function createImageUrlMatcher(rule: ImageUrlRule): (value: string) => string | null {
  const { baseUrl, hostnames, pathPattern } = rule;
  const allowed = new Set(hostnames.map(host => host.toLowerCase()));

  return (value: string): string | null => {
    try {
      const url = new URL(cleanAttributeValue(value), baseUrl);

      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
      }

      if (!allowed.has(url.hostname.toLowerCase())) {
        return null;
      }

      return pathPattern.test(decodeURIComponent(url.pathname))
        ? url.href
        : null;
    } catch {
      return null;
    }
  };
}

/**
 * Приводит значение атрибута к тому, что вообще можно скормить URL.
 *
 * В разметке сайтов встречается `&amp;` вместо `&` (двойное экранирование),
 * а также кавычки и пробелы по краям из-за переноса строки в HTML.
 */
function cleanAttributeValue(value: string): string {
  return he.decode(value)
    .replace(/&amp;/gi, '&')
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

/** Расширения файлов, которые вообще могут быть картинкой. */
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|webp|gif|avif)$/i;

/**
 * Собирает регулярку «путь внутри каталога и с нужным расширением».
 * Пример: `imagePath('/cr_images/userpicture/', 'n')` ->
 * `^/cr_images/userpicture/n/[^/]+\.(?:png|jpe?g|webp|gif)$`
 */
export function imagePath(
  prefix: string,
  directory?: string
): RegExp {
  const middle = directory ? `${directory}/` : '';
  /*
   * `IMAGE_EXTENSIONS.source` — это уже `\.(?:png|...)$`, готовый кусок
   * регулярки. Обрезать его нельзя: без экранированной точки расширение
   * превратится в «любой символ», и в картинки попадали бы `5532-0xjpg`.
   */
  const extensions = IMAGE_EXTENSIONS.source;

  return new RegExp(`^${prefix}${middle}[^/]+${extensions}`, 'i');
}