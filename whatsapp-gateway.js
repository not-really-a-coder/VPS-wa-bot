const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const yaml = require('js-yaml');
const auth = require('http-auth');
const authConnect = require('http-auth-connect');dotenv.config();

const app = express();
app.use(express.json());

// Load Config from config.yaml dynamically
let config = {};
let listenChats = new Set();

function loadConfig() {
    try {
        const fileContents = fs.readFileSync('./config.yaml', 'utf8');
        config = yaml.load(fileContents);
        
        let newListenChats = new Set();
        if (config && config.routes) {
            config.routes.forEach(route => {
                if (route.listen_chats) {
                    route.listen_chats.forEach(chatId => newListenChats.add(chatId.trim()));
                }
            });
        }
        listenChats = newListenChats;
        console.log('Successfully loaded config.yaml. Actively listening to chats:', Array.from(listenChats));
    } catch (e) {
        console.error('Failed to load config.yaml:', e);
    }
}

// Initial load
loadConfig();

// Watch for changes and hot-reload using native events instead of polling
fs.watch('./config.yaml', (eventType, filename) => {
    if (filename) {
        console.log(`config.yaml changed (${eventType}). Reloading...`);
        loadConfig();
    }
});

// Initialize SQLite Database
const db = new sqlite3.Database('./messages.db', (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id TEXT UNIQUE,
                chat_id TEXT,
                chat_name TEXT,
                sender TEXT,
                body TEXT,
                timestamp INTEGER,
                status TEXT DEFAULT 'pending',
                media_path TEXT
            )`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id)`);
            db.run(`CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY,
                owner TEXT,
                type TEXT,
                name TEXT,
                last_updated INTEGER
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS status_meta (
                key TEXT PRIMARY KEY,
                value TEXT
            )`);
        });
        console.log('Database connected and tables ready.');
    }
});

const chatUpdateCache = new Map();

// Helper to update chat dictionary
function updateChatDict(chatId, chatName) {
    const now = Math.floor(Date.now() / 1000);
    const cached = chatUpdateCache.get(chatId);
    
    // Only update DB if the name changed, or if it hasn't been updated in 5 minutes (300 seconds)
    if (cached && cached.name === chatName && (now - cached.lastUpdated < 300)) {
        return;
    }
    
    chatUpdateCache.set(chatId, { name: chatName, lastUpdated: now });
    
    const owner = client.info && client.info.pushname ? client.info.pushname : 'Me';
    const type = chatId.endsWith('@g.us') ? 'Group' : chatId.endsWith('@c.us') ? 'Contact' : 'Other';
    db.run(
        `INSERT INTO chats (id, owner, type, name, last_updated) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, last_updated=excluded.last_updated`,
        [chatId, owner, type, chatName, now]
    );
}

function updateLastSync() {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    db.run(
        `INSERT INTO status_meta (key, value) VALUES ('last_sync', ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        [now]
    );
}

function saveMessage(messageId, chatId, chatName, sender, body, timestamp, mediaPath = null) {
    if (!messageId || !chatId) return;
    db.serialize(() => {
        db.run(
            `INSERT OR IGNORE INTO messages (message_id, chat_id, chat_name, sender, body, timestamp, media_path) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [messageId, chatId, chatName, sender, body, timestamp, mediaPath],
            function(err) {
                if (err) {
                    console.error('[DB ERROR] saving message:', err.message);
                } else if (this.changes > 0) {
                    updateLastSync();
                }
            }
        );
    });
}

const puppeteerOptions = {
    args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage',
        '--disable-gpu'
    ], // Required for Docker environments
    protocolTimeout: 120000
};
if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    puppeteerOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: puppeteerOptions
});

let latestQR = null;

client.on('qr', (qr) => {
    latestQR = qr;
    // Generate and scan this code with your phone
    qrcode.generate(qr, { small: true });
    console.log('Scan the QR code above or open /qr in your browser to authenticate.');
});

client.on('loading_screen', (percent, message) => {
    console.log(`[LOADING] ${percent}% - ${message}`);
});

