# 🤖 VK Feed Bot

Бот для автоматической пересылки новых RSS/Atom-постов в VK. Поддерживает
произвольное число источников, SQLite-дедупликацию, шаблоны сообщений и
подключаемое AI-обогащение постов (например, комментарии вместо исходного
текста для постов со скриншотами).

## Архитектура: источники — это конфиг, а не код

Раньше добавление источника означало правку нескольких файлов и `.env`.
Теперь источник — это блок в `config/sources.yml`:

```yaml
sources:
  - id: forum
    name: Manjaro RU Atom
    type: rss
    url: https://manjaro.ru/atom
    template: templates/forum_post.yml

  - id: screenshots
    name: LOR Screenshots
    type: rss
    url: https://www.linux.org.ru/section-rss.jsp?section=3
    requireImages: true
    imageExtractor: lor
    enrich: openrouter
    template: templates/screenshot_post.yml
```

**Добавить источник** → добавить блок.
**Удалить источник** → удалить блок (или `enabled: false`).
**Настроить источник** → поменять поля (`url`, `pollIntervalMs`, `template`,
`enrich`, `promptPath` и т.д.).

Ничего из этого не требует пересборки кода — только перезапуск бота (или
`/source check ID`, если нужно проверить прямо сейчас).

Полное описание всех полей — в комментариях внутри `config/sources.yml`.

### Когда всё-таки нужен код

Если новый источник — это принципиально новый *тип* (не RSS/Atom, например
Telegram-канал), или сайт верстает картинки по-своему и нужен новый
`imageExtractor`, или нужен новый способ обогащения (`enrich`) — во всех
случаях это **один новый класс + одна строка регистрации** в
`src/registries.ts`, без изменений в остальном коде:

```ts
// src/registries.ts
imageExtractors.register('my-site', new MySiteImageExtractor());
sourceAdapters.register('telegram', cfg => new TelegramSourceAdapter(cfg));
enrichers.register('summarizer', new SummarizerEnricher(...));
```

Интерфейсы, которые нужно реализовать:

| Точка расширения | Интерфейс | Где живёт |
| --- | --- | --- |
| Новый тип источника | `SourceAdapter` (`fetch(): Promise<FeedEntry[]>`) | `src/core/source-adapter.ts` |
| Новый способ достать картинки | `ImageExtractor` (`extract(item): string[]`) | `src/core/image-extractor.ts` |
| Новый способ обогащения контента | `Enricher` (`enrich(entry): Promise<EnrichResult>`) | `src/core/enricher.ts` |

Остальной конвейер (дедупликация в SQLite, рендер шаблона, отправка в VK,
backoff, админ-команды) ничего не знает про конкретные сайты/модели и не
меняется.

## Возможности

- Любое число RSS/Atom источников, каждый со своим интервалом опроса,
  таймаутом, шаблоном и (опционально) AI-обогащением.
- Дедупликация в SQLite. Первый запуск **не пересылает старые записи**.
- Отказ одного источника не влияет на остальные: у каждого свой backoff
  (нарастающая задержка при повторяющейся одинаковой ошибке) и свой цикл опроса.
- AI-обогащение (OpenRouter) — опционально, на источник. Ошибка AI не
  блокирует отправку поста: используется исходный текст.
- Изображения скачиваются ботом с retry и отдельными timeout перед загрузкой
  в VK — это защищает от `The operation was aborted`.
- Более 10 изображений автоматически разбиваются на несколько сообщений.
- Логи отправляются в отдельный админ-чат.
- Источники можно включать/выключать на лету командой, без перезапуска.

## 1. Установка

Требуется **Node.js 22+** и npm.

### Arch Linux

```
sudo pacman -S --needed nodejs npm base-devel
```

`base-devel` нужен для сборки нативных зависимостей, включая `better-sqlite3`,
если для текущей версии Node нет готового бинарника.

### Клонирование

```
git clone https://github.com/pooh2pooh/bot_vk.git
cd bot_vk
npm install
```

При проблемах с `better-sqlite3`:

```
npm rebuild better-sqlite3 --build-from-source
```

## 2. Настройка

### 2.1 `.env` — секреты и глобальные дефолты

```
cp .env.example .env
nano .env
```

