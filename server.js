const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, exec } = require('child_process');

const execAsync = (cmd, opts) => new Promise((resolve, reject) =>
    exec(cmd, opts, (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(stdout))
);

function ensureDep(name, pkg) {
    try { require.resolve(name); } catch {
        console.log(`Installing ${pkg || name}...`);
        execSync(`npm install ${pkg || name}`, { cwd: __dirname, stdio: 'inherit' });
    }
}
ensureDep('chokidar');
ensureDep('ws');
ensureDep('qrcode');

const chokidar = require('chokidar');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = parseInt(process.env.TW_PORT || '3747');
const HOST = process.env.TW_HOST || '127.0.0.1';
const DATA_DIR = path.join(os.homedir(), '.taskwatcher');
const DATA_FILE = path.join(DATA_DIR, 'tasks.json');
const WA_SETTINGS_FILE = path.join(DATA_DIR, 'wa_settings.json');
const MEET_SETTINGS_FILE = path.join(DATA_DIR, 'meet_settings.json');
const MEET_NOTES_FILE = path.join(DATA_DIR, 'meet_notes.json');
const HTML_FILE = path.join(__dirname, 'public', 'index.html');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Task storage ───────────────────────────────────────────
let tasks = [];
let watchers = {};

function loadTasks() {
    try { if (fs.existsSync(DATA_FILE)) tasks = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch { tasks = []; }
}

function saveTasks() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(tasks, null, 2));
}

// ── WhatsApp settings ──────────────────────────────────────
const DEFAULT_KEYWORDS = [
    'tolong', 'boleh tolong', 'please', 'can you', 'could you',
    'buat', 'hantar', 'check', 'verify', 'update', 'fix', 'tambah',
    'delete', 'todo:', 'task:', 'sediakan', 'perlu', 'kena',
    'need to', 'make sure', 'compile', 'prepare', 'send me', 'send the'
];

let waSettings = {
    autoCreate: true,
    keywords: DEFAULT_KEYWORDS,
    monitoredContacts: [],  // empty = all contacts
    monitorGroups: false,
    monitoredGroups: []     // empty = all groups (when monitorGroups is true)
};

function loadWaSettings() {
    try {
        if (fs.existsSync(WA_SETTINGS_FILE))
            waSettings = { ...waSettings, ...JSON.parse(fs.readFileSync(WA_SETTINGS_FILE, 'utf8')) };
    } catch {}
}

function saveWaSettings() {
    fs.writeFileSync(WA_SETTINGS_FILE, JSON.stringify(waSettings, null, 2));
}

loadWaSettings();

// ── Google Meet settings ───────────────────────────────────
let meetSettings = {
    userName: '',          // user's display name to detect in captions
    autoCreate: true,
    keywords: DEFAULT_KEYWORDS,
    requireNameMention: true   // only create tasks when name is in caption
};

let meetStatus = { inMeeting: false, title: '', url: '' };
const meetCaptionLog = []; // last 200 captions (live view)
let meetNotes = [];           // saved per-meeting transcripts
let currentMeetSession = null;

function loadMeetSettings() {
    try {
        if (fs.existsSync(MEET_SETTINGS_FILE))
            meetSettings = { ...meetSettings, ...JSON.parse(fs.readFileSync(MEET_SETTINGS_FILE, 'utf8')) };
    } catch {}
}

function saveMeetSettings() {
    fs.writeFileSync(MEET_SETTINGS_FILE, JSON.stringify(meetSettings, null, 2));
}

function loadMeetNotes() {
    try { if (fs.existsSync(MEET_NOTES_FILE)) meetNotes = JSON.parse(fs.readFileSync(MEET_NOTES_FILE, 'utf8')); }
    catch { meetNotes = []; }
}

function saveMeetNotes() {
    fs.writeFileSync(MEET_NOTES_FILE, JSON.stringify(meetNotes, null, 2));
}

function isMeetTaskCaption(text) {
    const lower = text.toLowerCase();
    const hasKeyword = meetSettings.keywords.some(k => lower.includes(k.toLowerCase()));
    if (!hasKeyword) return false;
    if (!meetSettings.requireNameMention || !meetSettings.userName) return true;
    return lower.includes(meetSettings.userName.toLowerCase());
}

loadMeetSettings();
loadMeetNotes();

