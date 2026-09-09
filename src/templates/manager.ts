import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import YAML from 'yaml';

import type {
  ContentType,
  FeedEntry,
  TemplateData
} from '../types.js';

interface TemplateFile {
  type: ContentType;
  template: string;
}

export class TemplateManager {
  private readonly templates = new Map<ContentType, string>();

  constructor(
    private readonly templatesPath: string
  ) {}

  async load(): Promise<void> {
    this.templates.clear();

    await this.loadTemplate('forum_post');
  }

  private async loadTemplate(type: ContentType): Promise<void> {
    const path = join(this.templatesPath, `${type}.yml`);
    const source = await readFile(path, 'utf8');

    const data = YAML.parse(source) as TemplateFile;

    if (!data.template || typeof data.template !== 'string') {
      throw new Error(`Invalid template: ${path}`);
    }

    this.templates.set(type, data.template);
  }

  render(type: ContentType, entry: FeedEntry): string {
    const template = this.templates.get(type);

    if (!template) {
      throw new Error(`Template not found: ${type}`);
    }

    const data: TemplateData = {
      title: entry.title,
      author: entry.author,
      content: entry.content,
      link: entry.link,
      published: entry.published,
      updated: entry.updated
    };

    return template.replace(
      /\{([a-zA-Z0-9_]+)\}/g,
      (_, key: keyof TemplateData) => {
        return data[key] !== undefined
          ? String(data[key])
          : `{${key}}`;
      }
    );
  }
}
