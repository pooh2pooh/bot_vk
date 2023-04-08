const { API, VK, LinkAttachment } = require('vk-io');
const Parser = require('rss-parser');
const fs = require('fs');

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


function updateCounter(uid)
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

async function warningDetector(chat_id)
{

	const a = await readyMessages(chat_id);
	danger_cmd_filters = [
		/rm\s.*[recursive|force]\s.*/i,
		/rm\s.*[/]\s.*/i,
		/chmod\s.*[7]{3}\s.*/i,
		/curl\s.*\|\s.*sh/i,
		/alias\s.*rm/i,
		/sh\s.*\s.*curl/i,
		/sh\s.*base64/i,
	];

	danger_cmd_filters.forEach(function(arr_item, arr_i, arr) {
		target_msg = a.items.find(item => item.text.match(arr_item));
		// console.log(arr_item);
		if (target_msg) {
			api.messages.send({
				random_id: Math.floor(Math.random() * 9999),
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

async function getRSSFeed()
{
	(async () => {
	  const feed = await parser.parseURL('https://blog.manjaro.org/feed/');
	  // console.log(feed.title);
	 
	  feed.items.forEach(item => {
	  	if (!last_pub_date_rss || new Date(item.isoDate) > last_pub_date_rss) {
		  	api.messages.send({
		  		random_id: Math.floor(Math.random() * 9999),
		      peer_id: chat_id,
		      message: '📗 Новая запись в блоге \n',
		      attachment: [
						item.link,
					]
	      });
	      last_pub_date_rss = new Date(item.isoDate);
	      fs.writeFileSync('feed_blog.txt', item.isoDate, 'utf8');
	      // console.log(item.isoDate + ' ' + item.title + ': ' + item.link)
	  	}
	    // console.log(item.title + ': ' + item.link)
	  });
	})();

	(async () => {
	  const feed = await parser.parseURL('https://forum.manjaro.org/c/announcements/news.rss');
	  // console.log(feed.title);
	 
	  feed.items.forEach(item => {
	  	if (!last_pub_date_rss_news || new Date(item.isoDate) > last_pub_date_rss_news) {
		  	api.messages.send({
		  		random_id: Math.floor(Math.random() * 9999),
		      peer_id: chat_id,
		      message: '⚡ Новости \n',
		      attachment: [
						item.link,
					]
	      });
	      last_pub_date_rss_news = new Date(item.isoDate);
	      fs.writeFileSync('feed_news.txt', item.isoDate, 'utf8');
	      // console.log(item.isoDate + ' ' + item.title + ': ' + item.link)
	  	}
	    // console.log(item.isoDate + ' ' + item.title + ': ' + item.link)
	  });
	})();

	(async () => {
	  const feed = await parser.parseURL('https://forum.manjaro.org/c/announcements/releases.rss');
	  // console.log(feed.title);
	 
	  feed.items.forEach(item => {
	  	if (!last_pub_date_rss_releases || new Date(item.isoDate) > last_pub_date_rss_releases) {
		  	api.messages.send({
		  		random_id: Math.floor(Math.random() * 9999),
		      peer_id: chat_id,
		      message: '👻 Новый релиз! \n',
		      attachment: [
						item.link,
					]
	      });
	      last_pub_date_rss_releases = new Date(item.isoDate);
	      fs.writeFileSync('feed_releases.txt', item.isoDate, 'utf8');
	      // console.log(item.isoDate + ' ' + item.title + ': ' + item.link)
	  	}
	    // console.log(item.isoDate + ' ' + item.title + ': ' + item.link)
	  });
	})();

	(async () => {
	  const feed = await parser.parseURL('https://forum.manjaro.org/c/announcements/stable-updates.rss');
	  // console.log(feed.title);
	 
	  feed.items.forEach(item => {
	  	if (!last_pub_date_rss_stable || new Date(item.isoDate) > last_pub_date_rss_stable) {
		  	api.messages.send({
		  		random_id: Math.floor(Math.random() * 9999),
		      peer_id: chat_id,
		      message: '✅ Стабильное обновление \n',
		      attachment: [
						item.link,
					]
	      });
	      last_pub_date_rss_stable = new Date(item.isoDate);
	      fs.writeFileSync('feed_stable.txt', item.isoDate, 'utf8');
	      // console.log(item.isoDate + ' ' + item.title + ': ' + item.link)
	  	}
	    // console.log(item.isoDate + ' ' + item.title + ': ' + item.link)
	  });
	})();

	(async () => {
	  const feed = await parser.parseURL('https://forum.manjaro.org/c/announcements/testing-updates.rss');
	  // console.log(feed.title);
	 
	  feed.items.forEach(item => {
	  	if (!last_pub_date_rss_testing || new Date(item.isoDate) > last_pub_date_rss_testing) {
		  	api.messages.send({
		  		random_id: Math.floor(Math.random() * 9999),
		      peer_id: chat_id,
		      message: '⚠ Обновление тестовой ветки\n',
		      attachment: [
						item.link,
					]
	      });
	      last_pub_date_rss_testing = new Date(item.isoDate);
	      fs.writeFileSync('feed_testing.txt', item.isoDate, 'utf8');
	      // console.log(item.isoDate + ' ' + item.title + ': ' + item.link)
	  	}
	    // console.log(item.isoDate + ' ' + item.title + ': ' + item.link)
	  });
	})();

	(async () => {
	  const feed = await parser.parseURL('https://forum.manjaro.org/c/announcements/unstable-updates.rss');
	  // console.log(feed.title);
	 
	  feed.items.forEach(item => {
	  	if (!last_pub_date_rss_unstable || new Date(item.isoDate) > last_pub_date_rss_unstable) {
		  	api.messages.send({
		  		random_id: Math.floor(Math.random() * 9999),
		      peer_id: chat_id,
		      message: '‼ Обновление нестабильной ветки\n',
		      attachment: [
						item.link,
					]
	      });
	      fs.writeFileSync('feed_unstable.txt', item.isoDate, 'utf8');
	      // console.log(item.isoDate + ' ' + item.title + ': ' + item.link)
	  	}
	    // console.log(item.isoDate + ' ' + item.title + ': ' + item.link)
	  });
	})();

	// console.log('Okay. Get RSS feed.');
}


vk.updates.on('message', async (context) => {

	// if (context.senderId == 281457599 || context.senderId == 224935241 || context.senderId == 314177574) {
	// 	// Исключения для анти-флуда
	// 	return;
	// }


	if (context.senderType === 'user' && context.peerId == chat_id) {
		try {
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
			if (cur_user[1]['flood_counter'] < 5) {
				cur_user[1]['flood_counter']++;
			}
			if (cur_user[1]['flood_counter'] == 5) {
				cur_user[1]['warn_counter']++;
				if (cur_user[1]['warn_counter'] == 2) {
					// await context.reply('мут 1 минуту'); ## uncomment for mute action!
					cur_user[1]['warn_counter'] = 0;
					console.log('[mute] for ' + cur_user[0]['last_name']);
				} else {
					await context.reply('Не флуди❗');
					console.log('[reply] for ' + cur_user[0]['last_name']);
				}
				// context.send();
			}
			users.set(context.senderId, cur_user);
			setTimeout(updateCounter, 7000, context.senderId);
			// console.log(cur_user);
			// console.log('[ok] context.senderType user');
			// regular rules!
			if (typeof n_messages === "undefined") {
				n_messages = 0;
			}
			n_messages++;
			if (n_messages == 301) {
				n_messages = 0;
				await context.send('Уважаемые участники чата, просьба проявлять взаимоуважение друг к другу. Избегать сообщений не по теме, оскорблений и другой агрессии. Будьте терпимее к новичкам и их вопросам. Спасибо.');
			}
		} catch (error) {
			console.log('[err] ' + error);
		}
		return;
	}

});


async function run()
{

	await vk.updates.start().catch(console.error);
	setInterval(warningDetector, 3000, chat_id);

	// чтение последнего поста в блоге
	fs.readFile('feed_blog.txt', 'utf8', function(err, data) {
	  if (err) {
	    console.error(err);
	  } else {
	  	last_pub_date_rss = new Date(data);
	    // console.log(data);
	  }
	});

	// чтение последнего анонса
	fs.readFile('feed_news.txt', 'utf8', function(err, data) {
	  if (err) {
	    console.error(err);
	  } else {
	  	last_pub_date_rss_news = new Date(data);
	    // console.log(data);
	  }
	});

	// чтение последнего релиза
	fs.readFile('feed_releases.txt', 'utf8', function(err, data) {
	  if (err) {
	    console.error(err);
	  } else {
	  	last_pub_date_rss_releases = new Date(data);
	    // console.log(data);
	  }
	});

	// чтение последнего стабильного обновления
	fs.readFile('feed_stable.txt', 'utf8', function(err, data) {
	  if (err) {
	    console.error(err);
	  } else {
	  	last_pub_date_rss_stable = new Date(data);
	    // console.log(data);
	  }
	});

	// чтение последнего тестового обновления
	fs.readFile('feed_testing.txt', 'utf8', function(err, data) {
	  if (err) {
	    console.error(err);
	  } else {
	  	last_pub_date_rss_testing = new Date(data);
	    // console.log(data);
	  }
	});

	// чтение последнего НЕстабильного обновления
	fs.readFile('feed_unstable.txt', 'utf8', function(err, data) {
	  if (err) {
	    console.error(err);
	  } else {
	  	last_pub_date_rss_unstable = new Date(data);
	    // console.log(data);
	  }
	});

	setInterval(getRSSFeed, 600000);

}

run();
