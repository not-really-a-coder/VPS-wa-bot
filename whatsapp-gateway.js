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

// Helper function to save messages to DB
function saveMessage(messageId, chatId, chatName, sender, body, timestamp, mediaPath = null) {
    db.run(
        `INSERT OR IGNORE INTO messages (message_id, chat_id, chat_name, sender, body, timestamp, media_path) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [messageId, chatId, chatName, sender, body, timestamp, mediaPath],
        function(err) {
            if (err) console.error('Error saving message:', err.message);
            else if (this.changes > 0) console.log(`[+] Saved message from ${sender} in ${chatName}`);
        }
    );
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

client.on('qr', (qr) => {
    // Generate and scan this code with your phone
    qrcode.generate(qr, { small: true });
    console.log('Scan the QR code above to authenticate.');
});

client.on('loading_screen', (percent, message) => {
    console.log(`[LOADING] ${percent}% - ${message}`);
});

client.on('authenticated', () => {
    console.log('Client Authenticated!');
});

client.on('auth_failure', msg => {
    console.error('AUTHENTICATION FAILURE', msg);
});

client.on('ready', async () => {
    console.log('Client is ready! WhatsApp is connected.');
    
    try {
        const chats = await client.getChats();
        
        // TEMPORARY DEBUG: Print all groups and their IDs
        console.log('\n--- AVAILABLE CHATS ---');
        chats.forEach(c => {
            console.log(`[CHAT] "${c.name || c.id._serialized}" (ID: ${c.id._serialized})`);
            updateChatDict(c.id._serialized, c.name || c.id._serialized);
        });
        console.log('Fetching missed historical messages for whitelisted chats...');
        for (const c of chats) {
            if (listenChats.has(c.id._serialized)) {
                try {
                    const msgs = await c.fetchMessages({ limit: 100 });
                    let savedCount = 0;
                    msgs.forEach(msg => {
                        const now = Math.floor(Date.now() / 1000);
                        // Only save messages from the last 24 hours (86400 seconds)
                        if (now - msg.timestamp < 86400) {
                            if (msg.type === 'unknown' || msg.type === 'gp2' || msg.type === 'notification') return;
                            if (msg.type === 'video' && !msg.body) return;
                            
                            let body = msg.body;
                            if (msg.type === 'sticker') body = '[Sticker]';
                            if (msg.type === 'image' && (!body || body.trim() === '')) body = '[Image]';
                            if (body && body.trim() !== '') {
                                const sender = msg.author || msg.from;
                                saveMessage(msg.id._serialized, c.id._serialized, c.name || c.id._serialized, sender, body, msg.timestamp, null);
                                savedCount++;
                            }
                        }
                    });
                    console.log(`Fetched ${msgs.length} messages, saved ${savedCount} recent messages for ${c.name || c.id._serialized}`);
                } catch(e) {
                    console.error(`Error fetching history for ${c.id._serialized}:`, e);
                }
            }
        }
        console.log('Finished fetching historical messages.');
    } catch (err) {
        console.error('Error fetching historical messages:', err);
    }
});

client.on('message_create', async msg => {
    const chatId = msg.fromMe ? msg.to : msg.from;
    
    let chatName = chatId;
    try {
        const chat = await msg.getChat();
        chatName = chat.name || chat.id._serialized;
        console.log(`[DEBUG] Received message in chat: "${chatName}" (ID: ${chatId})`);
    } catch (err) {
        console.log(`[DEBUG] Received message from ID: ${chatId}`);
    }
    
    // Update chat dictionary
    updateChatDict(chatId, chatName);
    // Apply Chat Filter using O(1) Set lookup
    if (listenChats.size > 0 && !listenChats.has(chatId)) {
        return;
    }
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

// Express server for sending messages
app.post('/send', async (req, res) => {
    const { chatId, text } = req.body;
    
    if (!chatId || !text) {
        return res.status(400).json({ error: 'chatId and text are required' });
    }

    try {
        await client.sendMessage(chatId, text);
        console.log(`Sent summary to ${chatId}`);
        res.json({ success: true });
    } catch (error) {
        console.error(`Error sending message to ${chatId}:`, error);
        res.status(500).json({ error: error.toString() });
    }
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
    if (!route_id || !summary_text) return res.status(400).json({error: "Missing params"});
    
    try {
        const fileContents = fs.readFileSync('./config.yaml', 'utf8');
        const currentConfig = yaml.load(fileContents);
        const route = currentConfig.routes?.find(r => r.id === route_id);
        if (!route || !route.target_chats) return res.status(404).json({error: "Route or targets not found"});
        
        for (const target of route.target_chats) {
            await client.sendMessage(target, summary_text);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.toString() });
    }
});


app.post('/api/fetch_history', async (req, res) => {
    try {
        console.log('Manual historical fetch triggered...');
        const chats = await client.getChats();
        let totalSaved = 0;
        for (const c of chats) {
            if (listenChats.has(c.id._serialized)) {
                try {
                    const msgs = await c.fetchMessages({ limit: 100 });
                    msgs.forEach(msg => {
                        const now = Math.floor(Date.now() / 1000);
                        if (now - msg.timestamp < 86400) {
                            if (msg.type === 'unknown' || msg.type === 'gp2' || msg.type === 'notification') return;
                            if (msg.type === 'video' && !msg.body) return;
                            
                            let body = msg.body;
                            if (msg.type === 'sticker') body = '[Sticker]';
                            if (msg.type === 'image' && (!body || body.trim() === '')) body = '[Image]';
                            if (body && body.trim() !== '') {
                                const sender = msg.author || msg.from;
                                saveMessage(msg.id._serialized, c.id._serialized, c.name || c.id._serialized, sender, body, msg.timestamp, null);
                                totalSaved++;
                            }
                        }
                    });
                } catch(e) {
                    console.error(`Error fetching history for ${c.id._serialized}:`, e);
                }
            }
        }
        res.json({ success: true, saved: totalSaved });
    } catch (e) {
        res.status(500).json({ error: e.toString() });
    }
});

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