client.on('authenticated', () => {
    latestQR = null;
    console.log('Client Authenticated!');
});

client.on('auth_failure', msg => {
    console.error('AUTHENTICATION FAILURE', msg);
});

client.on('ready', async () => {
    latestQR = null;
    console.log('Client is ready! WhatsApp is connected.');
    
    setTimeout(async () => {
        try {
            console.log('Auto-fetching historical messages natively for whitelisted chats...');
            await fetchHistoryForListenChats(200);
        } catch (err) {
            console.error('Error in auto history fetch:', err);
        }
    }, 10000);
});

// Endpoint to serve latest QR code as JSON for Web UI and HTML for browser
app.get('/api/qr', (req, res) => {
    const isAuth = Boolean(client && client.info && client.info.wid);
    if (isAuth) {
        return res.json({ authenticated: true, qr: null, qr_image_url: null });
    }
    const qrImageUrl = latestQR ? `https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(latestQR)}` : null;
    res.json({
        authenticated: false,
        qr: latestQR,
        qr_image_url: qrImageUrl
    });
});

app.get(['/qr', '/api/qr.html'], (req, res) => {
    if (!latestQR) {
        return res.send(`
            <!DOCTYPE html>
            <html>
                <head>
                    <title>WhatsApp Web Authentication</title>
                    <meta http-equiv="refresh" content="5">
                    <style>
                        body { display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; font-family: system-ui, sans-serif; background: #0b141a; color: #e9edef; margin: 0; }
                        .card { background: #111b21; padding: 30px; border-radius: 12px; text-align: center; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h2>WhatsApp Status</h2>
                        <p style="color: #00a884; font-weight: bold;">WhatsApp is connected or initializing...</p>
                        <p style="color: #8696a0; font-size: 14px;">This page refreshes automatically.</p>
                    </div>
                </body>
            </html>
        `);
    }
    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(latestQR)}`;
    res.send(`
        <!DOCTYPE html>
        <html>
            <head>
                <title>Scan WhatsApp QR Code</title>
                <meta http-equiv="refresh" content="8">
                <style>
                    body { display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; font-family: system-ui, sans-serif; background: #0b141a; color: #e9edef; margin: 0; }
                    .card { background: #111b21; padding: 30px; border-radius: 12px; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.6); }
                    img { border-radius: 8px; background: white; padding: 12px; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h2 style="margin-top:0;">Scan with WhatsApp</h2>
                    <img src="${qrImageUrl}" alt="WhatsApp QR Code" width="350" height="350" />
                    <p style="color: #8696a0; margin-bottom:0; font-size: 14px;">Open WhatsApp > Linked Devices > Link a Device.<br>Refreshes automatically every 8s.</p>
                </div>
            </body>
        </html>
    `);
});

client.on('message_create', async msg => {
    const chatId = msg.fromMe ? msg.to : msg.from;
    
    // Apply Chat Filter early using O(1) Set lookup to prevent unnecessary Puppeteer overhead
    if (listenChats.size > 0 && !listenChats.has(chatId)) {
        return;
    }

    let chatName = chatId;
    try {
        // Wrap getChat in a timeout to prevent hanging the message event loop
        const chat = await Promise.race([
            msg.getChat(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout getting chat')), 5000))
        ]);
        chatName = chat.name || chat.id._serialized;
        console.log(`[DEBUG] Received message in chat: "${chatName}" (ID: ${chatId})`);
    } catch (err) {
        console.log(`[DEBUG] Received message from ID: ${chatId} (getChat failed/timed out)`);
    }
    
    // Update chat dictionary
    updateChatDict(chatId, chatName);
    
    console.log(`Received message in whitelisted chat: ${chatName}`);
    if (msg.type === 'unknown' || msg.type === 'gp2' || msg.type === 'notification') return;
    if (msg.type === 'video' && !msg.body) return; // Skip media without captions
    let body = msg.body;
    let mediaPath = null;
        
    if (msg.type === 'sticker' || msg.type === 'image') {
        if (msg.type === 'image' && (!body || body.trim() === '')) body = '[Image]';
        
        const now = Math.floor(Date.now() / 1000);
        if (now - msg.timestamp > 600) {
            console.log(`[DEBUG] Skipping media download for old message from ${msg.timestamp}`);
        } else {
            try {
                const media = await msg.downloadMedia();
                if (media) {
                    const fileId = crypto.randomUUID();
                    const basePath = '/app/media/';
                    const joinedPath = path.join(basePath, fileId);
                    const fullPath = path.normalize(joinedPath);
                    
                    if (!fullPath.startsWith(basePath)) {
                        console.log('Security Error: Invalid path specified!');
                        body = msg.type === 'sticker' ? '[Sticker]' : body;
                        mediaPath = null;
                    } else {
                        fs.writeFileSync(fullPath, media.data, {encoding: 'base64'});
                        if (msg.type === 'sticker') body = '[Sticker Image]';
                        mediaPath = fullPath;
                    }
                } else {
                    if (msg.type === 'sticker') body = '[Sticker]';
                }
            } catch (e) {
                console.log(`Failed to download ${msg.type} media:`, e);
                if (msg.type === 'sticker') body = '[Sticker]';
            }
        }
    }
    if (!body || body.trim() === '') return; // Skip empty messages
        
    // For groups, msg.author contains the actual sender ID, msg.from is the group ID
    const sender = msg.author || msg.from; 
    saveMessage(msg.id._serialized, chatId, chatName, sender, body, msg.timestamp, mediaPath);
});

client.initialize();

function recordLastSummary(routeId) {
    if (!routeId) return;
    const data = JSON.stringify({ route_id: routeId, timestamp: Math.floor(Date.now() / 1000) });
    db.run(`INSERT INTO status_meta (key, value) VALUES ('last_summary', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [data]);
}

// Express server for sending messages
app.post('/send', async (req, res) => { console.log('Hit /send route for', req.body.chatId);
    let { chatId, text, routeId } = req.body;
    
    if (!chatId || !text) {
        return res.status(400).json({ error: 'chatId and text are required' });
    }

    if (chatId === 'me') {
        chatId = client.info.wid._serialized;
    }
    
    try {
        await Promise.race([
            client.sendMessage(chatId, text, { linkPreview: false }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout sending message')), 60000))
        ]);
        console.log(`Successfully sent summary to ${chatId}`);
        if (routeId) {
            recordLastSummary(routeId);
        }
        res.json({ success: true });
    } catch (error) {
        console.error(`Error in /send to ${chatId}:`, error);
        res.status(500).json({ error: error.toString() });
    }
});

app.post('/restart', (req, res) => {
    console.log('Received /restart request. Exiting process to let Docker restart it...');
    res.json({ success: true, message: 'Restarting...' });
    setTimeout(() => {
        db.close(() => {
            process.exit(1);
        });
    }, 1000);
});

// Basic Auth setup
const basicAuth = auth.basic({
    realm: "Summary Bot Web UI",
    file: "/app/.htpasswd"
});
const basicAuthMiddleware = authConnect(basicAuth);

// Web UI and API routes

app.get('/api/config', basicAuthMiddleware, (req, res) => {
    try {
        const fileContents = fs.readFileSync('./config.yaml', 'utf8');
        const currentConfig = yaml.load(fileContents);
        res.json(currentConfig);
    } catch (e) {
        res.status(500).json({ error: e.toString() });
    }
});

app.post('/api/config', basicAuthMiddleware, (req, res) => {
    try {
        const newConfig = req.body;
        if (!newConfig || !newConfig.prompts || !newConfig.routes) {
            return res.status(400).json({ error: 'Invalid config format' });
        }

        // Automatically strip trailing spaces from prompt templates to prevent YAML parsing issues
        if (newConfig.prompts) {
            for (const [key, promptObj] of Object.entries(newConfig.prompts)) {
                if (promptObj && typeof promptObj.text === 'string') {
                    promptObj.text = promptObj.text.split('\n').map(line => line.trimEnd()).join('\n');
                } else if (typeof promptObj === 'string') {
                    newConfig.prompts[key] = { 
                        text: promptObj.split('\n').map(line => line.trimEnd()).join('\n'), 
                        model: 'gemini-3.1-flash-lite', 
                        temperature: 0.7 
                    };
                }
            }
        }

        const yamlStr = yaml.dump(newConfig, { lineWidth: -1 });
        fs.writeFileSync('./config.yaml', yamlStr, 'utf8');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.toString() });
    }
});

app.get('/api/chats', basicAuthMiddleware, (req, res) => {
    db.all(`SELECT * FROM chats ORDER BY type DESC, name ASC`, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.toString() });
        }
        res.json(rows);
    });
});

