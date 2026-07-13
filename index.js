const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { getAIResponse } = require('./ai');

const app = express();
const port = process.env.PORT || 3000;

let qrCodeData = null;
let connectionStatus = 'Disconnected';
let isReconnecting = false;

// Helper function to automatically wipe corrupted auth files
function clearSessionDirectory() {
  const dir = path.join(__dirname, 'auth_info_baileys');
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log('✓ Cleared corrupt/logged-out session directory successfully.');
    } catch (err) {
      console.error('Failed to clear session directory:', err);
    }
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
    // Emulates standard desktop Google Chrome to bypass instant rejections
    browser: ['Mac OS', 'Chrome', '10.1.10'] 
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrCodeData = qr;
      connectionStatus = 'Waiting for Scan';
    }
    
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log(`Connection closed with status code: ${reason || 'unknown'}`);

      // Clear the QR code so the page shows initializing state during reconnect
      qrCodeData = null; 

      // 1. If session is corrupt or logged out, wipe the directory to trigger fresh QR
      if (reason === DisconnectReason.badSession || reason === DisconnectReason.loggedOut) {
        console.log('Bad session or user logged out. Wiping credentials to reset...');
        clearSessionDirectory();
        connectionStatus = 'Logged Out (Resetting...)';
      } else {
        connectionStatus = 'Disconnected (Reconnecting...)';
      }

      // 2. Prevent rapid multi-connection spawn
      if (!isReconnecting) {
        isReconnecting = true;
        console.log('Reconnecting in 5 seconds to prevent rate-limiting...');
        
        setTimeout(() => {
          isReconnecting = false;
          startBot();
        }, 5000); // 5-second cooling period
      }

    } else if (connection === 'open') {
      console.log('Connected to WhatsApp successfully!');
      connectionStatus = 'Connected';
      qrCodeData = null;
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;

    // Do not respond in groups
    if (sender.endsWith('@g.us')) {
      console.log(`Group message ignored from: ${sender}`);
      return; 
    }

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

    if (text) {
      console.log(`DM from ${sender}: ${text}`);
      await sock.sendPresenceUpdate('composing', sender);
      const reply = await getAIResponse(text);
      await sock.sendPresenceUpdate('paused', sender);
      await sock.sendMessage(sender, { text: reply });
    }
  });
}

// Web UI Dashboard
app.get('/', async (req, res) => {
  if (connectionStatus === 'Connected') {
    res.send(`
      <html>
        <head><title>Webbiewooble AI Agent</title><style>body { font-family: sans-serif; text-align: center; margin-top: 50px; background-color: #f0f2f5; } .card { background: white; padding: 30px; border-radius: 8px; display: inline-block; box-shadow: 0 4px 6px rgba(0,0,0,0.1); } h1 { color: #075e54; }</style></head>
        <body>
          <div class="card">
            <h1>Webbiewooble AI Agent is Online!</h1>
            <p>Status: <strong>Connected</strong></p>
            <p>The bot is active and replying to personal messages on WhatsApp.</p>
          </div>
        </body>
      </html>
    `);
  } else if (qrCodeData) {
    try {
      const qrImage = await qrcode.toDataURL(qrCodeData);
      res.send(`
        <html>
          <head><title>Scan QR - Webbiewooble</title><meta http-equiv="refresh" content="15"><style>body { font-family: sans-serif; text-align: center; margin-top: 50px; background-color: #f0f2f5; } .card { background: white; padding: 30px; border-radius: 8px; display: inline-block; box-shadow: 0 4px 6px rgba(0,0,0,0.1); } img { border: 1px solid #ccc; padding: 10px; border-radius: 5px; margin-top: 15px; } h1 { color: #128c7e; }</style></head>
          <body>
            <div class="card">
              <h1>Link Your Webbiewooble Bot</h1>
              <p>Status: <strong>${connectionStatus}</strong></p>
              <p>Scan this QR code with WhatsApp Link Devices:</p>
              <img src="${qrImage}" alt="QR Code" />
              <p><small>This page auto-refreshes every 15 seconds to fetch updated code.</small></p>
            </div>
          </body>
        </html>
      `);
    } catch (err) {
      res.status(500).send('Error rendering the QR code.');
    }
  } else {
    res.send(`
      <html>
        <head><title>Loading...</title><meta http-equiv="refresh" content="5"><style>body { font-family: sans-serif; text-align: center; margin-top: 50px; background-color: #f0f2f5; } .card { background: white; padding: 30px; border-radius: 8px; display: inline-block; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }</style></head>
        <body>
          <div class="card">
            <h1>Initializing Bot Session...</h1>
            <p>Status: <strong>${connectionStatus}</strong></p>
            <p>Please wait. This page will refresh automatically in a few seconds.</p>
          </div>
        </body>
      </html>
    `);
  }
});

app.listen(port, () => {
  console.log(`Web server running on port ${port}`);
});

startBot();
