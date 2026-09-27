/**
 * Последовательный backoff для одинаковых ошибок.
 *
 * 1-я ошибка  ->  3 мин
 * 2-я ошибка  ->  6 мин
 * 3-я ошибка  -> 12 мин
 * 4-я ошибка  -> 40 мин
 * 5+ ошибок   -> 60 мин
 *
 * После успешной попытки состояние полностью сбрасывается.
 */
const BACKOFF_MS = [
  3 * 60_000,
  6 * 60_000,
  12 * 60_000,
  40 * 60_000,
  60 * 60_000
] as const;

interface FailureState {
  error: string;
  count: number;
}

export interface BackoffFailureResult {
  count: number;
  delayMs: number;
  shouldLog: boolean;
}

export interface BackoffRecoveryResult {
  hadFailures: boolean;
  count: number;
}

export class ErrorBackoff {
  private state: FailureState | null = null;

  fail(error: unknown): BackoffFailureResult {
    const message = this.getMessage(error);

    if (this.state?.error === message) {
      this.state.count++;
    } else {
      this.state = {
        error: message,
        count: 1
      };
    }

    const count = this.state.count;
    const delayMs =
      BACKOFF_MS[Math.min(count, BACKOFF_MS.length) - 1];

    return {
      count,
      delayMs,
      // Одинаковую подряд ошибку второй раз в лог/чат не отправляем.
      shouldLog: count === 1
    };
  }

  success(): BackoffRecoveryResult {
    const count = this.state?.count ?? 0;

    this.state = null;

    return {
      hadFailures: count > 0,
      count
    };
  }

  private getMessage(error: unknown): string {
    return error instanceof Error
      ? error.message.trim()
      : String(error).trim();
  }
}
