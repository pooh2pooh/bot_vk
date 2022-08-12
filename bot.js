const {
	API,
	VK
} = require('vk-io');

const vk = new VK({
	// token: '950966ad649b862b3b0044a8827a42ab185760ac998388240911815ce96d3ab921d7f79fa24b80e65862a' ## Pooh bot
	// token: 'add691fa45b26977dc5d9f170293680f57d2518731cf1424ab3b8932d16d437526e227349ba0bc5d1b605' ## Andrey Kovalev
	token: 'e5097bcce26c4d88176eda74ee156b492528c0c19bf8e6a0cf3c2f18d2d1a87e443f7f37b3fd879c972cd'
});
const api = new API({
	// token: '950966ad649b862b3b0044a8827a42ab185760ac998388240911815ce96d3ab921d7f79fa24b80e65862a'
	// token: 'add691fa45b26977dc5d9f170293680f57d2518731cf1424ab3b8932d16d437526e227349ba0bc5d1b605'
	token: 'e5097bcce26c4d88176eda74ee156b492528c0c19bf8e6a0cf3c2f18d2d1a87e443f7f37b3fd879c972cd'
});
// to dev chat - 2000000003
// to adm chat - 2000000002
// to main chat - 2000000001
const chat_id = 2000000003;


let users = new Map();

function updateCounter(uid) {
	user = users.get(uid);
	// console.log(user);
	if (user[1]['flood_counter'] > 0) {
		user[1]['flood_counter']--;
	}
	users.set(uid, user);
}

let last_messages_ids = "1,";

function readyMessages(peer_id) {
	return api.messages.getByConversationMessageId({peer_id: chat_id, conversation_message_ids: last_messages_ids});
}

async function warningDetector(peer_id) {

	const a = await readyMessages(peer_id);


	target_msg = a.items.find(item => /rm\s.*recursive\s.*force/i.test(item.text));
	if (target_msg) {

		api.messages.send({random_id: Math.floor(Math.random() * 9999), peer_id: target_msg.peer_id, message: '❗ Потенциально опасная команда❗ Не вводите её в терминал если точно не понимаете что она делает!', reply_to: target_msg.id});
		last_messages_ids = last_messages_ids.replace(target_msg.conversation_message_id+',', '');
		console.log('[warning] danger cmd detect! ');
		return;

	} else {

		target_msg = a.items.find(item => /rm\s.*-[rf]{2}\s.*/i.test(item.text));
		if (target_msg) {

			api.messages.send({random_id: Math.floor(Math.random() * 9999), peer_id: target_msg.peer_id, message: '❗ Потенциально опасная команда❗ Не вводите её в терминал если точно не понимаете что она делает!', reply_to: target_msg.id});
			last_messages_ids = last_messages_ids.replace(target_msg.conversation_message_id+',', '');
			console.log('[warning] danger cmd detect! ');
			return;

		} else {

			target_msg = a.items.find(item => /chmod\s.*[7]{3}\s.*/i.test(item.text));
			if (target_msg) {

				api.messages.send({random_id: Math.floor(Math.random() * 9999), peer_id: target_msg.peer_id, message: '❗ Потенциально опасная команда❗ Не вводите её в терминал если точно не понимаете что она делает!', reply_to: target_msg.id});
				last_messages_ids = last_messages_ids.replace(target_msg.conversation_message_id+',', '');
				console.log('[warning] danger cmd detect! ');
				return;

			}

		}

	}

	if (a.count > 99) {
		last_messages_ids = "";
	}
}

vk.updates.on('message', async (context) => {

	if (context.senderId == 28145759 || context.senderId == 224935241 || context.senderId == 314177574) {
		// Исключения для анти-флуда
		return;
	}


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

			last_messages_ids += context.conversationMessageId+',';
			console.log(last_messages_ids);



			/*if (context.text.toLowerCase().indexOf('rm -rf') != -1 || context.text.toLowerCase().indexOf('rm -fr') != -1 || context.text.toLowerCase().indexOf('rm-rf') != -1 || context.text.toLowerCase().indexOf('rm-fr') != -1 || /rm\s.*recursive\s.*force/i.test(context.text) == true) {
				await context.reply('❗ Потенциально опасная команда❗ Не вводите её в терминал если точно не понимаете что она делает!');
				console.log('[warning] danger cmd detect! ');
				return;
			}

			if (context.text.toLowerCase().indexOf('chmod 777') != -1 || context.text.toLowerCase().indexOf('chmod -r 777') != -1) {
				await context.reply('❗ Потенциально опасная команда❗ Не вводите её в терминал если точно не понимаете что она делает!');
				console.log('[warning] danger cmd detect!');
				return;
			}*/

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
			console.log('[ok] context.senderType user');
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


async function run() {

	await vk.updates.start().catch(console.error);
	setInterval(warningDetector, 3000, chat_id);

}

run();

