import { readFile } from 'node:fs/promises';

import { fetchJson, HttpStatusError, isTransientHttpError } from '../core/http.js';
import type { Enricher, EnrichResult } from '../core/enricher.js';
import { toMessage } from '../utils/to-message.js';
import type { FeedEntry } from '../core/types.js';

/**
 * Единственный способ генерации текста в проекте.
 *
 * Класс сознательно обобщённый: он ничего не знает про то, ЧТО именно пишет
 * модель. Перевод анонса, разбор релиза, описание скриншота — всё это задачи
 * из промпта источника (`promptPath` в config/sources.yml). Поэтому здесь нет
 * ни «комментария», ни «перевода»: только запрос и проверка ответа.
 *
 * Обмен с API идёт через общий `core/http.ts`, поэтому таймаут, User-Agent и
 * приведение отмены к ошибке не дублируются.
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/** OpenRouter отбрасывает запросы с пустым User-Agent, как и сайты с фидами. */
const USER_AGENT = 'vk-feed-bot/1.0';

/**
 * Потолок ожидания перед повтором.
 *
 * Длинная пауза хуже отказа: цикл опроса источника стоит, а пост всё равно
 * уйдёт с текстом автора.
 */
const MAX_RETRY_DELAY_MS = 15_000;

/** Ответ, обрезанный лимитом токенов, почти всегда обрывается на полуслове. */
const REPAIRED_TOKEN_LIMIT = 1_200;

/** Ниже этого модель почти наверняка ответила пустотой или обрывом. */
const MIN_TOKEN_LIMIT = 600;

interface OpenRouterResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string };
  }>;
  error?: { message?: string };
}

export interface OpenRouterEnricherOptions {
  apiKey: string;
  /** Технический идентификатор модели, например `z-ai/glm-5.2:free`. */
  model: string;
  /** Имя модели для подписи в сообщении. */
  modelName: string;
  timeoutMs: number;
  maxTokens: number;

  /** Сколько раз пробовать при временном сбое: 1 — без повторов. */
  maxAttempts?: number;
  /** Задержка перед повтором, если сервер не прислал `Retry-After`. */
  retryDelayMs?: number;
  /** Подмена ожидания: тестам не нужно ждать реальные секунды. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Заменяет текст записи на сгенерированный, а автора — на имя модели.
 *
 * Модель умеет ответить плохо: вернуть обрезанный текст, несколько вариантов
 * или обёртку ответа в markdown. На каждый такой случай делается ОДИН повторный
 * запрос с более жёсткой инструкцией и увеличенным лимитом. Дальше — нет: один
 * неудачный ответ источника не должен превращаться в десяток запросов к
 * бесплатной модели и задержать всю отправку.
 */
export class OpenRouterEnricher implements Enricher {
  private prompt = '';

  constructor(private readonly options: OpenRouterEnricherOptions) {}

  private get attempts(): number {
    return Math.max(1, this.options.maxAttempts ?? 3);
  }

