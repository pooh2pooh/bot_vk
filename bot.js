const { API, VK, LinkAttachment } = require('vk-io');
const Parser = require('rss-parser');
const fs = require('fs');
const colors = require('colors');

let config = require('./token.json');

const parser = new Parser();
const vk = new VK(config);
const api = new API(config);




// dev chat - 2000000003
// adm chat - 2000000002
// main chat - 2000000001
const chat_id = 2000000003;

let users = new Map();
let last_messages_ids = "99,";


// Оптимизированная структура для хранения дат публикаций RSS
let last_pub_dates = {
    blog: null,
    notices: null,
    releases: null,
    stable: null,
    testing: null,
    unstable: null
};

// Переводим две минуты в миллисекунды (1 минута = 60 секунд = 60 000 миллисекунд)
// для использовании в условии с проверкой временной метки последнего отправленного сообщения из RSS → ВК
let twoMinutes = 2 * 60 * 1000;


// Период (в секундах) через который убавляется счётчик АНТИФЛУДа для пользователя
const ANTIFLOOD_TIME = 7;
// Сколько сообщений подряд от одного пользователя, будет считаться флудом
const ANTIFLOOD_COUNTER = 4;


// Убавляет счётчик АНТИФЛУДа для пользователя,
// каждое сообщение пользователя вызывает эту функцию по таймеру
async function updateCounter(uid) {
    let user = users.get(uid);
    if (user && user[1]['flood_counter'] > 0) {
        user[1]['flood_counter']--;
        users.set(uid, user);
    }
}


function readyMessages(chat_id)
{
		return api.messages.getByConversationMessageId({
			peer_id: chat_id,
			conversation_message_ids: last_messages_ids
		});
}

