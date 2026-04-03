require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const fs = require('fs');
const path = require('path');

// ─── Environment Variables ────────────────────────────────────────────────────
const apiId       = parseInt(process.env.API_ID);
const apiHash     = process.env.API_HASH;
const botToken    = process.env.BOT_TOKEN;
const targetBotId = process.env.TARGET_BOT_ID;
const adminIds    = process.env.ADMIN_ID ? process.env.ADMIN_ID.split(',').map(id => id.trim()) : [];

if (!apiId || !apiHash || !botToken || !targetBotId || adminIds.length === 0) {
    console.error('❌ CRITICAL: Missing required env vars.');
    console.error('   Required: API_ID, API_HASH, BOT_TOKEN, TARGET_BOT_ID, ADMIN_ID');
    process.exit(1);
}

// ─── .env path for live-patching SESSION_STRING ───────────────────────────────
const ENV_PATH = path.resolve(__dirname, '.env');

// ─── In-memory login state machine ───────────────────────────────────────────
// States: idle | awaiting_phone | awaiting_code | awaiting_2fa
let loginState = 'idle';
let pendingPhone      = null;
let pendingResolver   = null;   // resolves phoneCode promise
let pending2faResolver = null;  // resolves password promise
let tempClient        = null;   // TelegramClient used during login

// ─── Live userbot client ──────────────────────────────────────────────────────
let userbotClient = null;

// ─── Controller bot (receives /login command) ─────────────────────────────────
const bot = new TelegramBot(botToken, { polling: true });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(text) {
    if (!text) return '';
    return text.toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Patch SESSION_STRING= line in the .env file.
 * Replaces whatever is there (including a previous session) with the new one.
 */
function saveSessionToEnv(sessionString) {
    let content = fs.readFileSync(ENV_PATH, 'utf8');

    if (/^SESSION_STRING=.*/m.test(content)) {
        // Replace existing line
        content = content.replace(/^SESSION_STRING=.*/m, `SESSION_STRING=${sessionString}`);
    } else {
        // Append new line
        content += `\nSESSION_STRING=${sessionString}`;
    }

    fs.writeFileSync(ENV_PATH, content, 'utf8');
    console.log('✅ SESSION_STRING saved to .env');
}

/**
 * Read current SESSION_STRING from .env at runtime (not from process.env cache).
 */
function readSessionFromEnv() {
    const content = fs.readFileSync(ENV_PATH, 'utf8');
    const match = content.match(/^SESSION_STRING=(.*)$/m);
    return match ? match[1].trim() : '';
}

/**
 * Start listening with the userbot, replacing any previous listener.
 */
async function startUserbot(sessionString) {
    // Tear down old client if running
    if (userbotClient) {
        try { await userbotClient.disconnect(); } catch (_) {}
        userbotClient = null;
        console.log('🔄 Old userbot disconnected.');
    }

    const stringSession = new StringSession(sessionString);
    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
        useWSS: false,
    });

    // Start without interactive prompts — session already exists
    await client.connect();

    if (!await client.isUserAuthorized()) {
        console.warn('⚠️  Userbot session is invalid or expired. Please /login again.');
        return false;
    }

    userbotClient = client;
    console.log('✅ Userbot connected and listening for messages...');

    client.addEventHandler(async (event) => {
        try {
            const message = event.message;
            if (!message || !message.peerId) return;
            if (!message.isGroup && !message.isChannel) return;

            let senderIdStr = '';
            if (message.fromId) {
                senderIdStr = typeof message.fromId.userId !== 'undefined'
                    ? message.fromId.userId.toString()
                    : '';
            }

            if (!senderIdStr || senderIdStr !== targetBotId.toString()) return;

            console.log(`[EVENT] Message from target bot (msg ID: ${message.id})`);

            const chat = await message.getChat();
            let messageLink = 'https://t.me/';
            if (chat.username) {
                messageLink += `${chat.username}/${message.id}`;
            } else {
                messageLink += `c/${chat.id.toString()}/${message.id}`;
            }

            const messageText = message.message || '[Media or non-text message]';

            const notificationHtml = `
🚨 <b>Message received from monitored bot</b>

<b>Content:</b>
${escapeHtml(messageText)}

🔗 <a href="${messageLink}">Click here to view message</a>
            `.trim();

            // Send the compiled notification to all admins
            for (const adminId of adminIds) {
                try {
                    await bot.sendMessage(adminId, notificationHtml, {
                        parse_mode: 'HTML',
                        disable_web_page_preview: true,
                    });
                } catch (err) {
                    console.error(`❌ Failed to notify admin ${adminId}:`, err.message);
                }
            }

            console.log(`✅ Forwarded notification to admins for msg ${message.id}`);

        } catch (err) {
            console.error('❌ Error processing message:', err.message);
        }
    }, new NewMessage({}));

    return true;
}

