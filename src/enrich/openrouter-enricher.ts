import { readFile } from 'node:fs/promises';

import type { Enricher, EnrichResult } from '../core/enricher.js';
import type { FeedEntry } from '../core/types.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

interface OpenRouterResponse {
  choices?: Array<{
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
 * Заменяет текст записи на AI-комментарий, а автора — на имя модели.
 * Ошибки этого класса никогда не выбрасываются наружу как фатальные для
 * поста: SourcePipeline перехватывает их и использует entry без изменений.
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

  private async requestComment(entry: FeedEntry): Promise<string> {
    const userMessage = [
      `Заголовок: ${entry.title}`,
      `Автор: ${entry.author}`,
      '',
      'Текст автора:',
      '<<<',
      entry.content.trim(),
      '>>>'
    ].join('\n');

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
          max_tokens: this.options.maxTokens
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

      const comment = data.choices?.[0]?.message?.content?.trim();

      if (!comment) {
        throw new Error('OpenRouter returned an empty AI comment.');
      }

      return comment;
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
}
