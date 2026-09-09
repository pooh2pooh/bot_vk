import { VK } from 'vk-io';

export function createVK(token: string): VK {
  return new VK({
    token
  });
}
