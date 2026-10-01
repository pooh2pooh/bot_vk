/**
 * Единственный HTTP-клиент проекта.
 *
 * Все загрузки идут через `fetch` с таймаутом и User-Agent: часть сайтов режет
 * запросы с пустым User-Agent, а таймаут нужен везде одинаково. Своих
 * реализаций HTTP в проекте нет и не должно появляться.
 */

/**
 * Потолок размера изображения. Защищает не столько от злого умысла, сколько от
 * испорченного ответа: без проверки `arrayBuffer()` на неверной картинке
 * в память попадает любой объём, а VK такой файл всё равно не примет.
 */
const IMAGE_MAX_BYTES = 25 * 1024 * 1024;

export interface HttpOptions {
  timeoutMs: number;
  userAgent: string;
}

export interface JsonOptions extends HttpOptions {
  /** Заголовки поверх User-Agent: авторизация, тип тела. */
  headers?: Record<string, string>;
}

export interface ImagePayload {
  buffer: Buffer;
  contentType: string;
}

/** Загружает текст: HTML фида, страницу поста, промпт. Ошибка пробрасывается. */
export async function fetchText(
  url: string,
  { timeoutMs, userAgent }: HttpOptions
): Promise<string> {
  const response = await request(url, timeoutMs, userAgent);

  if (!response.ok) {
    throw new HttpStatusError(
      response.status,
      `HTTP ${response.status} ${response.statusText}: ${url}`
    );
  }

  return response.text();
}

/**
 * Отправляет JSON и разбирает JSON-ответ.
 *
 * Нужна API, у которых запрос — POST с телом: `fetch(url, {...})` в обход
 * `core/http` означал бы второе место в проекте, где живут таймаут,
 * User-Agent и разбор отмены запроса.
 */
export async function fetchJson<T>(
  url: string,
  body: unknown,
  { timeoutMs, userAgent, headers }: JsonOptions
): Promise<T> {
  const response = await request(url, timeoutMs, userAgent, {
    'Content-Type': 'application/json',
    ...headers
  }, 'POST', JSON.stringify(body));

  const raw = await response.text();

  if (!response.ok) {
    throw new HttpStatusError(
      response.status,
      `HTTP ${response.status} ${response.statusText}: ${url}${detail(raw)}`,
      response.headers.get('retry-after')
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    /*
     * Не JSON при успешном ответе — типичная картина для прокси и шлюзов,
     * которые подставляют свою HTML-страницу. Молчаливый `{}` превратил бы
     * это в «пустой ответ» вместо настоящей причины.
     */
    throw new Error(
      `Expected JSON from ${url}, got: ${clip(raw) || '(empty body)'}`
    );
  }
}

/** Загружает изображение с проверкой статуса, MIME-типа и размера. */
export async function fetchImage(
  url: string,
  { timeoutMs, userAgent }: HttpOptions
): Promise<ImagePayload> {
  const response = await request(url, timeoutMs, userAgent, {
    Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
  });

  if (!response.ok) {
    throw new HttpStatusError(
      response.status,
      `HTTP ${response.status} ${response.statusText}: ${url}`
    );
  }

  // `image/jpeg; charset=binary` -> `image/jpeg`
  const contentType = (response.headers.get('content-type') ?? 'image/jpeg')
    .split(';')[0]
    ?.trim()
    .toLowerCase() ?? '';

  if (!contentType.startsWith('image/')) {
    throw new Error(`Not an image (content-type "${contentType}"): ${url}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length === 0) {
    throw new Error(`Image is empty: ${url}`);
  }

  if (buffer.length > IMAGE_MAX_BYTES) {
    throw new Error(
      `Image is too large (${buffer.length} bytes): ${url}`
    );
  }

  return { buffer, contentType };
}

/**
 * Ошибка запроса с сохранённым HTTP-статусом.
 *
 * Статус нужен вызывающему коду, чтобы решить, повторять ли попытку. Раньше
 * для этого приходилось разбирать строку сообщения, что ломалось на любом
 * переформулировании текста ошибки.
 */
export class HttpStatusError extends Error {
  /**
   * Что сервер просит ждать перед повтором, из заголовка `Retry-After`.
   *
   * Бесплатные модели отвечают на лимит `429` с `Retry-After`, и это точнее
   * любого собственного таймера: сервер прямо называет время ожидания.
   */
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly status: number,
    message: string,
    retryAfter?: string | null
  ) {
    super(message);
    this.name = 'HttpStatusError';
    this.retryAfterMs = parseRetryAfter(retryAfter);
  }
}

/**
 * `Retry-After` в секундах или в виде HTTP-даты.
 *
 * Возвращается `undefined`, если заголовка нет или он непонятен: вызывающий
 * код тогда применяет собственную задержку.
 */
function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();

  /*
   * Число в любом виде проверяется регуляркой, а не `Number()`: `Date.parse('-5')`
   * неожиданно даёт валидную дату, и мусорный заголовок превратился бы в
   * «повторить немедленно». Отрицательное ожидание смысла не имеет.
   */
  if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);

    return seconds >= 0 ? seconds * 1_000 : undefined;
  }

  const date = Date.parse(trimmed);

  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * Повторять ли запрос после такой ошибки.
 *
 * HTTP-статус известен в момент ответа, поэтому решение принимается по нему
 * самому. Исключения — 408 и 429: там сервер прямо просит повторить позже.
 * Остальные 4xx — это битый URL, и повторять его бессмысленно.
 */
export function isPermanentHttpError(error: unknown): boolean {
  return (
    error instanceof HttpStatusError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

/**
 * Повтор запроса имеет смысл.
 *
 * Ошибки сети и 5xx — это временно. Из 4xx повторяются только 408 и 429: там
 * сервер прямо просит подождать, а остальные — это битый адрес или отозванный
 * ключ, и повтор их только съедает лимит запросов.
 */
export function isTransientHttpError(error: unknown): boolean {
  if (error instanceof HttpStatusError) {
    return !isPermanentHttpError(error);
  }

  // Сетевой обрыв и таймаут: HttpStatusError здесь нет, значит запрос не дошёл.
  return error instanceof Error;
}

/**
 * Запрос с таймаутом и приведением отмены к понятной ошибке.
 *
 * Исключение таймаута приводится к Error прямо здесь: во всех вызывающих
 * местах это иначе дублировалось бы проверкой `error.name === 'AbortError'`.
 */
async function request(
  url: string,
  timeoutMs: number,
  userAgent: string,
  extraHeaders?: Record<string, string>,
  method = 'GET',
  body?: string
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      method,
      body,
      signal: controller.signal,
      headers: { 'User-Agent': userAgent, ...extraHeaders },
      redirect: 'follow'
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs} ms: ${url}`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}
/** Обрезанное тело ответа для сообщения об ошибке. */
function clip(raw: string): string {
  return raw.trim().slice(0, 300);
}

/**
 * Начало тела ответа для сообщения об ошибке.
 *
 * У API текст полезнее кода: «Access denied by security policy» сразу говорит,
 * что запрос не пройдёт и повторять его бессмысленно.
 */
function detail(raw: string): string {
  const text = clip(raw);

  return text ? ` — ${text}` : '';
}