app.get('/api/test_route_stream', basicAuthMiddleware, (req, res) => {
    const { route_id, time_range } = req.query;
    if (!route_id) return res.status(400).end();
    
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    
    const args = ['summary_bot.py', '--run-now', route_id];
    if (time_range) args.push(time_range);
    args.push('--dry-run');

    const child = spawn('python3', args);
    
    child.stdout.on('data', data => res.write(data));
    child.stderr.on('data', data => res.write(data));
    
    child.on('close', code => {
        res.write(`\n[Process exited with code ${code}]\n`);
        res.end();
    });
});

app.post('/api/send_route_summary', basicAuthMiddleware, async (req, res) => {
    const { route_id, summary_text } = req.body;
    console.log("Hit /api/send_route_summary with route_id:", route_id, "summary_text length:", summary_text?.length);
    if (!route_id || !summary_text) return res.status(400).json({error: "Missing params"});
    
    try {
        const fileContents = fs.readFileSync('./config.yaml', 'utf8');
        const currentConfig = yaml.load(fileContents);
        const route = currentConfig.routes?.find(r => r.id === route_id);
        console.log("Found route:", route?.id, "target_chats:", route?.target_chats);
        if (!route || !route.target_chats) return res.status(404).json({error: "Route or targets not found"});
        
        for (let target of route.target_chats) {
            if (target === 'me') {
                target = client.info.wid._serialized;
            }
            await Promise.race([
                client.sendMessage(target, summary_text, { linkPreview: false }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout sending message')), 60000))
            ]);
            console.log(`Successfully sent summary to ${target}`);
        }
        recordLastSummary(route_id);
        res.json({ success: true });
    } catch (e) {
        console.error(`Error in /api/send_route_summary:`, e);
        res.status(500).json({ error: e.toString() });
    }
});

app.get('/api/status', (req, res) => {
    const isAuth = Boolean(client && client.info && client.info.wid);

    db.get(`SELECT MAX(timestamp) as last_sync FROM messages`, [], (err, syncRow) => {
        const lastSyncTs = syncRow ? syncRow.last_sync : null;

        db.get(`SELECT value FROM status_meta WHERE key = 'last_summary'`, [], (err2, summaryRow) => {
            let lastSummary = null;
            if (summaryRow && summaryRow.value) {
                try { lastSummary = JSON.parse(summaryRow.value); } catch(e) {}
            }
            res.json({
                authenticated: isAuth,
                last_sync: lastSyncTs,
                last_summary: lastSummary
            });
        });
    });
});


async function fetchHistoryForListenChats(limit = 100, targetChatIds = null) {
    let totalSaved = 0;
    if (!client || !client.pupPage) {
        console.log('[DEBUG] client not ready for history fetch');
        return 0;
    }

    const chatsToFetch = targetChatIds ? Array.from(targetChatIds) : Array.from(listenChats);
    console.log(`[SYNC] Starting history fetch for ${chatsToFetch.length} chats...`);

    try {
        const sevenDaysAgo = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60);
        const fetchedData = await Promise.race([
            client.pupPage.evaluate(async (chatIds, minTimestamp, maxLimit) => {
                const coll = window.require ? window.require('WAWebCollections') : null;
                const loader = window.require ? window.require('WAWebChatLoadMessages') : null;
                if (!coll || !coll.Chat) return [];

                const res = [];
                for (const id of chatIds) {
                    try {
                        const chat = coll.Chat.get(id);
                        if (!chat) continue;
                        const name = chat.name || chat.formattedTitle || id;

                        // Iteratively load earlier messages until we reach minTimestamp or no more messages
                        if (loader && loader.loadEarlierMsgs) {
                            let attempts = 0;
                            while (attempts < 15) {
                                const rawMsgs = chat.msgs ? chat.msgs.getModelsArray() : [];
                                const earliest = rawMsgs.length ? (rawMsgs[0].t || rawMsgs[0].timestamp || 0) : 0;
                                if (earliest > 0 && earliest <= minTimestamp) {
                                    break;
                                }
                                try {
                                    const loaded = await loader.loadEarlierMsgs({ chat });
                                    if (!loaded || !loaded.length) break;
                                } catch(e) {
                                    break;
                                }
                                attempts++;
                            }
                        }

                        const rawMsgs = chat.msgs ? chat.msgs.getModelsArray() : [];
                        const cleanMsgs = rawMsgs
                            .filter(m => (m.t || m.timestamp || 0) >= minTimestamp)
                            .slice(-maxLimit)
                            .map(m => {
                                try {
                                    let rawId = m.id ? (m.id._serialized || m.id.toString()) : null;
                                    if (typeof rawId === 'object') {
                                        try { rawId = JSON.stringify(rawId); } catch(e) { rawId = null; }
                                    }
                                    const sender = m.author ? (m.author._serialized || m.author) : (m.from ? (m.from._serialized || m.from) : '');
                                    const ts = m.t || m.timestamp || Math.floor(Date.now() / 1000);
                                    if (!rawId) {
                                        rawId = `${id}_${ts}_${sender}_${(m.body || '').substring(0, 15)}`;
                                    }
                                    let rawBody = m.caption || m.text || m.body || '';
                                    let thumbnail = (m.type === 'image' || m.type === 'sticker') && m.body && m.body.startsWith('/9j/') ? m.body : null;
                                    return {
                                        id: String(rawId),
                                        body: rawBody,
                                        type: m.type || 'chat',
                                        timestamp: ts,
                                        author: sender,
                                        from: m.from ? (m.from._serialized || m.from) : null,
                                        thumbnail: thumbnail
                                    };
                                } catch(err) {
                                    return null;
                                }
                            }).filter(Boolean);

                        res.push({ id, name, msgs: cleanMsgs });
                    } catch(err) {}
                }
                return res;
            }, chatsToFetch, sevenDaysAgo, limit),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Batch fetch timeout')), 60000))
        ]);

        for (const item of fetchedData) {
            updateChatDict(item.id, item.name);
            let savedCount = 0;
            for (const m of item.msgs) {
                if (m.type === 'unknown' || m.type === 'gp2' || m.type === 'notification') continue;
                const sender = m.author || m.from;
                let body = m.body;
                if (m.type === 'image' && (!body || body.trim() === '')) body = '[Image]';
                if (m.type === 'sticker') body = '[Sticker]';

                let mediaPath = null;
                if (m.thumbnail) {
                    try {
                        const fileId = crypto.randomUUID() + '.jpg';
                        const basePath = '/app/media/';
                        const joinedPath = path.join(basePath, fileId);
                        const fullPath = path.normalize(joinedPath);
                        if (fullPath.startsWith(basePath)) {
                            fs.writeFileSync(fullPath, m.thumbnail, { encoding: 'base64' });
                            mediaPath = fullPath;
                        }
                    } catch(e) {}
                }

                saveMessage(m.id, item.id, item.name, sender, body, m.timestamp, mediaPath);
                savedCount++;
                totalSaved++;
            }
            if (savedCount > 0) {
                console.log(`[SYNC] Saved ${savedCount} messages for "${item.name}"`);
            }
        }
    } catch (err) {
        console.error('[SYNC] Error during batch history fetch:', err.message || err);
    }
    updateLastSync();
    console.log(`[SYNC] Finished native history fetch. Total messages processed/saved: ${totalSaved}`);
    return totalSaved;
}

