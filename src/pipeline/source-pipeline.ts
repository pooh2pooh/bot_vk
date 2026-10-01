import type { BotDatabase, StoredEntry } from '../db/database.js';
import type { Enricher } from '../core/enricher.js';
import type { Filter } from '../core/filter.js';
import type { SourceAdapter } from '../core/source-adapter.js';
import type { TextMode } from '../core/text-mode.js';
import type { FeedEntry } from '../core/types.js';
import type { Logger } from '../logger/logger.js';
import type { TemplateManager } from '../templates/manager.js';
import type { VKSender } from '../vk/sender.js';
import { truncateText } from '../core/text.js';
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

  /** Что отправлять в сообщении, когда генерация не применяется. */
  textMode: TextMode;
  /** Длина текста фида в сообщении, символов. */
  textLimit: number;
  /**
   * Генерировать текст только для постов с подходящим заголовком.
   *
   * Нужен фидам, где в одном потоке смешаны посты с генерацией и без неё: у
   * manjaro.ru это английские анонсы обновлений среди обычных новостей.
   * Остальные посты уходят в режиме `textMode`.
   */
  generateWhen?: Filter;
}

/** Запись, подготовленная к отправке. */
interface PreparedEntry {
  entry: FeedEntry;
  /** Генерация не удалась и отправлен текст источника. */
  usedFallback: boolean;
}

/**
 * Полный цикл обработки одного источника.
 *
 * Не знает, что такое RSS, LOR, OpenRouter или YAML: всё специфичное приходит
 * через `SourceAdapter` и `Enricher`. Поэтому добавление источника или смена
 * способа генерации текста не требует правок этого файла.
 */
export class SourcePipeline {
  readonly sourceId: string;
  readonly sourceName: string;

  constructor(private readonly options: SourcePipelineOptions) {
    this.sourceId = options.sourceId;
    this.sourceName = options.sourceName;
  }

  /**
   * Первый запуск: заносит текущий снимок фида в базу и помечает его
   * обработанным.
   *
   * НЕ ставит `sent_at`: в VK ничего не уходило. Так при первом старте в чат
   * не вываливается весь архив источника, а счётчик несохранённых постов
   * остаётся в согласованном состоянии (сообщение могло упасть на отправке).
   */
  async initialize(): Promise<void> {
    const entries = await this.options.adapter.fetch();

    let added = 0;
    let ignored = 0;

    for (const entry of entries) {
      if (!this.options.db.hasFeedEntry(entry.id)) {
        this.options.db.addFeedEntry(entry);
        added++;
      }

      if (!this.options.db.getEntryHandledStatus(entry.id)) {
        this.options.db.markIgnored(entry.id);
        ignored++;
      }
    }

    this.options.logger.info(
      `Feed initialized (${this.sourceName}): ${entries.length} entries. ` +
        `Added: ${added}. Ignored on startup: ${ignored}.`,
      false
    );
  }

  /**
   * Обычный опрос: отправляет всё новое и возвращает число отправленных постов.
   *
   * Уже обработанные записи передаются адаптеру ЗАРАНЕЕ, и он их не разбирает:
   * догрузка страниц постов у части стратегий ходит в сеть, и без этой подсказки
   * каждый опрос оплачивал бы десятки лишних запросов к чужому сайту ради
   * постов, которые всё равно были бы отброшены. Список берётся ОДНИМ запросом
   * к базе, а не проверкой на каждый элемент фида.
   */
  async check(): Promise<number> {
    const entries = await this.options.adapter.fetch({
      skipIds: this.options.db.getHandledEntryIds()
    });

    if (entries.length === 0) {
      this.options.logger.debug(`Feed check (${this.sourceName}): no new entries.`);

      return 0;
    }

    // Порядок публикации важен. Даты уже в ISO, поэтому хватает строкового
    // сравнения: `new Date()` в компараторе создавал бы объект на КАЖДОЕ
    // сравнение, то есть O(n log n) аллокаций за одну сортировку.
    const ordered = [...entries].sort((a, b) =>
      a.published.localeCompare(b.published)
    );

    /*
     * Отправка строго последовательная, хотя генерация текста и ходит в сеть.
     * Причина не в скорости: у OpenRouter жёсткие лимиты на параллельные
     * запросы, а порядок сообщений в чате для новостного бота важнее
     * сэкономленных секунд.
     */
    for (const entry of ordered) {
      await this.sendNewEntry(entry);
    }

    this.options.logger.info(
      `Feed check completed (${this.sourceName}): sent ${ordered.length} new post(s).`
    );

    return ordered.length;
  }

  /** Записи источника, свежие сверху, вместе с состоянием — для выбора поста. */
  listRecent(limit: number): StoredEntry[] {
    return this.options.db.listRecentEntries(this.sourceId, limit);
  }

  /**
   * Переотправка последнего поста источника.
   *
   * Тонкая обёртка над `resend`: «последний» — это просто первая запись того же
   * списка, и отдельная реализация рано или поздно разошлась бы с ней в
   * деталях вывода и подготовки.
   */
  async resendLatest(): Promise<FeedEntry> {
    const latest = this.options.db.getLatestEntry(this.sourceId);

    if (!latest) {
      throw new Error(`Feed contains no saved entries (${this.sourceName}).`);
    }

    return this.resend(latest);
  }

