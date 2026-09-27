/**
 * Доменные типы, не привязанные к конкретному источнику.
 * Новый источник никогда не должен требовать правки этого файла.
 */

/** Запись, унифицированная под конвейер обработки (дедупликация, шаблон, отправка). */
export interface FeedEntry {
  /** Глобально уникальный id, обычно `${sourceId}:${rawId}`. */
  id: string;
  /** Id источника, к которому относится запись (см. SourceConfig.id). */
  sourceId: string;
  title: string;
  link: string;
  author: string;
  content: string;
  published: string;
  updated: string;
  imageUrls: string[];
}

/** Данные, доступные шаблону сообщения. */
export interface TemplateData {
  title: string;
  author: string;
  content: string;
  link: string;
  published: string;
  updated: string;
}

export interface Admin {
  userId: number;
  role: 'owner' | 'admin';
  createdAt: string;
}

export interface ImageDownloadFailure {
  url: string;
  message: string;
}