app.get('/test_sync/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const info = await client.pupPage.evaluate(async (chatId) => {
            const chat = await window.WWebJS.getChat(chatId);
            if (!chat) return { error: "Chat not found" };

            let attempts = {};

            // Method 1: openChatAt
            if (window.Store && window.Store.Cmd && window.Store.Cmd.openChatAt) {
                try {
                    window.Store.Cmd.openChatAt(chat);
                    attempts.openChatAt = true;
                } catch(e) { attempts.openChatAt = e.toString(); }
            }

            // Method 2: loadEarlierMsgs
            try {
                if (chat.loadEarlierMsgs) {
                    await chat.loadEarlierMsgs();
                    attempts.loadEarlierMsgs = true;
                }
            } catch(e) { attempts.loadEarlierMsgs = e.toString(); }

            // Method 3: ConversationMsgs.loadEarlierMsgs
            try {
                if (window.Store && window.Store.ConversationMsgs && window.Store.ConversationMsgs.loadEarlierMsgs) {
                    await window.Store.ConversationMsgs.loadEarlierMsgs(chat);
                    attempts.ConversationMsgs = true;
                }
            } catch(e) { attempts.ConversationMsgs = e.toString(); }

            // Method 4: fetchMessages
            try {
                if (chat.fetchMessages) {
                    const fetched = await chat.fetchMessages({ limit: 100 });
                    attempts.fetchMessagesCount = fetched ? fetched.length : 0;
                }
            } catch(e) { attempts.fetchMessagesErr = e.toString(); }

            const msgs = chat.msgs ? chat.msgs.getModelsArray() : [];
            const timestamps = msgs.map(m => m.timestamp).filter(Boolean);
            
            return {
                name: chat.name || chat.formattedTitle,
                totalMsgsInMemory: msgs.length,
                minTs: timestamps.length ? Math.min(...timestamps) : null,
                maxTs: timestamps.length ? Math.max(...timestamps) : null,
                attempts: attempts
            };
        }, id);
        res.json(info);
    } catch(e) {
        res.status(500).json({ error: e.toString() });
    }
});

