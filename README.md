# bot_vk — LOR Manjaro screenshots feed

## Files to replace

- `src/types.ts`
- `src/feed/reader.ts`
- `src/feed/screenshot-reader.ts` (new)
- `src/feed/processor.ts`
- `src/db/database.ts`
- `src/vk/sender.ts`
- `src/index.ts`
- `src/templates/manager.ts` (required additional change)
- `templates/screenshot_post.yml` (new)

## Optional environment variable

```env
SCREENSHOTS_FEED_URL=https://www.linux.org.ru/section-rss.jsp?section=3&group=19393
```

The code has the same URL as a fallback, so adding the variable is optional.

## Existing `data/bot.db`

Do not delete it. The new database code performs an automatic migration and adds:

- `source`
- `image_urls_json`
- `ignored_at`

Existing entries are treated as forum entries.

## Behaviour

- First startup/restart: current feed entries are stored/marked ignored and are not sent.
- After initialization: only entries not known to the database are sent.
- Failed sends stay pending and are retried.
- `/feed resend-last` reads the latest saved forum entry from SQLite rather than the first live RSS item.
- LOR screenshots with the `manjaro` tag are sent with images.