  private get retryDelayMs(): number {
    return this.options.retryDelayMs ?? 2_000;
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep
      ? this.options.sleep(ms)
      : new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Имя модели для подписи в сообщении. */
  get modelName(): string {
    return this.options.modelName;
  }

  /**
   * Читает промпт источника.
   *
   * Вызывается один раз при старте для каждого источника: ленивая загрузка
   * внутри `enrich()` означала бы чтение файла на каждом посте.
   */
  async loadPrompt(promptPath: string, sourceId?: string): Promise<void> {
    /*
     * Ошибка чтения обёрнута: голый `ENOENT` не говорит, какой из нескольких
     * промптов отсутствует, а промптов теперь по одному на источник.
     */
    let text: string;

    try {
      text = (await readFile(promptPath, 'utf8')).trim();
    } catch (error) {
      throw new Error(
        `Cannot read AI prompt${sourceId ? ` for source "${sourceId}"` : ''}: ` +
          `${promptPath} — ${toMessage(error)}`
      );
    }

    if (!text) {
      throw new Error(
        `AI prompt is empty${sourceId ? ` for source "${sourceId}"` : ''}: ${promptPath}`
      );
    }

    this.prompt = text;
  }

  async enrich(entry: FeedEntry): Promise<EnrichResult> {
    const startedAt = Date.now();
    const text = await this.generate(entry);

    return {
      entry: {
        ...entry,
        author: this.options.modelName,
        content: text
      },
      meta: {
        durationMs: Date.now() - startedAt,
        model: this.options.modelName
      }
    };
  }

  /**
   * Один запрос и, если нужно, один повторный.
   *
   * Условия повтора собраны в одну функцию: две одинаковые ветки с одинаковым
   * телом разъезжались при любой правке и читались как копипаст.
   */
  private async generate(entry: FeedEntry): Promise<string> {
    const limit = Math.max(this.options.maxTokens, MIN_TOKEN_LIMIT);
    const raw = await this.complete(this.buildUserMessage(entry, false), limit);

    if (this.needsRepair(raw)) {
      const repaired = await this.complete(
        this.buildUserMessage(entry, true),
        Math.min(limit * 2, REPAIRED_TOKEN_LIMIT)
      );

      return normalizeText(repaired.text);
    }

    return normalizeText(raw.text);
  }

  /** Признаки плохого ответа, которые ещё можно исправить повтором. */
  private needsRepair(raw: { text: string; truncated: boolean }): boolean {
    return raw.truncated || looksLikeMultipleVariants(raw.text);
  }

  /** Запрос к API. Ошибка пробрасывается: вызывающий код решает судьбу поста. */
  private async complete(
    userMessage: string,
    maxTokens: number
  ): Promise<{ text: string; truncated: boolean }> {
    /*
     * Бесплатные модели лимитируются по общему пулу, и 429 на них — обычное
     * дело, а не поломка конфигурации. Без повторов такой пост уходил бы с
     * текстом автора навсегда, хотя через пару секунд модель ответила бы.
     * Повтор делается только для временных сбоев; битый ключ повторов не
     * получает, иначе бот выжигал бы лимит запросов впустую.
     */
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        return await this.request(userMessage, maxTokens);
      } catch (error) {
        lastError = error;

        if (attempt === this.attempts || !isTransientHttpError(error)) {
          throw error;
        }

        const retryAfter = error instanceof HttpStatusError ? error.retryAfterMs : undefined;
        // Своя задержка растёт, но серверный `Retry-After` главнее: он и есть
        // ответ на вопрос «когда можно повторять».
        const delay = Math.min(
          retryAfter ?? this.retryDelayMs * attempt,
          MAX_RETRY_DELAY_MS
        );

        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  private async request(
    userMessage: string,
    maxTokens: number
  ): Promise<{ text: string; truncated: boolean }> {
    const data = await fetchJson<OpenRouterResponse>(
      ENDPOINT,
      {
        model: this.options.model,
        messages: [
          { role: 'system', content: this.prompt },
          { role: 'user', content: userMessage }
        ],
        max_tokens: maxTokens
      },
      {
        timeoutMs: this.options.timeoutMs,
        // OpenRouter показывает название приложения в статистике запросов.
        userAgent: USER_AGENT,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'X-Title': 'VK Feed Bot'
        }
      }
    );

    const choice = data.choices?.[0];
    const text = choice?.message?.content?.trim();

    if (!text) {
      throw new Error(
        `OpenRouter returned an empty response${data.error ? `: ${data.error.message}` : ''}`
      );
    }

    return { text, truncated: choice?.finish_reason === 'length' };
  }

  /**
   * Данные поста в устойчивых маркерах.
   *
   * Маркеры нужны, чтобы модель не спутала границу: сам анонс может содержать
   * что угодно, включая текст, похожий на инструкцию. Задачу здесь не задаём —
   * её целиком определяет промпт источника.
   */
  private buildUserMessage(entry: FeedEntry, repair: boolean): string {
    const post = [
      `Заголовок: ${entry.title}`,
      `Автор: ${entry.author}`,
      entry.content.trim()
    ]
      .filter(Boolean)
      .join('\n');

    const instruction = repair
      ? 'ПРЕДЫДУЩИЙ ОТВЕТ НАРУШИЛ ФОРМАТ. Нужен только один готовый текст: без вариантов, заголовков и объяснений.'
      : 'Сделай пост по инструкции из системного промпта.';

    return [
      instruction,
      '',
      '<<<BEGIN_POST>>>',
      post,
      '<<<END_POST>>>'
    ].join('\n');
  }
}

/**
 * Приводит ответ модели к тексту поста.
 *
 * Здесь только то, что модель делает ПОМИМО ВОЛИ, и что нельзя убрать в
 * промптом: markdown-обёртка, подпись ответа, повторные пустые строки.
 * Содержательные правки текста не делаются — это работа промпта.
 */
function normalizeText(value: string): string {
  return value
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/^\s*(?:вот\s+)?(?:итоговый\s+)?(?:комментарий|ответ|текст|пост)\s*:\s*/i, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Признак того, что модель вернула несколько вариантов вместо одного текста.
 *
 * Проверяется ДО нормализации: normalizeText() срезает подпись ответа, и после
 * неё тот же дефект уже не виден.
 */
function looksLikeMultipleVariants(value: string): boolean {
  return (
    /(?:^|\n)\s*(?:#{1,6}\s*)?Вариант\s*1\b/i.test(value) ||
    /(?:^|\n)\s*(?:#{1,6}\s*)?Вариант\s*2\b/i.test(value) ||
    /\bвот\s+(?:два|три|несколько)\s+вариант/i.test(value)
  );
}