// ── WhatsApp client ────────────────────────────────────────
let waClient = null;
let waStatus = 'disconnected'; // disconnected | initializing | qr | ready
let waQrDataUrl = null;
let waInfo = null;
const waMessageLog = []; // last 100 messages
let waUserDisconnected = false; // true only when user explicitly clicks Disconnect
let waReconnectTimer = null;

function isTaskMessage(text) {
    const lower = text.toLowerCase();
    return waSettings.keywords.some(k => lower.includes(k.toLowerCase()));
}

async function initWhatsApp() {
    if (waClient) return;
    waUserDisconnected = false;
    clearTimeout(waReconnectTimer);
    waStatus = 'initializing';
    broadcast({ type: 'wa_status', status: waStatus });

    // Lazy-install whatsapp-web.js (includes puppeteer + Chromium ~170MB, one-time)
    try { require.resolve('whatsapp-web.js'); } catch {
        console.log('\n  [WhatsApp] Installing whatsapp-web.js + Chromium (~170MB, one-time)...\n');
        broadcast({ type: 'wa_status', status: 'installing', text: 'Downloading WhatsApp client (~170MB)… this may take a few minutes.' });
        try {
            await execAsync('npm install whatsapp-web.js', { cwd: __dirname });
        } catch (installErr) {
            console.error('  [WhatsApp] Install failed:', installErr.message);
            waStatus = 'disconnected';
            waClient = null;
            broadcast({ type: 'wa_status', status: 'disconnected', error: 'Install failed: ' + installErr.message });
            return;
        }
    }

    // Yield to event loop once before loading the large module so WS/HTTP can flush
    await new Promise(r => setImmediate(r));

    const { Client, LocalAuth } = require('whatsapp-web.js');

    // Prefer a system browser over the (often missing) bundled Chromium
    const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const CHROME_64 = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const CHROME_32 = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
    const systemBrowser = [EDGE, CHROME_64, CHROME_32].find(p => fs.existsSync(p)) || null;

    waClient = new Client({
        authStrategy: new LocalAuth({ dataPath: path.join(DATA_DIR, 'wa_auth') }),
        puppeteer: {
            headless: true,
            ...(systemBrowser ? { executablePath: systemBrowser } : {}),
            args: [
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', '--disable-gpu',
                '--disable-extensions', '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'
            ]
        }
    });
    console.log(`  [WhatsApp] Using browser: ${systemBrowser || 'bundled Chromium'}`);

    waClient.on('qr', async (qr) => {
        waStatus = 'qr';
        waQrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
        broadcast({ type: 'wa_status', status: 'qr', qrDataUrl: waQrDataUrl });
        console.log('  [WhatsApp] QR code ready — scan with your phone.');
    });

    waClient.on('authenticated', () => {
        waStatus = 'initializing';
        waQrDataUrl = null;
        broadcast({ type: 'wa_status', status: 'initializing' });
        console.log('  [WhatsApp] Authenticated. Loading session...');
    });

    waClient.on('ready', () => {
        waStatus = 'ready';
        waInfo = { name: waClient.info.pushname, number: waClient.info.wid.user };
        broadcast({ type: 'wa_status', status: 'ready', info: waInfo });
        console.log(`  [WhatsApp] Connected as ${waInfo.name} (+${waInfo.number})`);
    });

    waClient.on('auth_failure', (msg) => {
        console.log('  [WhatsApp] Auth failure:', msg);
        waUserDisconnected = true; // don't auto-reconnect on bad credentials
        waStatus = 'disconnected';
        waInfo = null;
        waQrDataUrl = null;
        waClient = null;
        broadcast({ type: 'wa_status', status: 'disconnected' });
    });

    waClient.on('disconnected', (reason) => {
        console.log('  [WhatsApp] Disconnected:', reason);
        waStatus = 'disconnected';
        waInfo = null;
        waQrDataUrl = null;
        waClient = null;
        if (!waUserDisconnected) {
            console.log(`  [WhatsApp] Unexpected disconnect — reconnecting in 5s... (reason: ${reason})`);
            broadcast({ type: 'wa_status', status: 'reconnecting' });
            clearTimeout(waReconnectTimer);
            waReconnectTimer = setTimeout(() => {
                if (!waUserDisconnected) initWhatsApp();
            }, 5000);
        } else {
            broadcast({ type: 'wa_status', status: 'disconnected' });
        }
    });

    waClient.on('message', async (msg) => {
        if (msg.fromMe) return;

        const isGroup = msg.from.endsWith('@g.us');
        if (isGroup && !waSettings.monitorGroups) return;
        if (isGroup && waSettings.monitoredGroups.length > 0 && !waSettings.monitoredGroups.includes(msg.from)) return;

        let contact;
        try { contact = await msg.getContact(); } catch { contact = {}; }
        const sender = contact.pushname || contact.number || msg.from.replace('@c.us', '');
        const body = msg.body || '';

        // Filter by monitored contacts if set
        if (waSettings.monitoredContacts.length > 0) {
            const num = msg.from.replace('@c.us', '').replace('@g.us', '');
            if (!waSettings.monitoredContacts.some(c => c === num || c === sender)) return;
        }

        // Log message
        const logEntry = {
            id: Date.now().toString(),
            sender,
            body,
            isGroup,
            groupName: isGroup ? msg.from : null,
            time: new Date().toISOString(),
            isTask: isTaskMessage(body)
        };
        waMessageLog.unshift(logEntry);
        if (waMessageLog.length > 100) waMessageLog.pop();

        broadcast({ type: 'wa_message', message: logEntry });

        // Auto-create task
        if (waSettings.autoCreate && logEntry.isTask) {
            const shortName = body.length > 70 ? body.substring(0, 70) + '…' : body;
            const task = {
                id: Date.now().toString(),
                name: shortName,
                description: `From: ${sender}${isGroup ? ' (group)' : ''}\n\n${body}`,
                watchPath: '',
                watchType: 'folder',
                pattern: '*',
                status: 'pending',
                source: 'whatsapp',
                sourceContact: sender,
                createdAt: new Date().toISOString(),
                completedAt: null,
                lastChangedFile: null
            };
            tasks.unshift(task);
            saveTasks();
            broadcast({ type: 'task_from_wa', task, sender, preview: shortName });
            console.log(`  [WhatsApp] Task created from ${sender}: "${shortName}"`);
        }
    });

    try {
        await waClient.initialize();
    } catch (err) {
        console.error('  [WhatsApp] Init error:', err.message);
        waStatus = 'disconnected';
        waClient = null;
        broadcast({ type: 'wa_status', status: 'disconnected', error: err.message });
    }
}

