const { API, VK } = require('vk-io');

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

let users = new Map();

function updateCounter(uid) {
    user = users.get(uid);
    // console.log(user);
    if (user[1]['flood_counter'] > 0) {
        user[1]['flood_counter']--;
    }
    users.set(uid, user);
}

vk.updates.on('message_new', async (context) => {

    // console.log(context);

    if (context.senderId == 281457599 || context.senderId == 224935241 || context.senderId == 314177574) {
    // Исключения для анти-флуда
        return;
    }

    if (context.senderType === 'user' && context.peerId == 2000000037) {
        try {
            if (!users.has(context.senderId)) {
                user = await api.users.get({user_ids: context.senderId});
                params = { 
                    'flood_counter': 0,
                    'warn_counter': 0,
                }
                user.push(params);
                users.set(context.senderId, user);
            }

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
                    console.log('[mute] for '+cur_user[0]['last_name']);
                }
                else {
                    await context.reply('Не флуди❗');
                    console.log('[reply] for '+cur_user[0]['last_name']);
                }
                // context.send();
            }
            users.set(context.senderId, cur_user);
            setTimeout(updateCounter, 7000, context.senderId);
            // console.log(cur_user);
            console.log('[ok] context.senderType user');
        } catch (error) {
            console.log('[err] '+error);
        }
        return;
    }

});


async function run() {
    
    await vk.updates.start().catch(console.error);
}

run();
