import { randomInt } from 'node:crypto';

import type { VK } from 'vk-io';

const VK_MAX_ATTACHMENTS_PER_MESSAGE = 10;

export class VKSender {
  constructor(
    private readonly vk: VK,
    private readonly retries = 3
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

    /*
     * VK ограничивает одно сообщение десятью вложениями.
     * Поэтому при большем количестве изображений создаём
     * несколько сообщений: текст только в первом, остальные
     * содержат продолжение галереи.
     */
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
      return this.sendMessage(
        peerId,
        message,
        []
      );
    }

    let lastMessageId = 0;

    for (let index = 0; index < batches.length; index++) {
      const batch = batches[index];

      lastMessageId = await this.sendMessage(
        peerId,
        index === 0
          ? message
          : `📸 Продолжение галереи (${index + 1}/${batches.length})`,
        batch
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

    // Один random_id на конкретное сообщение и его retries.
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
          const attachment =
            await this.vk.upload.messagePhoto({
              source: {
                value: imageUrl
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

  private delay(ms: number): Promise<void> {
    return new Promise(resolve =>
      setTimeout(resolve, ms)
    );
  }
}
