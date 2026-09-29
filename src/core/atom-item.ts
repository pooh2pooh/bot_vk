export interface AtomAuthor {
  name?: string;
}

/** Поля, которые может вернуть rss-parser для Atom/RSS/RDF в разных сочетаниях. */
export interface AtomItem {
  title?: string;
  link?: string;
  id?: string;
  guid?: string;
  published?: string;
  updated?: string;
  pubDate?: string;
  isoDate?: string;
  content?: string;
  description?: string;
  author?: string | AtomAuthor;
  creator?: string;
  ['content:encoded']?: string;
}