app.get('/api/find_chat', async (req, res) => {
    try {
        const q = req.query.q || '';
        const data = await client.pupPage.evaluate((query) => {
            const coll = window.require ? window.require('WAWebCollections') : null;
            if (!coll || !coll.Chat) return { error: 'No coll' };
            const chats = [];
            const models = coll.Chat.getModelsArray ? coll.Chat.getModelsArray() : (coll.Chat.models || []);
            models.forEach(c => {
                const name = c.name || c.formattedTitle || '';
                chats.push({
                    id: c.id ? (c.id._serialized || c.id) : null,
                    name: name,
                    unreadCount: c.unreadCount || 0,
                    t: c.t || 0
                });
            });
            const matches = chats.filter(c => c.name.toLowerCase().includes(query.toLowerCase()));
            return { total: chats.length, matches };
        }, q);
        res.json(data);
    } catch(e) {
        res.status(500).json({ error: e.toString() });
    }
});

app.get('/api/search_text', async (req, res) => {
    try {
        const text = req.query.text || '';
        const data = await client.pupPage.evaluate((needle) => {
            const coll = window.require ? window.require('WAWebCollections') : null;
            if (!coll || !coll.Chat) return { error: 'No coll' };
            const results = [];
            const models = coll.Chat.getModelsArray ? coll.Chat.getModelsArray() : (coll.Chat.models || []);
            models.forEach(c => {
                const chatName = c.name || c.formattedTitle || '';
                const msgs = c.msgs ? c.msgs.getModelsArray() : [];
                msgs.forEach(m => {
                    const b = m.body || '';
                    if (b.includes(needle)) {
                        results.push({
                            chatId: c.id ? (c.id._serialized || c.id) : null,
                            chatName: chatName,
                            sender: m.author ? (m.author._serialized || m.author) : (m.from ? (m.from._serialized || m.from) : ''),
                            body: b,
                            t: m.t || m.timestamp,
                            dt: new Date((m.t || m.timestamp) * 1000).toISOString()
                        });
                    }
                });
            });
            return results;
        }, text);
        res.json(data);
    } catch(e) {
        res.status(500).json({ error: e.toString() });
    }
});

