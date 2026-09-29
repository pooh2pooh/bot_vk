import type { BotDatabase } from '../db/database.js';
import type { Enricher } from '../core/enricher.js';
import type { SourceAdapter } from '../core/source-adapter.js';
import type { FeedEntry } from '../core/types.js';
import type { Logger } from '../logger/logger.js';
import type { TemplateManager } from '../templates/manager.js';
import type { VKSender } from '../vk/sender.js';
import { truncateText } from '../core/text-utils.js';
import { toMessage } from '../utils/to-message.js';

export interface SourcePipelineOptions {
  sourceId: string;
  sourceName: string;
  adapter: SourceAdapter;
  enricher: Enricher;
  db: BotDatabase;
  templates: TemplateManager;
  sender: VKSender;
  logger: Logger;
  targetChat: number;
  /**
   * Длина текста автора в fallback-сообщении (когда AI не ответил).
   * Текст укорачивается по границе слова. undefined — не укорачивать.
   */
  fallbackTextLimit?: number;
  /**
   * Достаёт исходный текст поста, когда его нет в фиде.
   *
   * Нужен сайтам вроде pingvinus, где у постов-скриншотов описание в RSS
   * пустое: без этого fallback-сообщение было бы вовсе без текста.
   */
  fetchOriginalText?: (link: string) => Promise<string>;
}

/**
 * Полный цикл обработки одного источника. Не знает, что такое RSS, LOR или
 * OpenRouter — всё специфичное приходит через SourceAdapter/Enricher.
 * Именно поэтому добавление нового источника не требует правки этого файла.
 */
export class SourcePipeline {
  readonly sourceId: string;
  readonly sourceName: string;

  constructor(private readonly options: SourcePipelineOptions) {
    this.sourceId = options.sourceId;
    this.sourceName = options.sourceName;
  }

  async initialize(): Promise<void> {
    const entries = await this.options.adapter.fetch();

    let added = 0;
    let ignored = 0;

    for (const entry of entries) {
      if (!this.options.db.hasFeedEntry(entry.id)) {
        this.options.db.addFeedEntry(entry);
        added++;
      }

      /*
       * При старте текущий снимок фида считается уже обработанным.
       * Это НЕ ставит sent_at: запись не считается отправленной в VK.
       */
      if (!this.options.db.getEntryHandledStatus(entry.id)) {
        this.options.db.markIgnored(entry.id);
        ignored++;
      }
    }

    this.options.logger.info(
      [
        `Feed initialized (${this.sourceName}): ${entries.length} entries.`,
        `Added: ${added}.`,
        `Ignored on startup: ${ignored}.`
      ].join(' '),
      false
    );
  }

  async check(): Promise<number> {
    /*
     * Уже обработанные посты передаём адаптеру ЗАРАНЕЕ, и тот не разбирает их:
     * извлечение картинок у части экстракторов ходит на страницу поста, и без
     * этого подсказка каждый poll делал бы десятки лишних HTTP-запросов к сайту
     * ради постов, которые всё равно были бы отброшены. Список берётся одним
     * запросом вместо проверки по одному на каждый элемент фида.
     */
    const entries = await this.options.adapter.fetch({
      skipIds: this.options.db.getHandledEntryIds()
    });

    if (entries.length === 0) {
      this.options.logger.debug(
        `Feed check (${this.sourceName}): no new entries.`
      );
      return 0;
    }

    let sent = 0;

    // Порядок публикации важен: даты уже в ISO, поэтому достаточно строкового
    // сравнения — new Date() в компараторе создавал бы объект на КАЖДОЕ
    // сравнение, то есть O(n log n) раз за сортировку.
    const sorted = [...entries].sort((a, b) => a.published.localeCompare(b.published));

    for (const entry of sorted) {
      await this.processNewEntry(entry);
      sent++;
    }

    if (sent > 0) {
      this.options.logger.info(
        `Feed check completed (${this.sourceName}): sent ${sent} new post(s).`
      );
    } else {
      this.options.logger.debug(`Feed check (${this.sourceName}): no new entries.`);
    }

    return sent;
  }

  async resendLatest(): Promise<FeedEntry> {
    const latest = this.options.db.getLatestEntry(this.sourceId);

    if (!latest) {
      throw new Error(`Feed contains no saved entries (${this.sourceName}).`);
    }

    const imageUrls = await this.refreshImages(latest);
    const prepared = await this.prepareEntry(latest);

    await this.deliver(prepared.entry, imageUrls);

    this.options.logger.info(
      `Latest post resent (${this.sourceName}): ` +
        `"${latest.title}" ${this.deliveryLog(prepared, imageUrls)}`
    );

    return latest;
  }

  /**
   * Общая часть отправки для resend и нового поста: рендер, отправка, разбор
   * ошибок картинок и отметка в базе.
   *
   * Раньше эти шесть строк были продублированы в двух методах, и правка
   * (например, формат лога или порядок markSent) неизбежно расходилась.
   */
  private async deliver(
    entry: FeedEntry,
    imageUrls: string[]
  ): Promise<void> {
    const message = this.options.templates.render(this.sourceId, entry);

    await this.options.sender.send(this.options.targetChat, message, imageUrls);
    this.logImageFailures(entry);
    this.options.db.markSent(entry.id);
  }

