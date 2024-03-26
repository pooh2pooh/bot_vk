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


let last_pub_date_rss = null;
let last_pub_date_rss_news = null;
let last_pub_date_rss_releases = null;
let last_pub_date_rss_stable = null;
let last_pub_date_rss_testing = null;
let last_pub_date_rss_unstable = null;

// Переводим две минуты в миллисекунды (1 минута = 60 секунд = 60 000 миллисекунд)
// для использовании в условии с проверкой временной метки последнего отправленного сообщения из RSS → ВК
let twoMinutes = 2 * 60 * 1000;


// Период (в секундах) через который убавляется счётчик АНТИФЛУДа для пользователя
const ANTIFLOOD_TIME = 7;
// Сколько сообщений подряд от одного пользователя, будет считаться флудом
const ANTIFLOOD_COUNTER = 4;


// Убавляет счётчик АНТИФЛУДа для пользователя,
// каждое сообщение пользователя вызывает эту функцию по таймеру
async function updateCounter(uid)
{
		user = users.get(uid);
		// console.log(user);
		if (user[1]['flood_counter'] > 0) {
			user[1]['flood_counter']--;
		}
		users.set(uid, user);
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
		danger_cmd_filters = [
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

		danger_cmd_filters.forEach(function(arr_item, arr_i, arr) {
			target_msg = a.items.find(item => item.text.match(arr_item));
			// console.log(arr_item);
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


async function get_rss_feed()
{
		(async () => {
			try {
			  const feed = await parser.parseURL('https://blog.manjaro.org/feed/');
			  // console.log(feed.title);
		 
			  feed.items.forEach(item => {
			  	post_time = new Date(item.isoDate);
			  	if (!last_pub_date_rss || post_time >= (last_pub_date_rss.getTime() + twoMinutes)) {
			      sendMessage(chat_id, '📗 Новая запись в блоге \n', item.link);
			      last_pub_date_rss = new Date(item.isoDate);
			      fs.writeFileSync('feed_blog.txt', last_pub_date_rss.toISOString(), 'utf8');
			      // console.log(item.isoDate + ' ' + item.title + ': ' + item.link)
			  	}
			    // console.log(item.title + ': ' + item.link)
			  });
		  } catch (error) {
				console.log('[err] ' + error);
			}
		})();

		//console.log('[ok]. Get RSS feed for Feed.');
}


async function get_rss_notices()
{
		(async () => {
			try {
			  const feed = await parser.parseURL('https://forum.manjaro.org/c/notices.rss');
			  // console.log(feed.title);
			 
			  feed.items.forEach(item => {
			  	post_time = new Date(item.isoDate);
			  	if (!last_pub_date_rss_news || post_time >= (last_pub_date_rss_news.getTime() + twoMinutes)) {
			      sendMessage(chat_id, '⚡ Важная заметка \n', item.link);
			      last_pub_date_rss_news = new Date(item.isoDate);
			      fs.writeFileSync('feed_notices.txt', last_pub_date_rss_news.toISOString(), 'utf8');
			      // console.log(item.isoDate + ' ' + item.title + ': ' + item.link)
			  	}
			    // console.log(item.isoDate + ' ' + item.title + ': ' + item.link)
			  });
			} catch (error) {
				console.log('[err] ' + error);
			}
		})();

		//console.log('[ok]. Get RSS feed for Notices.');
}


async function get_rss_releases()
{
		(async () => {
			try {
			  const feed = await parser.parseURL('https://forum.manjaro.org/c/announcements/releases.rss');
			  // console.log(feed.title);
			 
			  feed.items.forEach(item => {
			  	post_time = new Date(item.isoDate);
			  	if (!last_pub_date_rss_releases || post_time >= (last_pub_date_rss_releases.getTime() + twoMinutes)) {
			      sendMessage(chat_id, '👻 Новый релиз!\n', item.link);
			      last_pub_date_rss_releases = new Date(item.isoDate);
			      fs.writeFileSync('feed_releases.txt', last_pub_date_rss_releases.toISOString(), 'utf8');
			      // console.log(item.isoDate + ' ' + item.title + ': ' + item.link)
			  	}
			    // console.log(item.isoDate + ' ' + item.title + ': ' + item.link)
			  });
			} catch (error) {
				console.log('[err] ' + error);
			}
		})();

		//console.log('[ok]. Get RSS feed for Releases.');
}


async function get_rss_stable()
{
		(async () => {
			try {
			  const feed = await parser.parseURL('https://forum.manjaro.org/c/announcements/stable-updates.rss');
			  // console.log(feed.title);
			 
			  feed.items.forEach(item => {
			  	post_time = new Date(item.isoDate);
			  	if (!last_pub_date_rss_stable || post_time >= (last_pub_date_rss_stable.getTime() + twoMinutes)) {
			      sendMessage(chat_id, '✅ Стабильное обновление \n', item.link);
			      last_pub_date_rss_stable = new Date(item.isoDate);
			      fs.writeFileSync('feed_stable.txt', last_pub_date_rss_stable.toISOString(), 'utf8');
			      // console.log(item.isoDate + ' ' + item.title + ': ' + item.link)
			  	}
			    // console.log(item.isoDate + ' ' + item.title + ': ' + item.link)
			  });
		  } catch (error) {
				console.log('[err] ' + error);
			}
		})();

		//console.log('[ok]. Get RSS feed for Stable branch.');
}


async function get_rss_testing()
{
		(async () => {
			try {
			  const feed = await parser.parseURL('https://forum.manjaro.org/c/announcements/testing-updates.rss');
			  // console.log(feed.title);
			 
			  feed.items.forEach(item => {
			  	post_time = new Date(item.isoDate);
			  	if (!last_pub_date_rss_testing || post_time >= (last_pub_date_rss_testing.getTime() + twoMinutes)) {
			      sendMessage(chat_id, '⚠ Обновление тестовой ветки\n', item.link);
			      last_pub_date_rss_testing = new Date(item.isoDate);
			      fs.writeFileSync('feed_testing.txt', last_pub_date_rss_testing.toISOString(), 'utf8');
			      // console.log(item.isoDate + ' ' + item.title + ': ' + item.link)
			  	}
			    // console.log(item.isoDate + ' ' + item.title + ': ' + item.link)
			  });
		  } catch (error) {
				console.log('[err] ' + error);
			}
		})();

		//console.log('[ok]. Get RSS feed for Testing branch.');
}


async function get_rss_unstable()
{
		(async () => {
			try {
			  const feed = await parser.parseURL('https://forum.manjaro.org/c/announcements/unstable-updates.rss');
			  // console.log(feed.title);
			 
			  feed.items.forEach(item => {
			  	post_time = new Date(item.isoDate);
			  	if (!last_pub_date_rss_unstable  || post_time >= (last_pub_date_rss_unstable.getTime() + twoMinutes)) {
				  	sendMessage(chat_id, '‼ Обновление нестабильной ветки\n', item.link);
			      last_pub_date_rss_unstable = new Date(item.isoDate);
			      fs.writeFileSync('feed_unstable.txt', last_pub_date_rss_unstable.toISOString(), 'utf8');
			      // console.log(item.isoDate + ' ' + item.title + ': ' + item.link)
			  	}
			    // console.log(item.isoDate + ' ' + item.title + ': ' + item.link)
			  });
		  } catch (error) {
				console.log('[err] ' + error);
			}
		})();

		//console.log('[ok] Get RSS feed for Unstable branch.');
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
					user = await api.users.get({
						user_ids: context.senderId
					});
					params = {
						'flood_counter': 0,
						'warn_counter': 0,
					}
					user.push(params);
					users.set(context.senderId, user);
				}

				last_messages_ids += context.conversationMessageId + ',';
				// console.log(last_messages_ids);


				// anti-flood
				cur_user = users.get(context.senderId);
				if (cur_user[1]['flood_counter'] < ANTIFLOOD_COUNTER) {
					cur_user[1]['flood_counter']++;
				}
				if (cur_user[1]['flood_counter'] == ANTIFLOOD_COUNTER) {
					cur_user[1]['warn_counter']++;
					if (cur_user[1]['warn_counter'] == 2) {
						// await context.reply('мут 1 минуту'); ## uncomment for mute action!
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
					// context.send();
				}
				users.set(context.senderId, cur_user);
				setTimeout(await updateCounter, ANTIFLOOD_TIME*1000, context.senderId);
				// console.log(cur_user);
				// console.log('[ok] context.senderType user');

				// regular rules!
				if (typeof n_messages === "undefined") {
					n_messages = 0;
				}
				n_messages++;
				if (n_messages == 301) {
					n_messages = 0;
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


async function run()
{
		await vk.updates.start().catch(console.error);
		setInterval(warningDetector, 3000, chat_id);

		const currentDate = new Date();
		let color;

		console.log('\nLast Sync Time:'.white);

		// чтение последнего поста в блоге
		fs.readFile('feed_blog.txt', 'utf8', function(err, data) {
		  if (err) {
		    console.error(err);
		  } else {

		  	last_pub_date_rss = new Date(data);

		  	const timeDiff = currentDate.getTime() - last_pub_date_rss.getTime();
		  	// Преобразуем время в часы и месяцы
				const hoursDiff = Math.floor(timeDiff / (1000 * 60 * 60));
				const monthsDiff = Math.floor(hoursDiff / (24 * 30));

				// Устанавливаем цвет в зависимости от временной разницы
				if (hoursDiff <= 1) {
				    console.log('Blog → '.green + data)
				} else if (monthsDiff >= 1) {
				    console.log('Blog → '.red + data)
				} else {
				    // В этом случае, если прошло более 1 часа, но менее 1 месяца
				    // Вы можете выбрать другой цвет, если хотите
				    console.log('Blog → '.yellow + data)
				}
		  }
		});

		// чтение последнего анонса
		fs.readFile('feed_notices.txt', 'utf8', function(err, data) {
		  if (err) {
		    console.error(err);
		  } else {
		  	last_pub_date_rss_news = new Date(data);
		    
		  	const timeDiff = currentDate.getTime() - last_pub_date_rss_news.getTime();
		  	// Преобразуем время в часы и месяцы
				const hoursDiff = Math.floor(timeDiff / (1000 * 60 * 60));
				const monthsDiff = Math.floor(hoursDiff / (24 * 30));

				// Устанавливаем цвет в зависимости от временной разницы
				if (hoursDiff <= 1) {
				    console.log('News → '.green + data)
				} else if (monthsDiff >= 1) {
				    console.log('News → '.red + data)
				} else {
				    // В этом случае, если прошло более 1 часа, но менее 1 месяца
				    // Вы можете выбрать другой цвет, если хотите
				    console.log('News → '.yellow + data)
				}
		  }
		});

		// чтение последнего релиза
		fs.readFile('feed_releases.txt', 'utf8', function(err, data) {
		  if (err) {
		    console.error(err);
		  } else {
		  	last_pub_date_rss_releases = new Date(data);
		    
		  	const timeDiff = currentDate.getTime() - last_pub_date_rss_releases.getTime();
		  	// Преобразуем время в часы и месяцы
				const hoursDiff = Math.floor(timeDiff / (1000 * 60 * 60));
				const monthsDiff = Math.floor(hoursDiff / (24 * 30));

				// Устанавливаем цвет в зависимости от временной разницы
				if (hoursDiff <= 1) {
				    console.log('Releases → '.green + data)
				} else if (monthsDiff >= 1) {
				    console.log('Releases → '.red + data)
				} else {
				    // В этом случае, если прошло более 1 часа, но менее 1 месяца
				    // Вы можете выбрать другой цвет, если хотите
				    console.log('Releases → '.yellow + data)
				}
		  }
		});

		// чтение последнего стабильного обновления
		fs.readFile('feed_stable.txt', 'utf8', function(err, data) {
		  if (err) {
		    console.error(err);
		  } else {
		  	last_pub_date_rss_stable = new Date(data);
		    
		  	const timeDiff = currentDate.getTime() - last_pub_date_rss_stable.getTime();
		  	// Преобразуем время в часы и месяцы
				const hoursDiff = Math.floor(timeDiff / (1000 * 60 * 60));
				const monthsDiff = Math.floor(hoursDiff / (24 * 30));

				// Устанавливаем цвет в зависимости от временной разницы
				if (hoursDiff <= 1) {
				    console.log('Stable branch → '.green + data)
				} else if (monthsDiff >= 1) {
				    console.log('Stable branch → '.red + data)
				} else {
				    // В этом случае, если прошло более 1 часа, но менее 1 месяца
				    // Вы можете выбрать другой цвет, если хотите
				    console.log('Stable branch → '.yellow + data)
				}
		  }
		});

		// чтение последнего тестового обновления
		fs.readFile('feed_testing.txt', 'utf8', function(err, data) {
		  if (err) {
		    console.error(err);
		  } else {
		  	last_pub_date_rss_testing = new Date(data);
		   
		  	const timeDiff = currentDate.getTime() - last_pub_date_rss_testing.getTime();
		  	// Преобразуем время в часы и месяцы
				const hoursDiff = Math.floor(timeDiff / (1000 * 60 * 60));
				const monthsDiff = Math.floor(hoursDiff / (24 * 30));

				// Устанавливаем цвет в зависимости от временной разницы
				if (hoursDiff <= 1) {
				    console.log('Testing branch → '.green + data)
				} else if (monthsDiff >= 1) {
				    console.log('Testing branch → '.red + data)
				} else {
				    // В этом случае, если прошло более 1 часа, но менее 1 месяца
				    // Вы можете выбрать другой цвет, если хотите
				    console.log('Testing branch → '.yellow + data)
				}
		  }
		});

		// чтение последнего НЕстабильного обновления
		fs.readFile('feed_unstable.txt', 'utf8', function(err, data) {
		  if (err) {
		    console.error(err);
		  } else {
		  	last_pub_date_rss_unstable = new Date(data);
		    
		  	const timeDiff = currentDate.getTime() - last_pub_date_rss_unstable.getTime();
		  	// Преобразуем время в часы и месяцы
				const hoursDiff = Math.floor(timeDiff / (1000 * 60 * 60));
				const monthsDiff = Math.floor(hoursDiff / (24 * 30));

				// Устанавливаем цвет в зависимости от временной разницы
				if (hoursDiff <= 1) {
				    console.log('Unstable branch → '.green + data)
				} else if (monthsDiff >= 1) {
				    console.log('Unstable branch → '.red + data)
				} else {
				    // В этом случае, если прошло более 1 часа, но менее 1 месяца
				    // Вы можете выбрать другой цвет, если хотите
				    console.log('Unstable branch → '.yellow + data)
				}
		  }
		});

		// Этот канал отвалился, ошибка 404
		// setInterval(get_rss_feed, 6000);
		// Изменил период проверки обновлений с 6 на 240 секунд,
		// чтобы не насиловать свой и их серверы.
		//
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
