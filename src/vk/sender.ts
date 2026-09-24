import { randomInt } from 'node:crypto';

import type { VK } from 'vk-io';

const VK_MAX_ATTACHMENTS_PER_MESSAGE = 10;
const IMAGE_DOWNLOAD_RETRIES = 3;

export class VKSender {
  constructor(
    private readonly vk: VK,
    private readonly retries = 3,
    private readonly imageDownloadTimeoutMs = 60_000,
    private readonly uploadTimeoutMs = 90_000
  ) {}

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
        batches[index]
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
          const image = await this.downloadImage(imageUrl);

          // timeout относится именно к запросу загрузки в VK.
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
          await this.delay(attempt * 1000);
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
      attempt <= IMAGE_DOWNLOAD_RETRIES;
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
            'User-Agent': 'ManjaroRU-VK-Feed-Bot/1.0',
            Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
          },
          redirect: 'follow'
        });

        if (!response.ok) {
          throw new Error(
            `Image request failed: HTTP ${response.status} ${response.statusText}`
          );
        }

        const contentType =
          response.headers.get('content-type') ??
          'image/jpeg';

        if (
          contentType &&
          !contentType.toLowerCase().startsWith('image/')
        ) {
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
          contentType: contentType.split(';', 1)[0],
          filename: this.getFilename(url, contentType)
        };
      } catch (error) {
        lastError =
          error instanceof Error &&
          error.name === 'AbortError'
            ? new Error(
                `Image download timeout after ${this.imageDownloadTimeoutMs} ms: ${url}`
              )
            : error;
      } finally {
        clearTimeout(timeout);
      }

      if (attempt < IMAGE_DOWNLOAD_RETRIES) {
        await this.delay(attempt * 1500);
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
        .split(';', 1)[0]
        .split('/')
        .pop()
        ?.replace(/[^a-z0-9]/gi, '') || 'jpg';

    return `screenshot.${extension}`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve =>
      setTimeout(resolve, ms)
    );
  }
}