  /**
   * Переотправка произвольного поста источника.
   *
   * Картинки берутся по текущим правилам стратегии, а не из базы: правила
   * извлечения со временем меняются (LOR перестал класть в RSS все скриншоты
   * галереи), а в базе лежит результат на момент сохранения.
   *
   * Текст при `enrich` генерируется заново: пересылка — это новый выход поста в
   * чат по нынешним правилам, а не попытка воспроизвести прошлый выпуск.
   */
  async resend(entry: FeedEntry): Promise<FeedEntry> {
    const imageUrls = await this.refreshImages(entry);
    const prepared = await this.prepare(entry);

    await this.deliver(prepared, imageUrls);

    this.options.logger.info(
      `Post resent (${this.sourceName}): "${entry.title}" ` +
        `${this.deliveryLog(prepared, imageUrls)}`
    );

    return entry;
  }

  private async sendNewEntry(entry: FeedEntry): Promise<void> {
    this.options.db.addFeedEntry(entry);

    // Ошибку пробрасываем наружу: за backoff и лог отвечает планировщик,
    // иначе одна и та же ошибка логировалась бы в двух местах.
    const prepared = await this.prepare(entry);

    await this.deliver(prepared, entry.imageUrls);

    this.options.logger.info(
      `New post sent (${this.sourceName}): "${entry.title}" ` +
        `by ${entry.author} ${this.deliveryLog(prepared, entry.imageUrls)}`
    );
  }

  /**
   * Рендер, отправка, разбор ошибок картинок и отметка в базе.
   *
   * Общая часть для нового поста и переотправки: эти шесть строк раньше были
   * продублированы в двух методах, и любая правка расходилась.
   */
  private async deliver(
    prepared: PreparedEntry,
    imageUrls: string[]
  ): Promise<void> {
    const message = this.options.templates.render(
      this.sourceId,
      prepared.entry
    );

    await this.options.sender.send(this.options.targetChat, message, imageUrls);
    this.reportImageFailures(prepared.entry);
    this.options.db.markSent(prepared.entry.id);
  }

  /**
   * Текст сообщения: сгенерированный либо текст источника.
   *
   * Единая точка решения: и обычная отправка, и переотправка, и откат после
   * неудачной генерации проходят через неё, поэтому правило одно.
   */
  private async prepare(entry: FeedEntry): Promise<PreparedEntry> {
    if (!this.shouldGenerate(entry)) {
      return { entry: await this.withSourceText(entry), usedFallback: false };
    }

    try {
      const { entry: generated } = await this.options.enricher.enrich(entry);

      return { entry: generated, usedFallback: false };
    } catch (error) {
      // Обогащение (например, AI) не должно блокировать пересылку поста.
      // Лучше текст источника, чем ничего.
      this.options.logger.error(
        `Enrich failed for "${entry.title}" (${this.sourceName}): ${toMessage(error)}`
      );

      return { entry: await this.withSourceText(entry), usedFallback: true };
    }
  }

  /**
   * Нужно ли генерировать текст для этого поста.
   *
   * `textMode: generated` включает генерацию для всех постов источника, а
   * `generateWhen` сужает её до конкретных заголовков. Так один фид
   * обслуживает и переводимые анонсы, и обычные обсуждения, а модель зовётся
   * только там, где она нужна.
   */
  private shouldGenerate(entry: FeedEntry): boolean {
    if (this.options.textMode === 'generated') {
      return true;
    }

    return this.options.generateWhen?.matches(entry.title) ?? false;
  }

  /**
   * Запись без генерации: текст источника по правилам `textMode`.
   *
   * Одновременно это fallback для неудачной генерации — поэтому правило
   * обрезки одно и то же в обоих случаях.
   */
  private async withSourceText(entry: FeedEntry): Promise<FeedEntry> {
    const content = await this.sourceText(entry);

    return {
      ...entry,
      content:
        this.options.textMode === 'feedFull' ? content : truncateText(content, this.options.textLimit)
    };
  }

  /**
   * Текст поста: из фида, а если он пуст — со страницы поста.
   *
   * Иначе в сообщение ушёл бы один заголовок: у pingvinus описание в фиде
   * пустое, весь текст лежит на странице.
   */
  private async sourceText(entry: FeedEntry): Promise<string> {
    if (entry.content.trim()) {
      return entry.content;
    }

    return this.fetchSourceText(entry);
  }

  /**
   * Достаёт текст поста со страницы.
   *
   * Ошибка НЕ пробрасывается: это уже запасной путь, и поднимать на нём
   * тревогу значит превращать «отправим пост без текста» в «не отправим пост».
   */
  private async fetchSourceText(entry: FeedEntry): Promise<string> {
    try {
      return await this.options.adapter.postText(entry.link);
    } catch (error) {
      this.options.logger.warn(
        `Не удалось получить текст поста со страницы (${this.sourceName}): ` +
          toMessage(error)
      );

      return '';
    }
  }

  /**
   * Переизвлекает картинки для переотправки и, если значение изменилось,
   * обновляет запись в базе — иначе следующий resend снова отправил бы
   * устаревшее.
   *
   * Ошибка НЕ пробрасывается: цель resend — отправить пост, а не проверить
   * сеть. Лучше отправить пост с одним скриншотом из базы, чем не отправить.
   */
  private async refreshImages(entry: FeedEntry): Promise<string[]> {
    try {
      const fresh = await this.options.adapter.imagesForPost(entry.link);

      if (fresh.length === 0) {
        return entry.imageUrls;
      }

      if (!sameUrls(fresh, entry.imageUrls)) {
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

  private deliveryLog(
    prepared: PreparedEntry,
    imageUrls: string[]
  ): string {
    return [
      `images=${imageUrls.length}`,
      prepared.usedFallback ? 'enrich: fallback на текст источника' : ''
    ]
      .filter(Boolean)
      .join(' ');
  }

  private reportImageFailures(entry: FeedEntry): void {
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

/** Сравнение списков URL без учёта порядка: он в сообщении значения не имеет. */
function sameUrls(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((url, i) => url === b[i]);
}