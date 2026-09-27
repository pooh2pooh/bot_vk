import type { Logger } from '../logger/logger.js';
import { ErrorBackoff } from '../utils/error-backoff.js';
import type { SourcePipeline } from './source-pipeline.js';

export interface ScheduledSource {
  pipeline: SourcePipeline;
  pollIntervalMs: number;
  enabled: boolean;
}

function formatDelay(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.round(minutes / 60)} ч.` : `${minutes} мин.`;
}

/**
 * Крутит независимый poll-цикл для каждого источника. Отказ одного источника
 * (сеть, парсинг, VK) никогда не влияет на остальные — у каждого свой
 * ErrorBackoff и свой setTimeout-цикл.
 */
export class Scheduler {
  private readonly sources = new Map<
    string,
    ScheduledSource & { backoff: ErrorBackoff }
  >();
  private stopped = false;

  constructor(private readonly logger: Logger) {}

  add(source: ScheduledSource): void {
    this.sources.set(source.pipeline.sourceId, {
      ...source,
      backoff: new ErrorBackoff()
    });
  }

  setEnabled(sourceId: string, enabled: boolean): void {
    const source = this.sources.get(sourceId);

    if (!source) {
      throw new Error(`Unknown source: ${sourceId}`);
    }

    const wasDisabled = !source.enabled;
    source.enabled = enabled;

    if (enabled && wasDisabled) {
      void this.runLoop(source);
    }
  }

  isEnabled(sourceId: string): boolean {
    return this.sources.get(sourceId)?.enabled ?? false;
  }

  list(): Array<{ sourceId: string; sourceName: string; enabled: boolean }> {
    return [...this.sources.values()].map(source => ({
      sourceId: source.pipeline.sourceId,
      sourceName: source.pipeline.sourceName,
      enabled: source.enabled
    }));
  }

  start(): void {
    for (const source of this.sources.values()) {
      if (source.enabled) {
        void this.runLoop(source);
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async runLoop(
    source: ScheduledSource & { backoff: ErrorBackoff }
  ): Promise<void> {
    if (this.stopped || !source.enabled) {
      return;
    }

    const name = source.pipeline.sourceName;

    try {
      await source.pipeline.check();

      const recovery = source.backoff.success();

      if (recovery.hadFailures) {
        this.logger.info(
          `✅ ${name} feed recovered after ${recovery.count} failed attempt(s).`
        );
      }
    } catch (error) {
      const failure = source.backoff.fail(error);
      const message = error instanceof Error ? error.message : String(error);

      // Одинаковые последовательные ошибки не спамят лог и админ-чат.
      if (failure.shouldLog) {
        this.logger.error(
          `${name} feed check failed: ${message}\n` +
            `Следующая попытка через ${formatDelay(failure.delayMs)}.`
        );
      } else {
        console.warn(
          `[BACKOFF] ${name}: same error #${failure.count}; ` +
            `next attempt in ${formatDelay(failure.delayMs)}`
        );
      }

      if (!this.stopped && source.enabled) {
        setTimeout(() => void this.runLoop(source), failure.delayMs);
      }

      return;
    }

    if (!this.stopped && source.enabled) {
      setTimeout(() => void this.runLoop(source), source.pollIntervalMs);
    }
  }
}
