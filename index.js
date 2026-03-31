require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const input = require('input'); // For capturing login codes in terminal

// Ensure environment variables are loaded
const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const targetBotId = process.env.TARGET_BOT_ID;

// Use 'me' to forward to your own "Saved Messages", or use a username/chatID
const adminId = process.env.ADMIN_ID || 'me'; 
const sessionString = process.env.SESSION_STRING || '';

// Validate essentials (ignore SESSION_STRING on first run)
if (!apiId || !apiHash || !targetBotId) {
    console.error('CRITICAL ERROR: Missing API_ID, API_HASH, or TARGET_BOT_ID in .env file.');
    console.error('Create an app at https://my.telegram.org to get your API Credentials.');
    process.exit(1);
}

const stringSession = new StringSession(sessionString);

/**
 * Escape HTML to ensure there are no parser errors when sending formatted text
 */
function escapeHtml(text) {
    if (!text) return '';
    return text.toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

(async () => {
    console.log('Starting Telegram Userbot Client...');
    
    // Connect to Telegram MTProto API
    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
        useWSS: false,
    });

    // Handle interactive login process
    // If no SESSION_STRING is available, it will prompt you in the terminal
    await client.start({
        phoneNumber: async () => await input.text('Please enter your phone number (e.g. +123456789): '),
        password: async () => await input.text('Please enter your 2FA password (if you have one): '),
        phoneCode: async () => await input.text('Please enter the verification code you received: '),
        onError: (err) => console.log('Login Error:', err.message),
    });

    console.log('\n✅ Successfully connected to Telegram!');

    // First time login - save session string to avoid relogging
    if (!sessionString) {
        const generatedSession = client.session.save();
        console.log('\n======================================================');
        console.log('⚠️ IMPORTANT: Save this SESSION_STRING in your .env file!');
        console.log('SESSION_STRING=', generatedSession);
        console.log('======================================================\n');
    }

    console.log('Waiting for messages from target bot in groups...\n');

    // Setup event listener for new incoming messages
    client.addEventHandler(async (event) => {
        try {
            const message = event.message;

            // 1. Ignore if it's not a message with a valid sender
            if (!message || !message.peerId) return;

            // 2. Ignore private DMs (only listen to groups/supergroups/channels)
            if (!message.isGroup && !message.isChannel) return;

            // 3. Extract sender
            let senderIdStr = '';
            if (message.fromId) {
                // Determine ID structure for users or bots
                senderIdStr = typeof message.fromId.userId !== 'undefined'
                  ? message.fromId.userId.toString()
                  : '';
            }
            
            // 4. Validate the sender matches our TARGET_BOT_ID
            if (!senderIdStr || senderIdStr !== targetBotId.toString()) {
                return; 
            }

            console.log(`[EVENT] Detected message from target bot (Message ID: ${message.id})`);

            // 5. Structure the forwarded notification text
            const chat = await message.getChat();
            
            let messageLink = 'https://t.me/';
            if (chat.username) {
                // Public Group/Channel Format
                messageLink += `${chat.username}/${message.id}`;
            } else {
                // Private Group format: t.me/c/<chat_id>/<msg_id>
                messageLink += `c/${chat.id.toString()}/${message.id}`;
            }

            // Extract text or fallback gracefully
            const messageText = message.message || '[Media or non-text message]';

            const notificationHtml = `
🚨 <b>Message received from monitored bot</b>

<b>Content:</b>
${escapeHtml(messageText)}

🔗 <a href="${messageLink}">Click here to view message</a>
            `.trim();

            // 6. Send the compiled notification to the adminId
            await client.sendMessage(adminId, {
                message: notificationHtml,
                parseMode: 'html',
                linkPreview: false, // Prevents creating a big preview card from the link
            });

            console.log(`✅ Successfully forwarded notification to admin for msg ${message.id}`);

        } catch (error) {
            console.error('❌ Error processing incoming message event:', error.message);
        }
    }, new NewMessage({})); 
    
    // Process keeps running
})();
