const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const pino = require('pino');
const { getAIResponse } = require('./ai');

const app = express();
const port = process.env.PORT || 3000;

let qrCodeData = null;
let connectionStatus = 'Disconnected';

async function startBot() {
  // Saved session states are saved to 'auth_info_baileys' directory.
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrCodeData = qr;
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting...', shouldReconnect);
      connectionStatus = 'Disconnected (Reconnecting...)';
      if (shouldReconnect) {
        startBot();
      }
    } else if (connection === 'open') {
      console.log('Connected to WhatsApp successfully!');
      connectionStatus = 'Connected';
      qrCodeData = null; // Clear QR data on successful link
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

    if (text) {
      console.log(`Message from ${sender}: ${text}`);
      
      // Simulate typing for natural behavior
      await sock.sendPresenceUpdate('composing', sender);
      
      const reply = await getAIResponse(text);
      
      await sock.sendPresenceUpdate('paused', sender);
      await sock.sendMessage(sender, { text: reply });
    }
  });
}

// Simple web UI to render the QR Code or display Connection status
app.get('/', async (req, res) => {
  if (connectionStatus === 'Connected') {
    res.send(`
      <html>
        <head><title>Bot Status</title><style>body { font-family: sans-serif; text-align: center; margin-top: 50px; background-color: #f0f2f5; } .card { background: white; padding: 30px; border-radius: 8px; display: inline-block; box-shadow: 0 4px 6px rgba(0,0,0,0.1); } h1 { color: #075e54; }</style></head>
        <body>
          <div class="card">
            <h1>WhatsApp Bot is Online!</h1>
            <p>Status: <strong>Connected</strong></p>
            <p>The bot is active and replying to chats.</p>
          </div>
        </body>
      </html>
    `);
  } else if (qrCodeData) {
    try {
      const qrImage = await qrcode.toDataURL(qrCodeData);
      res.send(`
        <html>
          <head><title>Scan QR</title><meta http-equiv="refresh" content="15"><style>body { font-family: sans-serif; text-align: center; margin-top: 50px; background-color: #f0f2f5; } .card { background: white; padding: 30px; border-radius: 8px; display: inline-block; box-shadow: 0 4px 6px rgba(0,0,0,0.1); } img { border: 1px solid #ccc; padding: 10px; border-radius: 5px; margin-top: 15px; } h1 { color: #128c7e; }</style></head>
          <body>
            <div class="card">
              <h1>Link Your Bot</h1>
              <p>Status: <strong>${connectionStatus}</strong></p>
              <p>Scan this QR code with WhatsApp Link Devices:</p>
              <img src="${qrImage}" alt="QR Code" />
              <p><small>This page auto-refreshes every 15 seconds as the QR code updates.</small></p>
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