async function destroyWhatsApp() {
    waUserDisconnected = true; // suppress auto-reconnect
    clearTimeout(waReconnectTimer);
    if (waClient) {
        try { await waClient.destroy(); } catch {}
        waClient = null;
    }
    waStatus = 'disconnected';
    waInfo = null;
    waQrDataUrl = null;
    broadcast({ type: 'wa_status', status: 'disconnected' });
}

// ── File watcher helpers ───────────────────────────────────
function broadcast(data) {
    const msg = JSON.stringify(data);
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function startWatcher(task) {
    if (watchers[task.id]) { watchers[task.id].close(); delete watchers[task.id]; }
    if (task.status !== 'watching' || !task.watchPath) return;
    if (!fs.existsSync(task.watchPath)) return;

    const patterns = (task.pattern || '*').split(',').map(p => p.trim()).filter(Boolean);
    const watchTarget = task.watchType === 'folder'
        ? path.join(task.watchPath, '**', '*')
        : task.watchPath;

    const watcher = chokidar.watch(watchTarget, {
        ignored: /(^|[\/\\])\../,
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
    });

    const handleChange = (filePath) => {
        const filename = path.basename(filePath);
        const matched = patterns.some(p => {
            if (p === '*') return true;
            const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
            return re.test(filename);
        });
        if (!matched) return;

        const t = tasks.find(x => x.id === task.id);
        if (!t || t.status !== 'watching') return;

        t.status = 'done';
        t.completedAt = new Date().toISOString();
        t.lastChangedFile = filePath;
        saveTasks();
        if (watchers[task.id]) { watchers[task.id].close(); delete watchers[task.id]; }
        broadcast({ type: 'task_done', task: t });
        console.log(`  [TaskWatcher] "${t.name}" done — ${filePath}`);
    };

    watcher.on('add', handleChange).on('change', handleChange).on('unlink', handleChange);
    watcher.on('error', err => console.error(`Watcher error:`, err));
    watchers[task.id] = watcher;
}

function stopWatcher(taskId) {
    if (watchers[taskId]) { watchers[taskId].close(); delete watchers[taskId]; }
}

// ── Startup ────────────────────────────────────────────────
loadTasks();
tasks.forEach(t => { if (t.status === 'watching') startWatcher(t); });

// ── HTTP server ────────────────────────────────────────────
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const json = (data, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', ...CORS_HEADERS }); res.end(JSON.stringify(data)); };
    const body = () => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b ? JSON.parse(b) : {})); });

    // CORS preflight
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); res.end(); return; }

    // HTML
    if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(fs.readFileSync(HTML_FILE, 'utf8'));
        return;
    }

    // Tasks
    if (req.method === 'GET' && url.pathname === '/api/tasks') { json(tasks); return; }

    if (req.method === 'POST' && url.pathname === '/api/tasks') {
        body().then(data => {
            const task = {
                id: Date.now().toString(),
                name: data.name,
                description: data.description || '',
                watchPath: data.watchPath || '',
                watchType: data.watchType || 'folder',
                pattern: data.pattern || '*',
                status: 'pending',
                createdAt: new Date().toISOString(),
                completedAt: null,
                lastChangedFile: null
            };
            tasks.unshift(task);
            saveTasks();
            json(task);
        });
        return;
    }

    if (req.method === 'PUT' && url.pathname.startsWith('/api/tasks/')) {
        const parts = url.pathname.split('/');
        const taskId = parts[3];
        const action = parts[4];
        body().then(data => {
            const task = tasks.find(t => t.id === taskId);
            if (!task) { json({ error: 'not found' }, 404); return; }
            if (action === 'watch') { task.status = 'watching'; task.completedAt = null; task.lastChangedFile = null; startWatcher(task); }
            else if (action === 'done') { task.status = 'done'; task.completedAt = new Date().toISOString(); stopWatcher(taskId); }
            else if (action === 'reset') { task.status = 'pending'; task.completedAt = null; task.lastChangedFile = null; stopWatcher(taskId); }
            else if (action === 'update') Object.assign(task, data);
            saveTasks();
            json(task);
        });
        return;
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/tasks/')) {
        const taskId = url.pathname.split('/')[3];
        stopWatcher(taskId);
        tasks = tasks.filter(t => t.id !== taskId);
        saveTasks();
        json({ ok: true });
        return;
    }

    // Browse
    if (req.method === 'POST' && url.pathname === '/api/browse') {
        body().then(({ dir }) => {
            try {
                const target = dir || os.homedir();
                const entries = fs.readdirSync(target, { withFileTypes: true })
                    .filter(e => { try { return e.isDirectory() || e.isFile(); } catch { return false; } })
                    .map(e => ({ name: e.name, isDir: e.isDirectory() }));
                json({ path: target, entries, parent: path.dirname(target) });
            } catch (e) { json({ error: e.message }, 400); }
        });
        return;
    }

    // WhatsApp API
    if (req.method === 'POST' && url.pathname === '/api/whatsapp/connect') {
        initWhatsApp();
        json({ ok: true, status: waStatus });
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/whatsapp/disconnect') {
        destroyWhatsApp().then(() => json({ ok: true }));
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/whatsapp/status') {
        json({ status: waStatus, info: waInfo, qrDataUrl: waQrDataUrl });
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/whatsapp/messages') {
        json(waMessageLog);
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/whatsapp/settings') {
        json(waSettings);
        return;
    }

    if (req.method === 'PUT' && url.pathname === '/api/whatsapp/settings') {
        body().then(data => {
            Object.assign(waSettings, data);
            saveWaSettings();
            json(waSettings);
        });
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/whatsapp/groups') {
        if (!waClient || waStatus !== 'ready') { json({ error: 'WhatsApp not connected' }, 400); return; }
        waClient.getChats().then(chats => {
            const groups = chats
                .filter(c => c.isGroup)
                .map(c => ({ id: c.id._serialized, name: c.name, memberCount: c.participants?.length || 0 }));
            json(groups);
        }).catch(err => json({ error: err.message }, 500));
        return;
    }

    // Google Meet API
    if (req.method === 'POST' && url.pathname === '/api/meet/status') {
        body().then(data => {
            meetStatus = { inMeeting: data.joined, title: data.title || '', url: data.url || '' };
            broadcast({ type: 'meet_status', meetStatus });
            console.log(`  [Meet] ${data.joined ? '🟢 Joined' : '🔴 Left'}: ${data.title}`);
            if (data.joined) {
                currentMeetSession = {
                    id: Date.now().toString(),
                    title: data.title || 'Untitled Meeting',
                    startTime: data.time || new Date().toISOString(),
                    endTime: null,
                    captions: []
                };
            } else if (currentMeetSession) {
                currentMeetSession.endTime = new Date().toISOString();
                if (currentMeetSession.captions.length > 0) {
                    meetNotes.unshift(currentMeetSession);
                    if (meetNotes.length > 50) meetNotes.pop();
                    saveMeetNotes();
                    const summary = {
                        id: currentMeetSession.id,
                        title: currentMeetSession.title,
                        startTime: currentMeetSession.startTime,
                        endTime: currentMeetSession.endTime,
                        captionCount: currentMeetSession.captions.length,
                        taskCount: currentMeetSession.captions.filter(c => c.isTask).length
                    };
                    broadcast({ type: 'meet_note_saved', note: summary });
                    console.log(`  [Meet] Note saved: "${currentMeetSession.title}" (${currentMeetSession.captions.length} captions)`);
                }
                currentMeetSession = null;
            }
            json({ ok: true });
        });
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/meet/caption') {
        body().then(data => {
            const captions = data.captions || [];
            for (const cap of captions) {
                const entry = {
                    id: Date.now().toString() + Math.random().toString(36).slice(2),
                    text: cap.text,
                    speaker: cap.speaker || 'Unknown',
                    time: cap.time || new Date().toISOString(),
                    isTask: isMeetTaskCaption(cap.text)
                };
                meetCaptionLog.unshift(entry);
                if (meetCaptionLog.length > 200) meetCaptionLog.pop();
                if (currentMeetSession) currentMeetSession.captions.push(entry);

                broadcast({ type: 'meet_caption', caption: entry });

                if (entry.isTask && meetSettings.autoCreate) {
                    const shortName = cap.text.length > 70 ? cap.text.substring(0, 70) + '…' : cap.text;
                    const task = {
                        id: Date.now().toString(),
                        name: shortName,
                        description: `From: Google Meet (${meetStatus.title || 'meeting'})\nSpeaker: ${entry.speaker}\n\n${cap.text}`,
                        watchPath: '', watchType: 'folder', pattern: '*',
                        status: 'pending', source: 'meet', sourceContact: entry.speaker,
                        createdAt: new Date().toISOString(), completedAt: null, lastChangedFile: null
                    };
                    tasks.unshift(task);
                    saveTasks();
                    broadcast({ type: 'task_from_meet', task, speaker: entry.speaker, preview: shortName });
                    console.log(`  [Meet] Task from ${entry.speaker}: "${shortName}"`);
                }
            }
            json({ ok: true });
        });
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/meet/status') {
        json({ meetStatus, captionCount: meetCaptionLog.length });
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/meet/captions') {
        json(meetCaptionLog.slice(0, 50));
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/meet/settings') {
        json(meetSettings);
        return;
    }

    if (req.method === 'PUT' && url.pathname === '/api/meet/settings') {
        body().then(data => {
            Object.assign(meetSettings, data);
            saveMeetSettings();
            json(meetSettings);
        });
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/meet/notes') {
        json(meetNotes.map(n => ({
            id: n.id, title: n.title, startTime: n.startTime, endTime: n.endTime,
            captionCount: n.captions.length,
            taskCount: n.captions.filter(c => c.isTask).length
        })));
        return;
    }

    if (req.method === 'GET' && /^\/api\/meet\/notes\/[^/]+$/.test(url.pathname)) {
        const id = url.pathname.split('/').pop();
        const note = meetNotes.find(n => n.id === id);
        if (!note) { json({ error: 'Not found' }, 404); return; }
        json(note);
        return;
    }

    if (req.method === 'DELETE' && /^\/api\/meet\/notes\/[^/]+$/.test(url.pathname)) {
        const id = url.pathname.split('/').pop();
        meetNotes = meetNotes.filter(n => n.id !== id);
        saveMeetNotes();
        json({ ok: true });
        return;
    }

    res.writeHead(404); res.end('Not found');
});

// ── WebSocket ──────────────────────────────────────────────
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'init', tasks, waStatus, waInfo, waQrDataUrl, waSettings, meetStatus, meetSettings }));
});

server.listen(PORT, HOST, () => {
    const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
    console.log(`\n  Task Watcher  →  ${url}  (binding: ${HOST}:${PORT})\n`);
    if (HOST !== '0.0.0.0') { try { require('child_process').exec(`start ${url}`); } catch {} }
});

process.on('SIGINT', async () => {
    Object.values(watchers).forEach(w => w.close());
    if (waClient) { try { await waClient.destroy(); } catch {} }
    process.exit(0);
});
