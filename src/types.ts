export type ContentType =
  | 'forum_post'
  | 'screenshot_post';

export type FeedSource =
  | 'forum'
  | 'screenshots';

export interface FeedEntry {
  id: string;
  title: string;
  link: string;
  author: string;
  content: string;
  published: string;
  updated: string;
  source: FeedSource;
  imageUrls: string[];
}

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