  private deliveryLog(
    prepared: { enrichFailed: boolean },
    imageUrls: string[]
  ): string {
    return [
      `images=${imageUrls.length}`,
      prepared.enrichFailed ? 'enrich: fallback на исходное содержимое' : ''
    ]
      .filter(Boolean)
      .join(' ');
  }

  /**
   * Переизвлекает картинки для переотправки и, если значение изменилось,
   * обновляет запись в базе — иначе следующий resend снова отправил бы
   * устаревшее.
   *
   * Ошибка переизвлечения НЕ пробрасывается: цель resend — отправить пост, а
   * не проверить сеть. Лучше отправить пост с одним скриншотом из базы, чем
   * не отправить его вовсе.
   */
  private async refreshImages(entry: FeedEntry): Promise<string[]> {
    const reextract = this.options.adapter.reextractImages;

    if (!reextract) {
      return entry.imageUrls;
    }

    try {
      const fresh = await reextract.call(
        this.options.adapter,
        entry.id,
        entry.link
      );

      if (!fresh || fresh.length === 0) {
        return entry.imageUrls;
      }

      if (fresh.length !== entry.imageUrls.length) {
        this.options.db.updateEntryImages(entry.id, fresh);
        this.options.logger.info(
          `Обновлены картинки при переотправке (${this.sourceName}): ` +
            `${entry.imageUrls.length} -> ${fresh.length}`
        );
      }

      return fresh;
    } catch (error) {
      this.options.logger.warn(
        `Не удалось переизвлечь картинки для переотправки (${this.sourceName}): ` +
          toMessage(error)
      );

      return entry.imageUrls;
    }
  }

  private async processNewEntry(entry: FeedEntry): Promise<void> {
    this.options.db.addFeedEntry(entry);

    // Ошибку пробрасываем наружу: внешний планировщик отвечает за backoff/лог,
    // чтобы одна и та же ошибка не логировалась дважды.
    const prepared = await this.prepareEntry(entry);

    await this.deliver(prepared.entry, entry.imageUrls);

    this.options.logger.info(
      `New post sent (${this.sourceName}): "${entry.title}" ` +
        `by ${entry.author} ${this.deliveryLog(prepared, entry.imageUrls)}`
    );
  }

  private async prepareEntry(
    entry: FeedEntry
  ): Promise<{ entry: FeedEntry; enrichFailed: boolean }> {
    try {
      const result = await this.options.enricher.enrich(entry);
      return { entry: result.entry, enrichFailed: false };
    } catch (error) {
      // Обогащение (например, AI) не должно блокировать пересылку самого поста.
      this.options.logger.error(
        `Enrich failed for "${entry.title}" (${this.sourceName}): ${toMessage(error)}`
      );

      return {
        entry: await this.buildFallbackEntry(entry),
        enrichFailed: true
      };
    }
  }

  /**
   * Собирает запись для отправки без AI-комментария.
   *
   * Текст автора укорачивается по границе слова, если источник задал
   * fallbackTextLimit: полный текст не влезает в сообщение, а обрыв на
   * полуслове выглядит небрежно.
   *
   * Если в фиде текста нет (pingvinus отдаёт пустое описание) — он берётся
   * со страницы поста. Иначе в сообщение ушёл бы только заголовок.
   */
  private async buildFallbackEntry(entry: FeedEntry): Promise<FeedEntry> {
    const limit = this.options.fallbackTextLimit;

    if (limit === undefined) {
      return entry;
    }

    let content = entry.content;

    if (!content.trim()) {
      content = await this.fetchOriginalText(entry);
    }

    const truncated = truncateText(content, limit);

    // Возвращаем запись всегда: даже когда обрезка ничего не изменила, контент
    // мог подмениться текстом со страницы (в фиде у pingvinus он пустой).
    // Ранний выход по `truncated === content` тихо выбрасывал бы этот текст.
    return { ...entry, content: truncated };
  }

  /**
   * Достаёт исходный текст поста со страницы.
   * Ошибка не пробрасывается: fallback и так уже работает «похуже» — лучше
   * отправить пост без текста, чем не отправить его вовсе.
   */
  private async fetchOriginalText(entry: FeedEntry): Promise<string> {
    const fetchText = this.options.fetchOriginalText;

    if (!fetchText) {
      return '';
    }

    try {
      return await fetchText(entry.link);
    } catch (error) {
      this.options.logger.warn(
        `Не удалось получить исходный текст поста (${this.sourceName}): ` +
          toMessage(error)
      );

      return '';
    }
  }

  private logImageFailures(entry: FeedEntry): void {
    for (const failure of this.options.sender.consumeImageErrors()) {
      this.options.logger.error(
        [
          '🖼 Ошибка загрузки изображения',
          `Источник: ${this.sourceName}`,
          `Пост: ${entry.title}`,
          `URL: ${failure.url}`,
          `Причина: ${failure.message}`
        ].join('\n')
      );
    }
  }
}