app.get('/api/debug_chat_load', async (req, res) => {
    try {
        const chatId = req.query.id || '120363143523847100@g.us';
        const result = await client.pupPage.evaluate(async (id) => {
            const coll = window.require ? window.require('WAWebCollections') : null;
            const loader = window.require ? window.require('WAWebChatLoadMessages') : null;
            if (!coll || !coll.Chat) return { error: 'No coll' };
            const chat = coll.Chat.get(id);
            if (!chat) return { error: 'Chat not found' };

            let attempts = [];
            for (let s = 0; s < 10; s++) {
                try {
                    const loaded = await loader.loadEarlierMsgs({ chat });
                    attempts.push({ step: s, count: loaded ? loaded.length : 0 });
                    if (!loaded || !loaded.length) break;
                } catch(err) {
                    attempts.push({ step: s, err: err.toString() });
                    break;
                }
            }

            const rawMsgs = chat.msgs ? chat.msgs.getModelsArray() : [];
            const targetMsg = rawMsgs.find(m => m.id && (m.id.id === '2A2ED157518B3CCDE4C7' || (m.id._serialized && m.id._serialized.includes('2A2ED157518B3CCDE4C7'))));
            let targetDump = null;
            if (targetMsg) {
                targetDump = {
                    type: targetMsg.type,
                    caption: targetMsg.caption,
                    text: targetMsg.text,
                    body: targetMsg.body,
                    description: targetMsg.description,
                    title: targetMsg.title,
                    matchedText: targetMsg.matchedText,
                    comment: targetMsg.comment,
                    keys: Object.keys(targetMsg)
                };
            }
            return {
                name: chat.name || chat.formattedTitle,
                attempts,
                targetDump,
                totalInMemory: rawMsgs.length,
                messages: rawMsgs.map(m => ({
                    id: m.id ? (m.id._serialized || m.id) : null,
                    t: m.t || m.timestamp,
                    dt: new Date((m.t || m.timestamp) * 1000).toISOString(),
                    caption: m.caption,
                    body: (m.caption || m.body || '').substring(0, 30)
                }))
            };
        }, chatId);
        res.json(result);
    } catch(e) {
        res.status(500).json({ error: e.toString() });
    }
});


