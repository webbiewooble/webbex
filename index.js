const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestWaWebVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { getAIResponse } = require('./ai');

const app = express();
const port = process.env.PORT || 8080;

let pairingCode = null;
let pairingCodeTimestamp = 0; 
let connectionStatus = 'Disconnected';
let isReconnecting = false;
let pairingCodeRequested = false;

function clearSessionDirectory() {
  const dir = path.join(__dirname, 'auth_info_baileys');
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log('✓ Cleared stale/unregistered session directory successfully.');
    } catch (err) {
      console.error('Failed to clear session directory:', err);
    }
  }
}

async function startBot() {
  let authState = await useMultiFileAuthState('auth_info_baileys');
  let state = authState.state;
  let saveCreds = authState.saveCreds;

  const isRegistered = state?.creds?.registered || false;

  // Clear directory only if starting completely clean & unregistered
  if (!isRegistered) {
    console.log('Bot starting in unregistered state. Purging stale pre-keys for a clean slate...');
    clearSessionDirectory();
    
    const freshAuth = await useMultiFileAuthState('auth_info_baileys');
    state = freshAuth.state;
    saveCreds = freshAuth.saveCreds;
  }

  if (!process.env.PHONE_NUMBER) {
    connectionStatus = 'Error: PHONE_NUMBER variable missing in Railway Dashboard!';
    console.error('CRITICAL ERROR: PHONE_NUMBER is not set in Railway variables!');
    return;
  }

  let waVersion = [2, 3000, 1042466098]; 
  try {
    const fetched = await fetchLatestWaWebVersion();
    if (fetched && fetched.version) {
      waVersion = fetched.version;
      console.log(`Successfully fetched latest WhatsApp Web version: ${waVersion.join('.')}`);
    }
  } catch (err) {
    console.warn('Could not fetch latest WA version dynamically, using stable fallback:', err.message);
  }

  const sock = makeWASocket({
    auth: state,
    version: waVersion,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Windows', 'Chrome', '124.0.0.0'] 
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr && !sock.authState.creds.registered && process.env.PHONE_NUMBER) {
      const now = Date.now();
      const isExpired = (now - pairingCodeTimestamp) > 120000;

      if (!pairingCodeRequested || isExpired) {
        pairingCodeRequested = true;
        pairingCodeTimestamp = now;
        connectionStatus = 'Generating Fresh Pairing Code...';
        
        try {
          const cleanNumber = process.env.PHONE_NUMBER.replace(/[^0-9]/g, '');
          console.log(`Requesting fresh pairing code for clean number: ${cleanNumber}`);
          
          const code = await sock.requestPairingCode(cleanNumber);
          pairingCode = code;
          connectionStatus = 'Pairing Code Ready';
          
          console.log(`\n=========================================\n`);
          console.log(`YOUR FRESH WHATSAPP PAIRING CODE: ${code}`);
          console.log(`\n=========================================\n`);
        } catch (err) {
          console.error('Failed to request pairing code:', err);
          connectionStatus = 'Pairing Request Failed';
          pairingCodeRequested = false; 
        }
      }
    }
    
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log(`Connection closed with status code: ${reason || 'unknown'}`);

      const wasRegistered = state?.creds?.registered || false;

      // CRITICAL UPDATE: If WhatsApp server returns restartRequired (515) after pairing,
      // reconnect INSTANTLY with no delay to finalize the secure device registration handshake.
      if (reason === DisconnectReason.restartRequired) {
        console.log('✓ Got restartRequired (515). Reconnecting IMMEDIATELY to complete pairing...');
        startBot();
        return; 
      }

      if (wasRegistered && (reason === DisconnectReason.loggedOut || reason === DisconnectReason.badSession)) {
        console.log('Active session logged out or corrupted. Wiping credentials to reset...');
        clearSessionDirectory();
        connectionStatus = 'Logged Out (Resetting...)';
        pairingCode = null;
        pairingCodeRequested = false;
      } else {
        connectionStatus = 'Disconnected (Reconnecting...)';
      }

      if (!isReconnecting) {
        isReconnecting = true;
        setTimeout(() => {
          isReconnecting = false;
          startBot();
        }, 5000); // 5-second delay for standard network drops (like 408 / 428)
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

// Web Dashboard
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
            <p><small>This page auto-refreshes. Old codes automatically expire and refresh every 2 minutes.</small></p>
          </div>
        </body>
      </html>
    `);
  } else {
    res.send(`
      <html>
        <head><title>Initializing...</title><meta http-equiv="refresh" content="5"><style>body { font-family: sans-serif; text-align: center; margin-top: 50px; background-color: #f0f2f5; } .card { background: white; padding: 30px; border-radius: 8px; display: inline-block; box-shadow: 0 4px 6px rgba(0,0,0,0.1); } .error-msg { color: #d32f2f; font-weight: bold; }</style></head>
        <body>
          <div class="card">
            <h1>Initializing Bot Session...</h1>
            <p>Status: <span class="${connectionStatus.includes('Error') ? 'error-msg' : ''}"><strong>${connectionStatus}</strong></span></p>
            ${connectionStatus.includes('Error') ? 
              '<p>Please configure the <code>PHONE_NUMBER</code> variable inside your Railway Dashboard, then rebuild the service.</p>' : 
              '<p>Requesting fresh, active pairing code. Please wait a few seconds...</p>'
            }
          </div>
        </body>
      </html>
    `);
  }
});

app.listen(port, () => {
  console.log(`Web server successfully running on port ${port}`);
});

startBot();
