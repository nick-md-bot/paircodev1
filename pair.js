const fs = require('fs');
const path = require('path');
const express = require('express');
const pino = require('pino');
const { makeid } = require('./id');
const { create } = require('./session');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    Browsers,
    DisconnectReason,
    makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

const router = express.Router();
const TEMP_DIR = path.join(__dirname, 'temp');
const MAX_ATTEMPTS = 8;          // reconnect attempts before giving up
const LIFETIME_MS = 5 * 60 * 1000; // hard cap for a whole pairing session
const logger = pino({ level: 'silent' });

function removeDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

router.get('/', (req, res) => {
    const number = String(req.query.number || '').replace(/\D/g, '');
    if (number.length < 8 || number.length > 15) {
        return res.status(400).json({ code: 'Invalid number. Use country code and digits only.' });
    }

    const id = makeid(8);
    const dir = path.join(TEMP_DIR, id);
    fs.mkdirSync(dir, { recursive: true });

    let finished = false;
    let attempts = 0;
    let gen = 0;          // identifies the current socket; older sockets are ignored
    let current = null;

    const respond = (status, payload) => {
        if (!res.headersSent) res.status(status).json(payload);
    };

    const cleanup = () => {
        finished = true;
        try { current && current.end(undefined); } catch (_) {}
        removeDir(dir);
    };

    const fail = (message) => {
        respond(503, { code: message });
        cleanup();
    };

    const lifetime = setTimeout(() => {
        if (!finished) {
            console.log('pair: session timed out', id);
            fail('Service Unavailable');
        }
    }, LIFETIME_MS);

    const retry = (ms) => {
        if (finished) return;
        gen++; // invalidate the socket we are leaving
        setTimeout(start, ms);
    };

    async function start() {
        if (finished) return;
        if (++attempts > MAX_ATTEMPTS) return fail('Service Unavailable');

        const myGen = ++gen;
        const stale = () => finished || myGen !== gen;

        try {
            const { state, saveCreds } = await useMultiFileAuthState(dir);

            const sock = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, logger),
                },
                logger,
                printQRInTerminal: false,
                browser: Browsers.macOS('Safari'),
            });
            current = sock;

            sock.ev.on('creds.update', saveCreds);

            // Request the pairing code only once the socket is up and the
            // account is not registered yet. Retry if WhatsApp drops us first.
            const askCode = async () => {
                if (stale() || sock.authState.creds.registered) return;
                try {
                    const code = await sock.requestPairingCode(number);
                    attempts = 0; // got a code: reset the reconnect budget
                    respond(200, { code });
                } catch (err) {
                    console.log('requestPairingCode failed:', err.message);
                    if (!stale()) retry(3000);
                }
            };
            setTimeout(() => { if (!stale()) askCode(); }, 3000);

            sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
                if (stale()) return;

                if (connection === 'open') {
                    finished = true;
                    try {
                        await delay(3000);
                        const json = await fs.promises.readFile(path.join(dir, 'creds.json'), 'utf-8');
                        const { id: key } = await create(json);
                        await sock.sendMessage(sock.user.id, { text: 'bot~' + key });
                    } catch (err) {
                        console.log('post-pair error:', err.message);
                    } finally {
                        clearTimeout(lifetime);
                        try { sock.end(undefined); } catch (_) {}
                        removeDir(dir);
                    }
                    return;
                }

                if (connection === 'close') {
                    const status = lastDisconnect?.error?.output?.statusCode;
                    console.log('pair: closed with status', status);
                    if (status === DisconnectReason.loggedOut || status === 401) {
                        return fail('Session rejected by WhatsApp. Try again.');
                    }
                    // 515 (restart required) is normal right after pairing; reconnect with saved creds.
                    retry(status === DisconnectReason.restartRequired ? 500 : 5000);
                }
            });
        } catch (err) {
            console.log('pair error:', err && (err.stack || err.message));
            retry(5000);
        }
    }

    start();
});

module.exports = router;
