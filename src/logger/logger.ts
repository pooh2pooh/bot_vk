import { VKSender } from '../vk/sender.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export class Logger {
  private adminQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sender: VKSender,
    private readonly adminChat: number,
    private readonly minLevel: LogLevel = 'info'
  ) {}

  debug(message: string): void {
    this.log('debug', message, false);
  }

  info(message: string, notifyAdmin = true): void {
    this.log('info', message, notifyAdmin);
  }

  warn(message: string, notifyAdmin = true): void {
    this.log('warn', message, notifyAdmin);
  }

  error(message: string, notifyAdmin = true): void {
    this.log('error', message, notifyAdmin);
  }

  private log(
    level: LogLevel,
    message: string,
    notifyAdmin: boolean
  ): void {
    if (LEVELS[level] < LEVELS[this.minLevel]) {
      return;
    }

    const timestamp = new Date().toISOString();

    console.log(
      `[${timestamp}] [${level.toUpperCase()}] ${message}`
    );

    if (!notifyAdmin) {
      return;
    }

    this.adminQueue = this.adminQueue
      .then(async () => {
        try {
          await this.sender.send(
            this.adminChat,
            `🤖 [${level.toUpperCase()}]\n${message}`
          );
        } catch (error) {
          console.error(
            '[LOGGER] Failed to send admin notification:',
            error
          );
        }
      })
      .catch(() => {
        // Очередь логов не должна ломать основной процесс.
      });
  }
}