// Ищет в сообщених опасные команды,
// даже если отредактировано старое сообщение
async function warningDetector(chat_id)
{
    const now = new Date();
    const randomId = now.getTime();
    const a = await readyMessages(chat_id);
    const danger_cmd_filters = [
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
    danger_cmd_filters.forEach(function(arr_item) {
        const target_msg = a.items.find(item => item.text.match(arr_item));
        if (target_msg) {
            api.messages.send({
                random_id: randomId,
                peer_id: target_msg.peer_id,
                message: '❗ Потенциально опасная команда❗ Не вводите её в терминал если точно не понимаете что она делает!',
                reply_to: target_msg.id
            });
            last_messages_ids = last_messages_ids.replace(target_msg.conversation_message_id + ',', '');
            console.log('[warning] danger cmd detect! ');
        }
    });
    if (a.count > 98) {
        last_messages_ids = "1,";
    }
}


// Универсальная функция для обработки RSS-лент
async function processRssFeed({ url, lastPubKey, chatMsg, fileName }) {
    try {
        const feed = await parser.parseURL(url);
        feed.items.forEach(item => {
            const postTime = new Date(item.isoDate);
            if (!last_pub_dates[lastPubKey] || postTime >= (last_pub_dates[lastPubKey].getTime() + twoMinutes)) {
                sendMessage(chat_id, chatMsg, item.link);
                last_pub_dates[lastPubKey] = new Date(item.isoDate);
                fs.writeFileSync(fileName, last_pub_dates[lastPubKey].toISOString(), 'utf8');
            }
        });
    } catch (error) {
        console.log('[err] ' + error);
    }
}


function get_rss_feed() {
    processRssFeed({
        url: 'https://blog.manjaro.org/feed/',
        lastPubKey: 'blog',
        chatMsg: '📗 Новая запись в блоге \n',
        fileName: 'feed_blog.txt'
    });
}
function get_rss_notices() {
    processRssFeed({
        url: 'https://forum.manjaro.org/c/notices.rss',
        lastPubKey: 'notices',
        chatMsg: '⚡ Важная заметка \n',
        fileName: 'feed_notices.txt'
    });
}
function get_rss_releases() {
    processRssFeed({
        url: 'https://forum.manjaro.org/c/announcements/releases.rss',
        lastPubKey: 'releases',
        chatMsg: '👻 Новый релиз!\n',
        fileName: 'feed_releases.txt'
    });
}
function get_rss_stable() {
    processRssFeed({
        url: 'https://forum.manjaro.org/c/announcements/stable-updates.rss',
        lastPubKey: 'stable',
        chatMsg: '✅ Стабильное обновление \n',
        fileName: 'feed_stable.txt'
    });
}
function get_rss_testing() {
    processRssFeed({
        url: 'https://forum.manjaro.org/c/announcements/testing-updates.rss',
        lastPubKey: 'testing',
        chatMsg: '⚠ Обновление тестовой ветки\n',
        fileName: 'feed_testing.txt'
    });
}
function get_rss_unstable() {
    processRssFeed({
        url: 'https://forum.manjaro.org/c/announcements/unstable-updates.rss',
        lastPubKey: 'unstable',
        chatMsg: '‼ Обновление нестабильной ветки\n',
        fileName: 'feed_unstable.txt'
    });
}


vk.updates.on('message', async (context) => {

		// if (context.senderId == 281457599 || context.senderId == 224935241 || context.senderId == 314177574) {
		// 	// Исключения для анти-флуда
		// 	return;
		// }


		if (context.senderType === 'user' && context.peerId == chat_id) {
			try {
				const now = new Date();
				const randomId = now.getTime();
				if (!users.has(context.senderId)) {
					let user = await api.users.get({ user_ids: context.senderId });
					let params = {
						'flood_counter': 0,
						'warn_counter': 0,
					};
					user.push(params);
					users.set(context.senderId, user);
				}
				last_messages_ids += context.conversationMessageId + ',';
				let cur_user = users.get(context.senderId);
				if (cur_user[1]['flood_counter'] < ANTIFLOOD_COUNTER) {
					cur_user[1]['flood_counter']++;
				}
				if (cur_user[1]['flood_counter'] == ANTIFLOOD_COUNTER) {
					cur_user[1]['warn_counter']++;
					if (cur_user[1]['warn_counter'] == 2) {
						cur_user[1]['warn_counter'] = 0;
						api.messages.removeChatUser({
							chat_id: context.peerId - 2000000000,
							user_id: context.senderId,
						});
						console.log('[mute/kick] for ' + cur_user[0]['last_name']);
					} else {
						await context.reply('Не флуди❗');
						console.log('[reply] for ' + cur_user[0]['last_name']);
					}
				}
				users.set(context.senderId, cur_user);
				setTimeout(() => updateCounter(context.senderId), ANTIFLOOD_TIME * 1000);
				if (typeof global.n_messages === "undefined") {
					global.n_messages = 0;
				}
				global.n_messages++;
				if (global.n_messages == 301) {
					global.n_messages = 0;
					await context.send('Уважаемые участники чата, просьба проявлять взаимоуважение друг к другу. Избегать сообщений не по теме, оскорблений и другой агрессии. Будьте терпимее к новичкам и их вопросам. Спасибо.', { random_id: randomId });
				}
			} catch (error) {
				console.log('[err] ' + error);
			}
			return;
		}

});


// Отправляет сообщение в чат
function sendMessage(chat_id, message, link)
{
	  let now = new Date();
	  // Генерация случайного числа в диапазоне от 1 до 10000
	  let randomNum = Math.floor(Math.random() * 10000) + 1;
	  // Комбинирование времени и случайного числа для создания уникального randomId
	  let randomId = now.getTime() + randomNum;

	  api.messages.send({
	    random_id: randomId,
	    peer_id: chat_id,
	    message: message,
	    attachment: [
	        link,
	    ]
	  });
}


// Оптимизация вывода статуса по времени для всех RSS-файлов
function printStatus(label, file, key) {
    fs.readFile(file, 'utf8', (err, data) => {
        if (err) {
            console.error(err);
        } else {
            last_pub_dates[key] = new Date(data);
            const currentDate = new Date();
            const timeDiff = currentDate.getTime() - last_pub_dates[key].getTime();
            const hoursDiff = Math.floor(timeDiff / (1000 * 60 * 60));
            const monthsDiff = Math.floor(hoursDiff / (24 * 30));
            if (hoursDiff <= 1) {
                console.log(`${label} `.green + data);
            } else if (monthsDiff >= 1) {
                console.log(`${label} `.red + data);
            } else {
                console.log(`${label} `.yellow + data);
            }
        }
    });
}


async function run() {
    await vk.updates.start().catch(console.error);
    setInterval(() => warningDetector(chat_id), 3000);
    console.log('\nLast Sync Time:'.white);
    printStatus('Blog →', 'feed_blog.txt', 'blog');
    printStatus('News →', 'feed_notices.txt', 'notices');
    printStatus('Releases →', 'feed_releases.txt', 'releases');
    printStatus('Stable branch →', 'feed_stable.txt', 'stable');
    printStatus('Testing branch →', 'feed_testing.txt', 'testing');
    printStatus('Unstable branch →', 'feed_unstable.txt', 'unstable');
    setInterval(get_rss_notices, 240000);
    setInterval(get_rss_releases, 240000);
    setInterval(get_rss_stable, 240000);
    setInterval(get_rss_testing, 240000);
    setInterval(get_rss_unstable, 240000);
}

run();

// Функция для вывода полоски загрузки
function showLoading() {
    // Определяем длину полоски загрузки
    const loadingLength = process.stdout.columns || 50; // Получаем ширину терминала

    // Выводим полоску загрузки
    let loadingBar = '';
    for (let i = 0; i < loadingLength; i++) {
        loadingBar += '#'.black;
    }
    process.stdout.write(loadingBar);

    // Ждем некоторое время перед заменой на сообщение
    setTimeout(() => {
        console.log('\n✅ MEGA-BANHAMMER READY! v88.88.000'.green); // Выводим сообщение
    }, 1000); // Задержка в миллисекундах перед заменой
}

// console.log('✅ MEGA-BANHAMMER READY!'.green);
showLoading();
