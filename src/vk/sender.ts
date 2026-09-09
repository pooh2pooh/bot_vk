import { randomInt } from 'node:crypto';

import type { VK } from 'vk-io';

export class VKSender {
  constructor(
    private readonly vk: VK,
    private readonly retries = 3
  ) {}

  async send(
    peerId: number,
    message: string
  ): Promise<number> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.retries; attempt++) {
      try {
        const result = await this.vk.api.messages.send({
          peer_id: peerId,
          random_id: randomInt(1, 2_147_483_647),
          message
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
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