// ─── Controller Bot Handlers ───────────────────────────────────────────────────

bot.onText(/\/login/, async (msg) => {
    const chatId = msg.chat.id.toString();

    // Security: only allow configured admins
    if (!adminIds.includes(chatId)) {
        console.warn(`[SECURITY] Unauthorized /login attempt from Chat ID: ${chatId}. Configured Admin IDs: ${adminIds.join(', ')}`);
        return; // Silent if not admin
    }

    if (loginState !== 'idle') {
        return bot.sendMessage(chatId, '⏳ A login is already in progress. Please complete it or restart the bot.');
    }

    loginState = 'awaiting_phone';
    bot.sendMessage(chatId, '📱 Please send your phone number in international format (e.g. +919876543210):');
});

// ─── /cancel command ─────────────────────────────────────────────────────────
bot.onText(/\/cancel/, async (msg) => {
    const chatId = msg.chat.id.toString();
    if (!adminIds.includes(chatId)) return; // Silent if not admin

    if (loginState === 'idle') {
        return bot.sendMessage(chatId, 'ℹ️ No active login session to cancel.');
    }

    // Abort the temp client
    if (tempClient) {
        try { await tempClient.disconnect(); } catch (_) {}
        tempClient = null;
    }
    loginState = 'idle';
    pendingPhone = null;
    pendingResolver = null;
    pending2faResolver = null;

    bot.sendMessage(chatId, '❌ Login cancelled.');
});

// ─── /status command ─────────────────────────────────────────────────────────
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id.toString();
    if (!adminIds.includes(chatId)) return; // Silent if not admin

    if (userbotClient && await userbotClient.isUserAuthorized()) {
        bot.sendMessage(chatId, '✅ Userbot is active and monitoring.');
    } else {
        bot.sendMessage(chatId, '❌ Userbot is NOT connected. Use /login to authenticate.');
    }
});

// ─── /start command ──────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id.toString();
    const videoPath = path.resolve(__dirname, 'start_video.MOV');
    
    // The message text you want to send along with the video
    const welcomeMessage = `
<b>System Migration Notice</b> 🚀

We have moved! Please use our official high-performance bot for all future exchanges:

👉 @bitvoraexc_bot

<i>This session is now deprecated. Thank you for choosing Bitvora.</i>
    `.trim(); 
    
    try {
        if (fs.existsSync(videoPath)) {
            // Sends the video with the text as a caption in a single message
            // Width/height supplied to force wide "original frame" display
            await bot.sendVideo(chatId, videoPath, {
                caption: welcomeMessage,
                parse_mode: 'HTML',
                width: 1920,
                height: 1080
            });
        } else {
            // Fallback to text-only if the video file doesn't exist yet
            await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'HTML' });
        }
    } catch (err) {
        console.error('❌ Error sending start message:', err.message);
        // Fallback in case sending the video fails
        await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'HTML' });
    }
});

