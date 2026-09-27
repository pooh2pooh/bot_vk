import { readFile } from 'node:fs/promises';

import type { Enricher, EnrichResult } from '../core/enricher.js';
import type { FeedEntry } from '../core/types.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_REPAIR_ATTEMPTS = 1;
const MAX_REPAIR_TOKENS = 1200;

interface OpenRouterResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

export interface OpenRouterEnricherOptions {
  apiKey: string;
  model: string;
  modelName: string;
  promptPath: string;
  timeoutMs: number;
  maxTokens: number;
}

/**
 * Заменяет текст записи на один AI-комментарий, а автора — на имя модели.
 * При плохом формате ответа или обрезании модель получает один повторный
 * запрос с более жёсткой инструкцией и большим лимитом ответа.
 */
export class OpenRouterEnricher implements Enricher {
  private prompt = '';

  constructor(private readonly options: OpenRouterEnricherOptions) {}

  getModelName(): string {
    return this.options.modelName;
  }

  getModel(): string {
    return this.options.model;
  }

  getPromptPath(): string {
    return this.options.promptPath;
  }

  async loadPrompt(): Promise<void> {
    this.prompt = (await readFile(this.options.promptPath, 'utf8')).trim();

    if (!this.prompt) {
      throw new Error(`AI prompt is empty: ${this.options.promptPath}`);
    }
  }

  async enrich(entry: FeedEntry): Promise<EnrichResult> {
    if (!this.prompt) {
      await this.loadPrompt();
    }

    const startedAt = Date.now();
    const comment = await this.requestComment(entry);
    const durationMs = Date.now() - startedAt;

    return {
      entry: {
        ...entry,
        author: this.options.modelName,
        content: comment
      },
      meta: {
        durationMs,
        model: this.options.modelName
      }
    };
  }

  private async requestComment(
    entry: FeedEntry,
    repairAttempt = 0,
    maxTokens = Math.max(this.options.maxTokens, 600)
  ): Promise<string> {
    const userMessage = this.buildUserMessage(entry, repairAttempt > 0);

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs
    );

    try {
      const response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'VK Feed Bot'
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: [
            { role: 'system', content: this.prompt },
            { role: 'user', content: userMessage }
          ],
          max_tokens: maxTokens
        })
      });

      const raw = await response.text();
      let data: OpenRouterResponse = {};

      try {
        data = JSON.parse(raw) as OpenRouterResponse;
      } catch {
        // Ниже будет понятная ошибка с HTTP-кодом и сырым телом.
      }

      if (!response.ok) {
        throw new Error(
          `OpenRouter HTTP ${response.status}: ${
            data.error?.message ?? raw.slice(0, 500)
          }`
        );
      }

      const choice = data.choices?.[0];
      const comment = choice?.message?.content?.trim();

      if (!comment) {
        throw new Error('OpenRouter returned an empty AI comment.');
      }

      // OpenRouter помечает ответ finish_reason=length, когда он упёрся
      // в max_tokens. Повторяем один раз с увеличенным лимитом.
      if (
        choice?.finish_reason === 'length' &&
        repairAttempt < MAX_REPAIR_ATTEMPTS
      ) {
        return this.requestComment(
          entry,
          repairAttempt + 1,
          Math.min(maxTokens * 2, MAX_REPAIR_TOKENS)
        );
      }

      // Проверяем исходный ответ ДО нормализации: иначе normalizeComment()
      // уже удалит маркеры вариантов, и corrective retry не сработает.
      if (
        this.looksLikeMultipleVariants(comment) &&
        repairAttempt < MAX_REPAIR_ATTEMPTS
      ) {
        return this.requestComment(
          entry,
          repairAttempt + 1,
          Math.min(maxTokens * 2, MAX_REPAIR_TOKENS)
        );
      }

      return this.normalizeComment(comment);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `OpenRouter timeout after ${this.options.timeoutMs} ms`
        );
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildUserMessage(entry: FeedEntry, repair: boolean): string {
    return [
      repair
        ? 'ПРЕДЫДУЩИЙ ОТВЕТ НАРУШИЛ ФОРМАТ. Сейчас нужен только один готовый комментарий без вариантов, заголовков и объяснений.'
        : 'Напиши один готовый комментарий к посту.',
      '',
      `Заголовок поста: ${entry.title}`,
      `Автор поста: ${entry.author}`,
      '',
      'Текст поста:',
      '<<<BEGIN_POST>>>',
      entry.content.trim(),
      '<<<END_POST>>>',
      '',
      'Не пересказывай исходный текст и не копируй ссылку. Верни только итоговый комментарий.'
    ].join('\n');
  }

  private normalizeComment(value: string): string {
    let text = value
      .replace(/^```(?:text|markdown)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .replace(/\r/g, '')
      .trim();

    // Если модель всё же сгенерировала несколько вариантов, оставляем только
    // первый полноценный вариант как аварийный fallback.
    const firstVariant = text.match(
      /(?:^|\n)\s*(?:#{1,6}\s*)?Вариант\s*1\s*[:.)-]?\s*/i
    );
    const secondVariant = text.match(
      /(?:\n)\s*(?:#{1,6}\s*)?Вариант\s*2\s*[:.)-]?\s*/i
    );

    if (firstVariant) {
      const start = (firstVariant.index ?? 0) + firstVariant[0].length;
      text = text.slice(start);
      if (secondVariant) {
        const marker = text.search(
          /(?:^|\n)\s*(?:#{1,6}\s*)?Вариант\s*2\s*[:.)-]?\s*/i
        );
        if (marker >= 0) {
          text = text.slice(0, marker);
        }
      }
    }

    text = text
      .replace(/^\s*(?:вот\s+)?(?:итоговый\s+)?(?:комментарий|ответ)\s*:\s*/i, '')
      .trim();

    // Убираем лишние пустые строки, но не ломаем нормальный многострочный текст.
    return text.replace(/\n{3,}/g, '\n\n').trim();
  }

  private looksLikeMultipleVariants(value: string): boolean {
    return (
      /(?:^|\n)\s*(?:#{1,6}\s*)?Вариант\s*1\b/i.test(value) ||
      /(?:^|\n)\s*(?:#{1,6}\s*)?Вариант\s*2\b/i.test(value) ||
      /\bвот\s+(?:два|три|несколько)\s+вариант/i.test(value)
    );
  }
}
