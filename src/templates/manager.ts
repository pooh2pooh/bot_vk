import { readFile } from 'node:fs/promises';

import YAML from 'yaml';

import type { FeedEntry, TemplateData } from '../core/types.js';
import { toMessage } from '../utils/to-message.js';

interface TemplateFile {
  template: string;
}

interface LoadedTemplate {
  path: string;
  template: string;
}

/**
 * Хранит по одному шаблону на каждый источник (ключ — sourceId).
 * Пути к файлам регистрируются заранее (register), поэтому /template reload
 * умеет перечитать их все, не зная заранее, сколько источников настроено.
 */
export class TemplateManager {
  private readonly templates = new Map<string, LoadedTemplate>();

  /** Регистрирует источник и путь к его шаблону, не загружая файл. */
  register(sourceId: string, path: string): void {
    this.templates.set(sourceId, { path, template: '' });
  }

  async load(): Promise<void> {
    await Promise.all(
      [...this.templates.keys()].map(sourceId => this.loadOne(sourceId))
    );
  }

  async loadOne(sourceId: string): Promise<void> {
    const entry = this.templates.get(sourceId);

    if (!entry) {
      throw new Error(`Template not registered for source: ${sourceId}`);
    }

    /*
     * Ошибка чтения обёрнута: без источника и пути в сообщении остаётся
     * `ENOENT: no such file or directory`, по которому непонятно, ЧТО чинить.
     */
    let source: string;

    try {
      source = await readFile(entry.path, 'utf8');
    } catch (error) {
      throw new Error(
        `Cannot read template for source "${sourceId}": ${entry.path} — ` +
          toMessage(error)
      );
    }

    const data = YAML.parse(source) as TemplateFile;

    if (!data.template || typeof data.template !== 'string') {
      throw new Error(
        `Invalid template for source "${sourceId}": ${entry.path} — ` +
          'expected a top-level "template" string'
      );
    }

    this.templates.set(sourceId, { path: entry.path, template: data.template });
  }

  render(sourceId: string, entry: FeedEntry): string {
    const loaded = this.templates.get(sourceId);

    if (!loaded?.template) {
      throw new Error(`Template not loaded for source: ${sourceId}`);
    }

    const data: TemplateData = {
      title: entry.title,
      author: entry.author,
      content: entry.content,
      link: entry.link,
      published: entry.published,
      updated: entry.updated
    };

    return loaded.template.replace(
      /\{([a-zA-Z0-9_]+)\}/g,
      (_, key: keyof TemplateData) => {
        return data[key] !== undefined ? String(data[key]) : `{${key}}`;
      }
    );
  }
}
