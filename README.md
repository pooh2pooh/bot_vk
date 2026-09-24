# 🤖 VK Feed Bot

Бот для автоматической пересылки новых RSS/Atom-постов в VK с SQLite-дедупликацией, шаблонами сообщений и AI-комментариями для постов со скриншотами.

## Возможности

- RSS/Atom → VK без дублей.
- Первый запуск **не пересылает старые записи**.
- Скриншоты отправляются с комментарием OpenRouter вместо исходного текста.
- Автором AI-комментария указывается название модели.
- Модель, API key и промпт меняются через `.env`/файл шаблона.
- Логи отправляются в отдельный админ-чат, включая время генерации AI.
- SQLite хранит обработанные посты и администраторов.
- Ошибки AI не блокируют отправку самого скриншота: используется исходный текст.
- Изображения скачиваются ботом с retry и отдельными timeout перед загрузкой в VK.
- Более 10 изображений автоматически разбиваются на несколько сообщений.

## 1. Установка

Требуется **Node.js 22+** и npm.

### Arch Linux

```bash
sudo pacman -S --needed nodejs npm base-devel
```

`base-devel` нужен для сборки нативных зависимостей, включая `better-sqlite3`, если для текущей версии Node нет готового бинарника.

### Клонирование

```bash
git clone https://github.com/pooh2pooh/bot_vk.git
cd bot_vk
npm install
```

При проблемах с `better-sqlite3`:

```bash
npm rebuild better-sqlite3 --build-from-source
```

## 2. Настройка `.env`

```bash
cp .env.example .env
nano .env
```

Минимальная конфигурация:

```env
VK_TOKEN=YOUR_VK_TOKEN

TARGET_CHAT=2000000003
ADMIN_CHAT=2000000002
OWNER_ID=281457599

FEED_URL=https://manjaro.ru/atom
SCREENSHOTS_FEED_URL=https://www.linux.org.ru/section-rss.jsp?section=3&group=19393

POLL_INTERVAL_MS=60000
REQUEST_TIMEOUT_MS=30000
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

### Основные параметры

| Переменная | Назначение |
|---|---|
| `VK_TOKEN` | токен VK для работы бота |
| `TARGET_CHAT` | чат для публикации постов |
| `ADMIN_CHAT` | админ-чат, куда приходят логи и команды |
| `OWNER_ID` | VK ID владельца |
| `FEED_URL` | основной RSS/Atom-фид |
| `SCREENSHOTS_FEED_URL` | фид постов со скриншотами |
| `POLL_INTERVAL_MS` | интервал проверки фидов |
| `OPENROUTER_API_KEY` | ключ OpenRouter |
| `OPENROUTER_MODEL` | ID модели OpenRouter |
| `OPENROUTER_MODEL_NAME` | имя модели в сообщении VK |
| `OPENROUTER_PROMPT_FILE` | путь к AI-промпту |
| `OPENROUTER_TIMEOUT_MS` | timeout генерации AI |
| `OPENROUTER_MAX_TOKENS` | максимальный размер ответа AI |
| `IMAGE_DOWNLOAD_TIMEOUT_MS` | timeout скачивания изображения |
| `VK_UPLOAD_TIMEOUT_MS` | timeout загрузки изображения в VK |

> `.env` содержит секреты и не должен попадать в Git.

## 3. Настройка AI

Модель меняется одной строкой:

```env
OPENROUTER_MODEL=новый-id-модели
OPENROUTER_MODEL_NAME=Название модели
```

Промпт лежит в:

```text
templates/ai_comment.txt
```

После изменения промпта перезапуск не нужен:

```text
/ai reload
```

Проверка текущей конфигурации:

```text
/ai status
```

## 4. Сборка и запуск

```bash
npm run build
npm start
```

Для разработки без сборки:

```bash
npm run dev
```

Для постоянной работы удобно использовать PM2:

```bash
npm install -g pm2
pm2 start dist/index.js --name vk-feed-bot
pm2 save
pm2 startup
```

## 5. Команды в админ-чате

```text
/help
/status

/feed check
/feed resend-last

/admin list
/admin add ID
/admin remove ID

/template reload

/ai status
/ai reload
```

Команды принимаются **только в `ADMIN_CHAT`** и только от пользователей, записанных в SQLite как администраторы.

`OWNER_ID` автоматически получает роль владельца при старте.

## 6. Как работает обработка

```text
RSS/Atom
   │
   ▼
FeedReader / ScreenshotFeedReader
   │
   ▼
FeedProcessor ───► SQLite (data/bot.db)
   │
   ├── обычный пост ───────────────► TemplateManager ─► VKSender
   │
   └── скриншотный пост
          │
          ▼
     OpenRouterCommentService
          │
          ▼
     AI-комментарий + время генерации
          │
          ▼
     TemplateManager ─────────────► VKSender ─► VK
```

### Первый запуск

При старте текущие записи фидов добавляются в SQLite и помечаются `ignored`. Старые посты не отправляются. После этого бот отслеживает только новые записи.

### Дубликаты и ошибки

`data/bot.db` хранит состояние каждого поста. Уже обработанные записи повторно не отправляются.

Если отправка поста не удалась, запись **не помечается отправленной**. На следующей проверке бот попробует её снова.

Если OpenRouter недоступен или превышен timeout, скриншот всё равно отправляется с исходным текстом автора. Ошибка AI отдельно попадает в лог.

### Изображения

Внешние URL изображений сначала скачиваются самим ботом с retry. Затем `Buffer` загружается в VK с отдельным timeout. Это защищает от ошибок вида:

```text
The operation was aborted
```

## 7. Структура проекта

```text
src/
├── ai/
│   └── openrouter.ts       # OpenRouter и генерация комментариев
├── commands/
│   └── handler.ts          # команды администраторов
├── db/
│   └── database.ts         # SQLite
├── feed/
│   ├── reader.ts           # основной RSS/Atom
│   ├── screenshot-reader.ts# посты со скриншотами
│   └── processor.ts        # дедупликация и обработка
├── logger/
│   └── logger.ts           # логирование в VK
├── templates/
│   └── manager.ts          # загрузка YAML-шаблонов
├── vk/
│   ├── client.ts           # VK API
│   └── sender.ts           # текст + изображения + retry
├── config.ts               # конфигурация из .env
└── index.ts                # точка входа

templates/
├── ai_comment.txt          # промпт AI
└── screenshot_post.yml     # шаблон скриншотного поста

data/
└── bot.db                  # состояние бота и история фидов
```

## 8. Типовой цикл работы

```text
Новый пост
   ↓
Проверка ID в SQLite
   ↓
[скриншот?]
   ├─ нет → обычный шаблон
   └─ да  → OpenRouter → AI-комментарий
   ↓
Отправка изображений + текста в VK
   ↓
Запись результата в SQLite
   ↓
Лог в ADMIN_CHAT
```

Для AI в админ-чат пишется название поста и фактическое время генерации, например:

```text
🤖 [INFO]
📸 Скриншот переслан
Название: Домашний сетап...
Модель: GLM 5.2
Генерация: 3.47 с
Режим: автоматическая отправка
```

## 9. Обновление

```bash
git pull
npm install
npm run build
pm2 restart vk-feed-bot
```

`data/bot.db` удалять при обновлении не нужно — там хранится состояние дедупликации и администраторы.
