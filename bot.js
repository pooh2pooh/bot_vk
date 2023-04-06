const { API, VK } = require('vk-io');

let config = require('./token.json');

const vk = new VK(config);
const api = new API(config);
// dev chat - 2000000003
// adm chat - 2000000002
// main chat - 2000000001
const chat_id = 2000000003;

let users = new Map();
let last_messages_ids = "99,";


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

}

run();