```
VK_TOKEN=YOUR_VK_TOKEN

TARGET_CHAT=2000000001
ADMIN_CHAT=2000000003
OWNER_ID=281457599

DEFAULT_POLL_INTERVAL_MS=60000
DEFAULT_REQUEST_TIMEOUT_MS=30000
LOG_LEVEL=info

OPENROUTER_API_KEY=YOUR_OPENROUTER_API_KEY
OPENROUTER_MODEL=z-ai/glm-5.2:free
OPENROUTER_MODEL_NAME=GLM 5.2
OPENROUTER_PROMPT_FILE=templates/ai_comment.txt
OPENROUTER_TIMEOUT_MS=30000
OPENROUTER_MAX_TOKENS=300

IMAGE_DOWNLOAD_TIMEOUT_MS=60000
VK_UPLOAD_TIMEOUT_MS=90000
```

| Переменная | Назначение |
| --- | --- |
| `VK_TOKEN` | токен VK для работы бота |
| `TARGET_CHAT` | чат для публикации постов |
| `ADMIN_CHAT` | админ-чат, куда приходят логи и команды |
| `OWNER_ID` | VK ID владельца |
| `DEFAULT_POLL_INTERVAL_MS` | интервал опроса, если источник не задал свой |
| `DEFAULT_REQUEST_TIMEOUT_MS` | таймаут запроса фида, если источник не задал свой |
| `OPENROUTER_API_KEY` | ключ OpenRouter (нужен, если хотя бы один источник использует `enrich: openrouter`) |
| `OPENROUTER_MODEL` / `OPENROUTER_MODEL_NAME` | модель по умолчанию и её имя для сообщений |
| `OPENROUTER_PROMPT_FILE` | промпт по умолчанию (источник может задать свой `promptPath`) |
| `IMAGE_DOWNLOAD_TIMEOUT_MS` | таймаут скачивания изображения ботом |
| `VK_UPLOAD_TIMEOUT_MS` | таймаут загрузки изображения в VK |
| `DATABASE_PATH` | путь к SQLite (по умолчанию `data/bot.db`) |
| `SOURCES_FILE` | путь к списку источников (по умолчанию `config/sources.yml`) |

> `.env` содержит секреты и не должен попадать в Git.

### 2.2 `config/sources.yml` — источники

Несекретная конфигурация, версионируется в Git. См. пример выше и
комментарии в самом файле.

## 3. Настройка AI

Модель по умолчанию меняется в `.env` одной строкой:

```
OPENROUTER_MODEL=новый-id-модели
OPENROUTER_MODEL_NAME=Название модели
```

Промпт по умолчанию лежит в `templates/ai_comment.txt`. Источник может
задать свой промпт через `promptPath` в `config/sources.yml` — тогда для
него создаётся отдельный экземпляр AI-обогатителя с этим промптом.

После изменения промпта перезапуск не нужен: `/ai reload`.
Проверка текущей конфигурации: `/ai status`.

## 4. Сборка и запуск

```
npm run build
npm start
```

Для разработки без сборки:

```
npm run dev
```

Для постоянной работы удобно использовать PM2:

```
npm install -g pm2
pm2 start dist/index.js --name vk-feed-bot
pm2 save
pm2 startup
```

## 5. Команды в админ-чате

```
/help
/status

/source list
/source check ID
/source resend-last ID
/source enable ID
/source disable ID

/admin list
/admin add ID
/admin remove ID

/template reload [ID]

/ai status
/ai reload
```

Команды принимаются **только в `ADMIN_CHAT`** и только от пользователей,
записанных в SQLite как администраторы. `OWNER_ID` автоматически получает
роль владельца при старте. `/source enable|disable` сохраняется в SQLite и
переживает перезапуск.

## 6. Как работает обработка

```
config/sources.yml
        │
        ▼
SourceAdapterRegistry ──► RssSourceAdapter (+ ImageExtractor-стратегия)
        │
        ▼
   SourcePipeline ───► SQLite (data/bot.db) — дедупликация
        │
        ├── enrich: none ──────────────────────► TemplateManager ─► VKSender ─► VK
        │
        └── enrich: openrouter (или свой)
               │
               ▼
        Enricher.enrich() — ошибка не блокирует пост, fallback на исходный текст
               │
               ▼
        TemplateManager ──────────────────────► VKSender ─► VK
```

Каждый источник крутится в `Scheduler` на своём `setTimeout`-цикле с
собственным backoff. Падение одного источника (сеть, парсинг, VK) не
затрагивает остальные.

