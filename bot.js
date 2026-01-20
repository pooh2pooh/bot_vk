const { API, VK } = require('vk-io');
const Parser = require('rss-parser');
const fs = require('fs').promises;
const colors = require('colors');

const config = require('./token.json');
const parser = new Parser();
const vk = new VK(config);
const api = new API(config);

// dev chat - 2000000003
// adm chat - 2000000002
// main chat - 2000000001
const CHAT_ID = 2000000003;
const TWO_MINUTES = 2 * 60 * 1000;
const ANTIFLOOD_TIME = 7;
const ANTIFLOOD_COUNTER = 4;

let users = new Map();
let lastMessagesIds = "99,";

// RSS хранение дат публикаций
let lastPubDates = {
    blog: null,
    notices: null,
    releases: null,
    stable: null,
    testing: null,
    unstable: null,
    opennet: null
};

// ---- Утилиты ----
const log = {
    info: msg => console.log(`[INFO] ${msg}`.white),
    warn: msg => console.log(`[WARN] ${msg}`.yellow),
    error: msg => console.error(`[ERROR] ${msg}`.red),
    success: msg => console.log(`[SUCCESS] ${msg}`.green),
};

// Снижение счётчика антифлуда
async function updateCounter(uid) {
    const user = users.get(uid);
    if (user?.flood_counter > 0) {
        user.flood_counter--;
        users.set(uid, user);
    }
}

// Получение сообщений с retry
async function getMessagesWithRetry(chatId, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await api.messages.getByConversationMessageId({
                peer_id: chatId,
                conversation_message_ids: lastMessagesIds
            });
            return result;
        } catch (err) {
            log.error(`Попытка ${attempt} не удалась: ${err.message}`);
            if (attempt < maxRetries) await new Promise(r => setTimeout(r, 2000));
            else throw err;
        }
    }
}

// Проверка сообщений на опасные команды
async function warningDetector(chatId) {
    try {
        const messages = await getMessagesWithRetry(chatId);
        const dangerPatterns = [
            /rm\s.*[recursive|force]\s.*/i,
            /rm\s.*[/]\s.*/i,
            /chmod\s.*[7]{3}\s.*/i,
            /curl\s.*\|\s.*sh/i,
            /alias\s.*rm/i,
            /sh\s.*\s.*curl/i,
            /sh\s.*base64/i,
            /dd if=\/dev\/zero\s.*/i,
            /.*xxd/i
        ];
        dangerPatterns.forEach(pattern => {
            const msg = messages.items.find(m => m.text.match(pattern));
            if (msg) {
                api.messages.send({
                    random_id: Date.now(),
                    peer_id: msg.peer_id,
                    message: '❗ Потенциально опасная команда❗ Не вводите её в терминал!',
                    reply_to: msg.id
                });
                lastMessagesIds = lastMessagesIds.replace(msg.conversation_message_id + ',', '');
                log.warn('Dangerous command detected');
            }
        });
        if (messages.count > 98) lastMessagesIds = "1,";
    } catch (err) {
        log.error(`warningDetector failed: ${err}`);
    }
}

// Универсальная обработка RSS
async function processRssFeed({ url, lastPubKey, chatMsg, fileName }) {
    try {
        const feed = await parser.parseURL(url);
        for (const item of feed.items) {
            const postTime = new Date(item.isoDate);
            if (!lastPubDates[lastPubKey] || postTime - lastPubDates[lastPubKey] >= TWO_MINUTES) {
                // Отправляем в чат событие из фида,
                // и устанавливаем заголовок для OpenNET новости
                //
                //
                const text =
                    lastPubKey === 'opennet'
                        ? `🐌 ${item.title}\n`
                        : chatMsg;
                await sendMessage(CHAT_ID, text, item.link);
                lastPubDates[lastPubKey] = postTime;
                await fs.writeFile(fileName, postTime.toISOString(), 'utf8');
            }
        }
    } catch (err) {
        log.error(`RSS error (${url}): ${err}`);
    }
}

