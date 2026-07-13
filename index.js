const express = require('express');
// Added fetchLatestBaileysVersion to bypass protocol rejects
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { getAIResponse } = require('./ai');

const app = express();
const port = process.env.PORT || 3000;

let pairingCode = null;
let connectionStatus = 'Disconnected';
let isReconnecting = false;
let pairingCodeRequested = false;

function clearSessionDirectory() {
  const dir = path.join(__dirname, 'auth_info_baileys');
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log('✓ Cleared corrupt session directory.');
    } catch (err) {
      console.error('Failed to clear session directory:', err);
    }
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  // 1. Fetch latest WhatsApp Web version to prevent HTTP 405 Method Not Allowed
  let waVersion = [2, 3000, 1015978187]; // Safe hardcoded fallback version
  try {
    const fetched = await fetchLatestBaileysVersion();
    if (fetched && fetched.version) {
      waVersion = fetched.version;
      console.log(`Using fetched WhatsApp Web version: ${waVersion.join('.')}`);
    }
  } catch (err) {
    console.warn('Could not fetch latest WA version, using secure fallback:', err.message);
  }

  const sock = makeWASocket({
    auth: state,
    version: waVersion, // Forces the socket to use the latest version
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Mac OS', 'Chrome', '10.1.10'] 
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr && !sock.authState.creds.registered && process.env.PHONE_NUMBER && !pairingCodeRequested) {
      pairingCodeRequested = true;
      connectionStatus = 'Generating Pairing Code...';
      try {
        const cleanNumber = process.env.PHONE_NUMBER.replace(/[^0-9]/g, '');
        console.log(`Requesting pairing code for: ${cleanNumber}`);
        
        const code = await sock.requestPairingCode(cleanNumber);
        pairingCode = code;
        connectionStatus = 'Pairing Code Ready';
        
        console.log(`\n=========================================\nYOUR WHATSAPP PAIRING CODE: ${code}\n=========================================\n`);
      } catch (err) {
        console.error('Failed to request pairing code:', err);
        connectionStatus = 'Pairing Request Failed';
        pairingCodeRequested = false; 
      }
    }
    
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log(`Connection closed with status code: ${reason || 'unknown'}`);

      pairingCode = null; 
      pairingCodeRequested = false;

      if (reason === DisconnectReason.badSession || reason === DisconnectReason.loggedOut) {
        clearSessionDirectory();
        connectionStatus = 'Logged Out (Resetting...)';
      } else {
        connectionStatus = 'Disconnected (Reconnecting...)';
      }

      if (!isReconnecting) {
        isReconnecting = true;
        setTimeout(() => {
          isReconnecting = false;
          startBot();
        }, 5000);
      }

    } else if (connection === 'open') {
      console.log('Connected to WhatsApp successfully!');
      connectionStatus = 'Connected';
      pairingCode = null;
      pairingCodeRequested = false;
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    if (sender.endsWith('@g.us')) return; 

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
  } else if (pairingCode) {
    res.send(`
      <html>
        <head><title>Pairing Code - Webbiewooble</title><meta http-equiv="refresh" content="15"><style>body { font-family: sans-serif; text-align: center; margin-top: 50px; background-color: #f0f2f5; } .card { background: white; padding: 35px; border-radius: 8px; display: inline-block; box-shadow: 0 4px 6px rgba(0,0,0,0.1); } .code { font-size: 34px; font-weight: bold; letter-spacing: 4px; color: #128c7e; background-color: #e3f2fd; padding: 15px 25px; border-radius: 5px; margin: 20px 0; display: inline-block; font-family: monospace; } h1 { color: #128c7e; }</style></head>
        <body>
          <div class="card">
            <h1>Link Your Webbiewooble Bot</h1>
            <p>Status: <strong>${connectionStatus}</strong></p>
            <p>Enter this code on your WhatsApp mobile app:</p>
            <div class="code">${pairingCode}</div>
            <p style="color: #666;"><small>To link, open WhatsApp on your phone:<br><strong>Settings</strong> → <strong>Linked Devices</strong> → <strong>Link a Device</strong> → <strong>Link with phone number instead</strong></small></p>
            <p><small>This page auto-refreshes. Once successfully linked, the status changes to Online.</small></p>
          </div>
        </body>
      </html>
    `);
  } else {
    res.send(`
      <html>
        <head><title>Initializing...</title><meta http-equiv="refresh" content="5"><style>body { font-family: sans-serif; text-align: center; margin-top: 50px; background-color: #f0f2f5; } .card { background: white; padding: 30px; border-radius: 8px; display: inline-block; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }</style></head>
        <body>
          <div class="card">
            <h1>Initializing Bot Session...</h1>
            <p>Status: <strong>${connectionStatus}</strong></p>
            <p>Preparing to request your pairing code. Please wait a few seconds...</p>
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
