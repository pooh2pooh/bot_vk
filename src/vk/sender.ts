import { randomInt } from 'node:crypto';

import type { VK } from 'vk-io';

import type { ImageDownloadFailure } from '../core/types.js';
import { toMessage } from '../utils/to-message.js';

const VK_MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** Ошибка запроса картинки с сохранённым HTTP-статусом. */
class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    statusText: string
  ) {
    super(`Image request failed: HTTP ${status} ${statusText}`);
  }
}

/**
 * Стоит ли повторять запрос после этой ошибки.
 *
 * HTTP-статус известен в момент ответа, поэтому решение принимается по нему
 * самому, а не разбором строки сообщения. Исключения — 408 и 429: там сервер
 * прямо просит повторить позже.
 */
function isPermanentHttpError(error: unknown): boolean {
  if (!(error instanceof HttpStatusError)) {
    return false;
  }

  const { status } = error;

  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** Отрезает параметры от MIME-типа: `image/jpeg; charset=binary` -> `image/jpeg`. */
function bareContentType(value: string): string {
  return value.split(';', 1).join('').trim();
}

export interface VKSenderOptions {
  vk: VK;
  /** Попыток отправки сообщения в VK (с задержкой 1с * номер попытки). */
  retries?: number;
  /** Попыток скачивания одной картинки (с задержкой 1.5с * номер попытки). */
  imageDownloadRetries?: number;
  imageDownloadTimeoutMs?: number;
  uploadTimeoutMs?: number;
  /** Тот же User-Agent, что и для RSS-запросов: часть сайтов режет кадры ботов. */
  userAgent?: string;
  /**
   * Пауза между попытками. Продёргивается в тестах, иначе проверка повторов
   * на настоящих таймерах шла бы на секунды.
   */
  sleep?: (ms: number) => Promise<void>;
}

export class VKSender {
  private readonly vk: VK;
  private readonly imageErrors: ImageDownloadFailure[] = [];

  private readonly retries: number;
  private readonly imageDownloadRetries: number;
  private readonly imageDownloadTimeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly userAgent: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: VKSenderOptions) {
    this.vk = options.vk;
    this.retries = options.retries ?? 3;
    this.imageDownloadRetries = options.imageDownloadRetries ?? 3;
    this.imageDownloadTimeoutMs = options.imageDownloadTimeoutMs ?? 60_000;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? 90_000;
    this.userAgent = options.userAgent ?? 'VK-Feed-Bot/2.0';
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Забирает ошибки картинок после send() и очищает накопитель. */
  consumeImageErrors(): ImageDownloadFailure[] {
    return this.imageErrors.splice(0);
  }

  async send(
    peerId: number,
    message: string,
    imageUrls: string[] = []
  ): Promise<number> {
    const uniqueImages = [
      ...new Set(
        imageUrls
          .map(url => url.trim())
          .filter(Boolean)
      )
    ];

    const batches: string[][] = [];

    for (
      let i = 0;
      i < uniqueImages.length;
      i += VK_MAX_ATTACHMENTS_PER_MESSAGE
    ) {
      batches.push(
        uniqueImages.slice(
          i,
          i + VK_MAX_ATTACHMENTS_PER_MESSAGE
        )
      );
    }

    if (batches.length === 0) {
      return this.sendMessage(peerId, message, []);
    }

    let lastMessageId = 0;

    for (let index = 0; index < batches.length; index++) {
      lastMessageId = await this.sendMessage(
        peerId,
        index === 0
          ? message
          : `📸 Продолжение галереи (${index + 1}/${batches.length})`,
        batches[index] ?? []
      );
    }

    return lastMessageId;
  }

  private async sendMessage(
    peerId: number,
    message: string,
    imageUrls: string[]
  ): Promise<number> {
    let lastError: unknown;

    const randomId = randomInt(
      1,
      2_147_483_647
    );

    for (
      let attempt = 1;
      attempt <= this.retries;
      attempt++
    ) {
      try {
        const attachments = [];

        for (const imageUrl of imageUrls) {
          let image: Awaited<ReturnType<typeof this.downloadImage>>;

          try {
            image = await this.downloadImage(imageUrl);
          } catch (error) {
            // Битая/недоступная картинка не должна ломать весь пост.
            this.imageErrors.push({
              url: imageUrl,
              message: toMessage(error)
            });
            continue;
          }

          // Ошибка загрузки уже в VK остаётся фатальной для текущей попытки:
          // внешний retry должен повторить upload, а не молча терять картинку.
          const attachment =
            await this.vk.upload.messagePhoto({
              peer_id: peerId,
              source: {
                values: [{
                  value: image.buffer,
                  filename: image.filename,
                  contentType: image.contentType,
                  contentLength: image.buffer.length
                }],
                timeout: this.uploadTimeoutMs
              }
            });

          attachments.push(attachment);
        }

        const result =
          await this.vk.api.messages.send({
            peer_id: peerId,
            random_id: randomId,
            message,
            attachment:
              attachments.length > 0
                ? attachments
                : undefined
          });

        return Number(result);
      } catch (error) {
        lastError = error;

        if (attempt < this.retries) {
          await this.sleep(attempt * 1000);
        }
      }
    }

    throw lastError;
  }

  private async downloadImage(
    url: string
  ): Promise<{
    buffer: Buffer;
    filename: string;
    contentType: string;
  }> {
    let lastError: unknown;

    for (
      let attempt = 1;
      attempt <= this.imageDownloadRetries;
      attempt++
    ) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.imageDownloadTimeoutMs
      );

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': this.userAgent,
            Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
          },
          redirect: 'follow'
        });

        if (!response.ok) {
          throw new HttpStatusError(response.status, response.statusText);
        }

        const contentType =
          bareContentType(
            response.headers.get('content-type') ?? 'image/jpeg'
          );

        if (!contentType.toLowerCase().startsWith('image/')) {
          throw new Error(
            `Image URL returned unexpected content-type: ${contentType}`
          );
        }

        const buffer = Buffer.from(
          await response.arrayBuffer()
        );

        if (buffer.length === 0) {
          throw new Error('Downloaded image is empty.');
        }

        return {
          buffer,
          contentType,
          filename: this.getFilename(url, contentType)
        };
      } catch (error) {
        const failure =
          error instanceof Error && error.name === 'AbortError'
            ? new Error(
                `Image download timeout after ${this.imageDownloadTimeoutMs} ms: ${url}`
              )
            : error;

        lastError = failure;

        // 4xx — это почти всегда битый URL, а не временная проблема сети.
        // Повторять такой запрос бессмысленно, поэтому выходим сразу, кроме
        // двух случаев, когда сервер прямо просит подождать.
        if (isPermanentHttpError(failure)) {
          break;
        }
      } finally {
        clearTimeout(timeout);
      }

      if (attempt < this.imageDownloadRetries) {
        await this.sleep(attempt * 1500);
      }
    }

    throw lastError;
  }

  private getFilename(
    url: string,
    contentType: string
  ): string {
    try {
      const pathname = new URL(url).pathname;
      const name = pathname
        .split('/')
        .pop()
        ?.trim();

      if (name && /\.[a-z0-9]{2,5}$/i.test(name)) {
        return name.slice(0, 120);
      }
    } catch {
      // Используем MIME-тип ниже.
    }

    const extension =
      contentType
        .split('/')
        .pop()
        ?.replace(/[^a-z0-9]/gi, '') || 'jpg';

    return `screenshot.${extension}`;
  }

}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
