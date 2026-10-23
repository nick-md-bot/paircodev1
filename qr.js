const fs = require('fs');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
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
const MAX_ATTEMPTS = 8;
const LIFETIME_MS = 5 * 60 * 1000;
const logger = pino({ level: 'silent' });

function removeDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

router.get('/', (req, res) => {
    const id = makeid(8);
    const dir = path.join(TEMP_DIR, id);
    fs.mkdirSync(dir, { recursive: true });

    let finished = false;
    let attempts = 0;
    let gen = 0;
    let current = null;
    let qrSent = false;

    const cleanup = () => {
        finished = true;
        try { current && current.end(undefined); } catch (_) {}
        removeDir(dir);
    };

    const fail = () => {
        if (!res.headersSent) res.status(503).json({ code: 'Service Unavailable' });
        cleanup();
    };

    const lifetime = setTimeout(() => { if (!finished) fail(); }, LIFETIME_MS);

    const retry = (ms) => {
        if (finished) return;
        gen++;
        setTimeout(start, ms);
    };

    async function start() {
        if (finished) return;
        if (++attempts > MAX_ATTEMPTS) return fail();

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
                browser: Browsers.macOS('Desktop'),
            });
            current = sock;

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async (u) => {
                if (stale()) return;
                const { connection, lastDisconnect, qr } = u;

                if (qr && !qrSent && !res.headersSent) {
                    qrSent = true;
                    try {
                        const png = await QRCode.toBuffer(qr);
                        res.setHeader('Content-Type', 'image/png');
                        res.end(png);
                    } catch (err) {
                        console.log('qr render error:', err.message);
                        fail();
                    }
                }

                if (connection === 'open') {
                    finished = true;
                    try {
                        await delay(5000);
                        const json = await fs.promises.readFile(path.join(dir, 'creds.json'), 'utf-8');
                        const { id: key } = await create(json);
                        await sock.sendMessage(sock.user.id, { text: 'bot~' + key });
                    } catch (err) {
                        console.log('post-scan error:', err.message);
                    } finally {
                        clearTimeout(lifetime);
                        try { sock.end(undefined); } catch (_) {}
                        removeDir(dir);
                    }
                    return;
                }

                if (connection === 'close') {
                    const status = lastDisconnect?.error?.output?.statusCode;
                    if (status === DisconnectReason.loggedOut || status === 401) return fail();
                    retry(status === DisconnectReason.restartRequired ? 500 : 5000);
                }
            });
        } catch (err) {
            console.log('qr service error:', err && (err.stack || err.message));
            retry(5000);
        }
    }

    start();
});

module.exports = router;