// Генерация функций для RSS
const rssFeeds = [
    //{ key: 'blog', url: 'https://blog.manjaro.org/feed/', msg: '📗 Новая запись в блоге \n', file: 'feed_blog.txt' },
    { key: 'notices', url: 'https://forum.manjaro.org/c/notices.rss', msg: '⚡ Важная заметка \n', file: 'feed_notices.txt' },
    { key: 'releases', url: 'https://forum.manjaro.org/c/announcements/releases.rss', msg: '👻 Новый релиз!\n', file: 'feed_releases.txt' },
    { key: 'stable', url: 'https://forum.manjaro.org/c/announcements/stable-updates.rss', msg: '✅ Стабильное обновление \n', file: 'feed_stable.txt' },
    { key: 'testing', url: 'https://forum.manjaro.org/c/announcements/testing-updates.rss', msg: '⚠ Обновление тестовой ветки\n', file: 'feed_testing.txt' },
    { key: 'unstable', url: 'https://forum.manjaro.org/c/announcements/unstable-updates.rss', msg: '‼ Обновление нестабильной ветки\n', file: 'feed_unstable.txt' },
    { key: 'opennet', url: 'https://www.opennet.ru/opennews/opennews_6_utf.rss', msg: '🐌 OpenNET\n', file: 'feed_opennet.txt' },
];

// Отправка сообщений
async function sendMessage(chatId, message, link) {
    try {
        const randomId = Date.now() + Math.floor(Math.random() * 10000) + 1;
        await api.messages.send({ random_id: randomId, peer_id: chatId, message, attachment: [link] });
    } catch (err) {
        log.error(`sendMessage failed: ${err}`);
    }
}

// Проверка времени последней публикации RSS
async function printStatus(label, file, key) {
    try {
        const data = await fs.readFile(file, 'utf8');
        lastPubDates[key] = new Date(data);
        const diffHours = (Date.now() - lastPubDates[key].getTime()) / 1000 / 3600;
        if (diffHours <= 1) log.success(`${label} ${data}`);
        else if (diffHours >= 720) log.error(`${label} ${data}`); // >1 месяц
        else log.warn(`${label} ${data}`);
    } catch (err) {
        log.error(err);
    }
}

// ---- Обработка входящих сообщений ----
vk.updates.on('message', async context => {
    if (context.senderType !== 'user' || context.peerId !== CHAT_ID) return;

    try {
        const now = Date.now();
        if (!users.has(context.senderId)) {
            const userInfo = await api.users.get({ user_ids: context.senderId });
            users.set(context.senderId, { ...userInfo[0], flood_counter: 0, warn_counter: 0 });
        }

        lastMessagesIds += context.conversationMessageId + ',';
        const user = users.get(context.senderId);

        user.flood_counter = Math.min(user.flood_counter + 1, ANTIFLOOD_COUNTER);
        if (user.flood_counter === ANTIFLOOD_COUNTER) {
            user.warn_counter++;
            if (user.warn_counter >= 4) {
                user.warn_counter = 0;
                await api.messages.removeChatUser({ chat_id: context.peerId - 2000000000, user_id: context.senderId });
                log.warn(`[mute/kick] ${user.last_name}`);
            } else {
                await context.reply(`Не флуди❗(${user.warn_counter}/3)`);
                log.info(`[reply] ${user.last_name}`);
            }
        }
        users.set(context.senderId, user);
        setTimeout(() => updateCounter(context.senderId), ANTIFLOOD_TIME * 1000);

        global.n_messages = (global.n_messages || 0) + 1;
        if (global.n_messages >= 301) {
            global.n_messages = 0;
            await context.send('Уважаемые участники чата, просьба проявлять взаимоуважение...', { random_id: now });
        }
    } catch (err) {
        log.error(err);
    }
});

// ---- Запуск бота ----
async function run() {
    try {
        await vk.updates.start();
        setInterval(() => warningDetector(CHAT_ID), 3000);

        // Вывод статуса RSS
        for (const feed of rssFeeds) await printStatus(feed.key, feed.file, feed.key);

        // Запуск интервалов для RSS
        for (const feed of rssFeeds) setInterval(() => processRssFeed({ url: feed.url, lastPubKey: feed.key, chatMsg: feed.msg, fileName: feed.file }), 240000);

        showLoading();
    } catch (err) {
        log.error(`Bot failed: ${err}`);
        process.exit(1);
    }
}

// ---- Полоска загрузки ----
function showLoading() {
    const len = process.stdout.columns || 50;
    process.stdout.write('#'.repeat(len).black);
    setTimeout(() => log.success('✅ MEGA-BANHAMMER READY! v88.88.000'), 1000);
}

run();