// Endpoint for manual or programmatic historical fetch
app.post('/api/fetch_history', async (req, res) => {
    try {
        console.log('[API] /api/fetch_history triggered...');
        const limit = req.body?.limit ? parseInt(req.body.limit) : 100;
        const targetChatIds = req.body?.chat_ids ? new Set(req.body.chat_ids) : null;
        const saved = await fetchHistoryForListenChats(limit, targetChatIds);
        res.json({ success: true, saved: saved });
    } catch (e) {
        console.error('Error in /api/fetch_history:', e);
        res.status(500).json({ error: e.toString() });
    }
});

// Periodic background synchronization every 15 minutes (900000ms)
setInterval(async () => {
    if (client && client.info && client.info.wid) {
        console.log('[CRON] Running 15-min periodic history sync for whitelisted chats...');
        try {
            await fetchHistoryForListenChats(50);
        } catch (e) {
            console.error('[CRON] Periodic sync error:', e);
        }
    }
}, 15 * 60 * 1000);

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`Gateway API listening on port ${PORT}`);
});
// Graceful shutdown to prevent SQLite DB corruption
process.on('SIGINT', () => {
    console.log('Caught SIGINT. Closing database...');
    db.close((err) => {
        if (err) console.error('Error closing DB:', err.message);
        else console.log('Database closed successfully.');
        process.exit(0);
    });
});
process.on('SIGTERM', () => {
    console.log('Caught SIGTERM. Closing database...');
    db.close((err) => {
        if (err) console.error('Error closing DB:', err.message);
        else console.log('Database closed successfully.');
        process.exit(0);
    });
});