// ─── Message handler (drives the login state machine) ────────────────────────
bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    if (!adminIds.includes(chatId)) return; // skip if not admin
    if (msg.text && msg.text.startsWith('/')) return; // skip commands

    const text = msg.text ? msg.text.trim() : '';

    // ── Step 1: Received phone number ─────────────────────────────────────────
    if (loginState === 'awaiting_phone') {
        pendingPhone = text;
        const myPhone = text; // local copy to avoid null issues during retries
        loginState = 'awaiting_code';

        bot.sendMessage(chatId, `📡 Sending OTP to <b>${escapeHtml(myPhone)}</b>... please wait.`, { parse_mode: 'HTML' });

        // Boot a fresh TelegramClient for login
        if (tempClient) {
            try { await tempClient.disconnect(); } catch (_) {}
        }
        tempClient = new TelegramClient(new StringSession(''), apiId, apiHash, {
            connectionRetries: 5,
            useWSS: false,
        });

        // Run the full login flow — resolvers are injected by later messages
        tempClient.start({
            phoneNumber: async () => myPhone,
            password: async () => {
                loginState = 'awaiting_2fa';
                bot.sendMessage(chatId, '🔐 Your account has 2FA enabled. Please send your password:');
                return new Promise((resolve) => { pending2faResolver = resolve; });
            },
            phoneCode: async () => {
                bot.sendMessage(chatId, '📨 OTP sent! Please enter the verification code you received:');
                return new Promise((resolve) => { pendingResolver = resolve; });
            },
            onError: async (err) => {
                console.error('Login error:', err.message);
                loginState = 'idle';
                tempClient = null;
                pendingPhone = null;
                pendingResolver = null;
                pending2faResolver = null;
                bot.sendMessage(chatId, `❌ Login failed: <code>${escapeHtml(err.message)}</code>\n\nTry /login again.`, { parse_mode: 'HTML' });
            },
        }).then(async () => {
            // ── Login succeeded ───────────────────────────────────────────────
            const newSession = tempClient.session.save();
            saveSessionToEnv(newSession);

            bot.sendMessage(chatId, '✅ <b>Login successful!</b> Session saved. Starting userbot...', { parse_mode: 'HTML' });

            // Reset state
            loginState = 'idle';
            pendingPhone = null;
            pendingResolver = null;
            pending2faResolver = null;

            // Start the userbot with the fresh session
            const ok = await startUserbot(newSession);
            if (ok) {
                bot.sendMessage(chatId, '🟢 Userbot is now live and monitoring target bot messages!');
            } else {
                bot.sendMessage(chatId, '⚠️ Session saved but userbot failed to start. Try restarting the bot.');
            }

        }).catch(async (err) => {
            console.error('Login chain error:', err.message);
            loginState = 'idle';
            tempClient = null;
            bot.sendMessage(chatId, `❌ Login error: <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' });
        });

        return;
    }

    // ── Step 2: Received OTP code ─────────────────────────────────────────────
    if (loginState === 'awaiting_code') {
        if (pendingResolver) {
            pendingResolver(text);
            pendingResolver = null;
        }
        return;
    }

    // ── Step 3: Received 2FA password ────────────────────────────────────────
    if (loginState === 'awaiting_2fa') {
        if (pending2faResolver) {
            pending2faResolver(text);
            pending2faResolver = null;
            loginState = 'awaiting_code'; // reset so next message doesn't re-trigger
        }
        return;
    }
});

// ─── Boot: auto-start userbot if session already exists ──────────────────────
(async () => {
    console.log('🤖 Controller bot started. Polling for commands...');

    const existingSession = readSessionFromEnv();
    if (existingSession) {
        console.log('🔄 Found existing session. Attempting to restore userbot...');
        try {
            const ok = await startUserbot(existingSession);
            if (!ok) {
                console.log('⚠️  Session invalid. Admins must /login again.');
                adminIds.forEach(adminId => {
                    bot.sendMessage(adminId, '⚠️ Existing session is <b>invalid or expired</b>. Please /login again.', { parse_mode: 'HTML' }).catch(() => {});
                });
            }
        } catch (err) {
            console.error('❌ Failed to restore session:', err.message);
            adminIds.forEach(adminId => {
                bot.sendMessage(adminId, `❌ Auto-login failed: <code>${escapeHtml(err.message)}</code>\n\nPlease /login manually.`, { parse_mode: 'HTML' }).catch(() => {});
            });
        }
    } else {
        console.log('ℹ️  No session found. Admin must /login to authenticate.');
        adminIds.forEach(adminId => {
            bot.sendMessage(adminId, '🛡️ <b>Bitvora System Monitoring Online</b>\n\nAdmin, use the <b>/login</b> command to sync your session.', { parse_mode: 'HTML' }).catch(() => {});
        });
    }
})();