### Первый запуск

При старте текущие записи всех источников добавляются в SQLite и
помечаются `ignored`. Старые посты не отправляются. После этого бот
отслеживает только новые записи — для каждого источника независимо.

### Дубликаты и ошибки

`data/bot.db` хранит состояние каждого поста (глобальный id —
`${sourceId}:${rawId}`). Уже обработанные записи повторно не отправляются.

Если отправка поста не удалась — запись **не помечается отправленной**. На
следующей проверке этого источника бот попробует снова.

Если обогащение (например, AI) недоступно или превышен timeout — пост всё
равно отправляется с исходным текстом автора. Ошибка обогащения отдельно
попадает в лог.

### Изображения

Внешние URL изображений сначала скачиваются самим ботом с retry. Затем
`Buffer` загружается в VK с отдельным timeout. Это защищает от ошибок вида:

```
The operation was aborted
```

## 7. Структура проекта

```
src/
├── core/                     # контракты (не знают о конкретных сайтах/моделях)
│   ├── types.ts               # FeedEntry, TemplateData, Admin
│   ├── source-adapter.ts      # интерфейс SourceAdapter
│   ├── source-adapter-registry.ts
│   ├── image-extractor.ts     # интерфейс ImageExtractor + реестр
│   └── enricher.ts            # интерфейс Enricher + реестр
│
├── sources/
│   ├── atom-item.ts            # разбор Atom/RSS полей
│   ├── text-utils.ts           # нормализация HTML/текста, fetchText
│   ├── rss-source-adapter.ts   # универсальный RSS/Atom SourceAdapter
│   └── image-extractors/
│       └── lor-image-extractor.ts   # специфика linux.org.ru
│
├── enrich/
│   └── openrouter-enricher.ts  # AI-обогащение через OpenRouter
│
├── pipeline/
│   ├── source-pipeline.ts      # fetch → dedupe → enrich → render → send
│   └── scheduler.ts            # независимый poll-цикл + backoff на источник
│
├── config/
│   ├── env.ts                  # секреты и глобальные дефолты из .env
│   ├── source-config.ts        # тип одного источника
│   ├── sources-loader.ts       # парсинг и валидация config/sources.yml
│   ├── app-config.ts           # итоговый AppConfig
│   └── index.ts                # склейка env + sources.yml
│
├── registries.ts               # точка регистрации всех стратегий
│
├── db/database.ts              # SQLite (дедупликация, админы, настройки)
├── vk/client.ts                # VK API клиент
├── vk/sender.ts                # текст + изображения + retry
├── templates/manager.ts        # YAML-шаблоны сообщений, по одному на источник
├── commands/handler.ts         # команды администраторов
├── logger/logger.ts            # логирование в VK
├── utils/error-backoff.ts      # нарастающая задержка при повторных ошибках
└── index.ts                    # composition root

config/
└── sources.yml                 # список источников (несекретно, в Git)

templates/
├── ai_comment.txt              # промпт AI по умолчанию
├── forum_post.yml              # шаблон обычного поста
└── screenshot_post.yml         # шаблон скриншотного поста

data/
└── bot.db                      # состояние бота и история фидов
```

## 8. Типовой цикл работы

```
Новый пост источника X
   ↓
Проверка id в SQLite (id = "X:<raw-id>")
   ↓
[источник настроен на enrich?]
   ├─ нет → шаблон источника
   └─ да  → Enricher.enrich() → обогащённая запись (или fallback при ошибке)
   ↓
Отправка изображений + текста в VK
   ↓
Запись результата в SQLite
   ↓
Лог в ADMIN_CHAT
```

## 9. Обновление

```
git pull
npm install
npm run build
pm2 restart vk-feed-bot
```

`data/bot.db` удалять при обновлении не нужно — там хранится состояние
дедупликации и администраторы.

### Миграция со старой версии (одна пара `FEED_URL`/`SCREENSHOTS_FEED_URL`)

Старые переменные `.env` `FEED_URL` и `SCREENSHOTS_FEED_URL` больше не
используются. Их значения нужно перенести в `config/sources.yml` (пример уже
содержит оба прежних источника с теми же URL). Старые записи в `data/bot.db`
совместимы: колонка `source` как хранила строку, так и хранит — теперь это
`id` источника из `sources.yml` (`forum`, `screenshots` в примере).
