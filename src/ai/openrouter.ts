import { readFile } from 'node:fs/promises';

import type { FeedEntry } from '../types.js';

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

export interface AICommentResult {
  comment: string;
  model: string;
  durationMs: number;
}

export class OpenRouterCommentService {
  private prompt = '';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly modelName: string,
    private readonly promptPath: string,
    private readonly timeoutMs: number,
    private readonly maxTokens: number
  ) {}

  getModelName(): string {
    return this.modelName;
  }

  getModel(): string {
    return this.model;
  }

  getPromptPath(): string {
    return this.promptPath;
  }

  async loadPrompt(): Promise<void> {
    this.prompt = (
      await readFile(this.promptPath, 'utf8')
    ).trim();

    if (!this.prompt) {
      throw new Error(
        `AI prompt is empty: ${this.promptPath}`
      );
    }
  }

  async generate(entry: FeedEntry): Promise<AICommentResult> {
    if (!this.prompt) {
      await this.loadPrompt();
    }

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
      this.timeoutMs
    );
    const startedAt = Date.now();

    try {
      const response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'Manjaro VK Bot'
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'system',
              content: this.prompt
            },
            {
              role: 'user',
              content: userMessage
            }
          ],
          max_tokens: this.maxTokens
        })
      });

      const raw = await response.text();
      let data: OpenRouterResponse = {};

      try {
        data = JSON.parse(raw) as OpenRouterResponse;
      } catch {
        // Ниже будет понятная ошибка с HTTP-кодом.
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
        throw new Error(
          'OpenRouter returned an empty AI comment.'
        );
      }

      return {
        comment,
        model: this.modelName,
        durationMs: Date.now() - startedAt
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'AbortError'
      ) {
        throw new Error(
          `OpenRouter timeout after ${this.timeoutMs} ms`
        );
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
