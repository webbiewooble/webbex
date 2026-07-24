const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestWaWebVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { getAIResponse } = require('./ai');

const app = express();
const port = process.env.PORT || 8080;

let pairingCode = null;
let connectionStatus = 'Disconnected';
let isReconnecting = false;
let pairingCodeRequested = false;
let activeSock = null;
let lastSocketActivity = Date.now(); // Watchdog activity tracker

// SMART AUTO-PAUSE MEMORY
const lastManualActive = {}; 
const botMessageIds = new Set(); 
const AUTO_MUTE_DURATION = 15 * 60 * 1000; 

// CRITICAL PROCESS GUARD: Prevents crashes
process.on('uncaughtException', (err) => {
  console.error('Caught Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('Caught Unhandled Rejection:', reason);
});

function clearSessionDirectory() {
  const dir = path.join(__dirname, 'auth_info_baileys');
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log('✓ Cleared corrupt/stale session directory.');
    } catch (err) {
      console.error('Failed to clear session directory:', err.message);
    }
  }
}

async function startBot() {
  let authData = await useMultiFileAuthState('auth_info_baileys');
  let state = authData.state;
  let saveCreds = authData.saveCreds;

  const isRegistered = state?.creds?.registered || false;

  if (!isRegistered) {
    console.log('Bot starting in unregistered state. Purging stale pre-keys for clean slate...');
    clearSessionDirectory();
    
    const freshAuth = await useMultiFileAuthState('auth_info_baileys');
    state = freshAuth.state;
    saveCreds = freshAuth.saveCreds;
  }

  if (!process.env.PHONE_NUMBER) {
    connectionStatus = 'Error: PHONE_NUMBER missing in Railway Dashboard!';
    console.error('CRITICAL ERROR: PHONE_NUMBER is missing in Railway variables!');
    return;
  }

  let waVersion = [2, 3000, 1043708157]; 
  try {
    const fetched = await fetchLatestWaWebVersion();
    if (fetched && fetched.version) {
      waVersion = fetched.version;
      console.log(`Using WhatsApp Web version: ${waVersion.join('.')}`);
    }
  } catch (err) {
    console.warn('Could not fetch latest version, using stable fallback:', err.message);
  }

  const sock = makeWASocket({
    auth: state,
    version: waVersion, 
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    keepAliveIntervalMs: 15000,   // Active 15s keep-alive ping
    connectTimeoutMs: 60000,      
    defaultQueryTimeoutMs: 0,     
    retryRequestDelayMs: 5000     
  });

  activeSock = sock;
  lastSocketActivity = Date.now();

  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
    } catch (e) {
      console.error('Error writing creds to disk:', e.message);
    }
  });

  sock.ev.on('call', (calls) => {
    try {
      for (const call of calls) {
        const jid = call.chatId || call.from;
        if (jid) {
          lastManualActive[jid] = Date.now();
          console.log(`Manual call detected with ${jid}. Pausing AI.`);
        }
      }
    } catch (callErr) {
      console.error('Error handling call:', callErr.message);
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    lastSocketActivity = Date.now(); // Update watchdog timer

    if (connection === 'connecting') {
      connectionStatus = 'Connecting...';
    }

    if (qr && !sock.authState.creds.registered && process.env.PHONE_NUMBER && !pairingCodeRequested) {
      pairingCodeRequested = true;
      connectionStatus = 'Generating Pairing Code...';
      try {
        const cleanNumber = process.env.PHONE_NUMBER.replace(/[^0-9]/g, '');
        console.log(`Requesting pairing code for clean number: ${cleanNumber}`);
        
        const code = await sock.requestPairingCode(cleanNumber);
        pairingCode = code;
        connectionStatus = 'Pairing Code Ready';
        
        console.log(`\n=========================================\nYOUR WHATSAPP PAIRING CODE: ${code}\n=========================================\n`);
      } catch (err) {
        console.error('Failed to request pairing code:', err.message);
        connectionStatus = 'Pairing Request Failed';
        pairingCodeRequested = false; 
      }
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log(`Connection closed with status code: ${reason || 'unknown'}`);

      pairingCode = null; 
      pairingCodeRequested = false;
      activeSock = null;

      const isRegisteredNow = state?.creds?.registered || false;

      if (reason === DisconnectReason.restartRequired || reason === 515) {
        console.log('✓ Pairing accepted! Reconnecting immediately...');
        setTimeout(() => {
          startBot();
        }, 2000);
        return;
      }

      if (!isRegisteredNow && (reason === DisconnectReason.loggedOut || reason === DisconnectReason.badSession)) {
        console.log('Unregistered session keys corrupted or expired. Purging credentials...');
        clearSessionDirectory();
      }

      connectionStatus = 'Disconnected (Reconnecting...)';

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
    try {
      lastSocketActivity = Date.now(); // Refresh watchdog on message
      const msg = m.messages[0];
      if (!msg.message) return;

      const sender = msg.key.remoteJid;

      if (msg.key.fromMe) {
        if (botMessageIds.has(msg.key.id)) {
          botMessageIds.delete(msg.key.id); 
          return;
        }

        lastManualActive[sender] = Date.now();
        console.log(`Manual message detected for ${sender}. Pausing AI response.`);
        return; 
      }

      if (sender.endsWith('@g.us')) return; 

      const lastManualTime = lastManualActive[sender] || 0;
      const timePassed = Date.now() - lastManualTime;
      
      if (timePassed < AUTO_MUTE_DURATION) {
        const minutesRemaining = Math.ceil((AUTO_MUTE_DURATION - timePassed) / 60000);
        console.log(`AI PAUSED for ${sender} (${minutesRemaining} mins remaining).`);
        return; 
      }

      const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

      if (text) {
        console.log(`DM from ${sender}: ${text}`);
        
        await sock.sendPresenceUpdate('composing', sender);
        const reply = await getAIResponse(text);
        await sock.sendPresenceUpdate('paused', sender);
        
        const sentMsg = await sock.sendMessage(sender, { text: reply });
        if (sentMsg && sentMsg.key && sentMsg.key.id) {
          botMessageIds.add(sentMsg.key.id);
        }
      }
    } catch (msgErr) {
      console.error('Error processing incoming message:', msgErr.message);
    }
  });
}

// 1. WATCHDOG TIMER (Runs every 2 minutes):
// Detects zombie sockets that silently dropped and force-heals the connection
setInterval(() => {
  if (connectionStatus === 'Connected') {
    const inactiveTime = Date.now() - lastSocketActivity;
    // If no socket activity or event in 4 minutes, force a self-healing reconnect
    if (inactiveTime > 4 * 60 * 1000) {
      console.warn('WATCHDOG: Silent connection drop detected. Force-healing connection...');
      connectionStatus = 'Reconnecting (Watchdog)...';
      if (activeSock) {
        try { activeSock.end(undefined); } catch (e) {}
      }
      startBot();
    } else if (activeSock) {
      // Send background presence to keep socket warm
      activeSock.sendPresenceUpdate('available').catch(() => {});
    }
  }
}, 2 * 60 * 1000);

// 2. SELF-PING CONTAINER HEARTBEAT (Runs every 5 minutes):
// Keeps Railway container network 100% active
setInterval(() => {
  fetch(`http://localhost:${port}/`).catch(() => {});
}, 5 * 60 * 1000);

// Web Interface
app.get('/', async (req, res) => {
  if (connectionStatus === 'Connected') {
    res.send(`
      <html>
        <head><title>Webbiewooble AI Agent</title><style>body { font-family: sans-serif; text-align: center; margin-top: 50px; background-color: #f0f2f5; } .card { background: white; padding: 30px; border-radius: 8px; display: inline-block; box-shadow: 0 4px 6px rgba(0,0,0,0.1); } h1 { color: #075e54; }</style></head>
        <body>
          <div class="card">
            <h1>Webbiewooble AI Agent is Online!</h1>
            <p>Status: <strong>Connected (Watchdog Active)</strong></p>
            <p>The bot is active and replying 24/7 to personal messages on WhatsApp.</p>
          </div>
        </body>
      </html>
    `);
  } else if (pairingCode) {
    res.send(`
      <html>
        <head>
          <title>Pairing Code - Webbiewooble</title>
          <meta http-equiv="refresh" content="15">
          <style>
            body { font-family: sans-serif; text-align: center; margin-top: 50px; background-color: #f0f2f5; }
            .card { background: white; padding: 35px; border-radius: 8px; display: inline-block; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
            .code { font-size: 34px; font-weight: bold; letter-spacing: 4px; color: #128c7e; background-color: #e3f2fd; padding: 15px 25px; border-radius: 5px; margin: 20px 0; display: inline-block; font-family: monospace; }
            h1 { color: #128c7e; }
          </style>
        </head>
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
        <head><title>Initializing...</title><meta http-equiv="refresh" content="5"><style>body { font-family: sans-serif; text-align: center; margin-top: 50px; background-color: #f0f2f5; } .card { background: white; padding: 30px; border-radius: 8px; display: inline-block; box-shadow: 0 4px 6px rgba(0,0,0,0.1); } .error-msg { color: #d32f2f; font-weight: bold; }</style></head>
        <body>
          <div class="card">
            <h1>Initializing Bot Session...</h1>
            <p>Status: <span class="${connectionStatus.includes('Error') ? 'error-msg' : ''}"><strong>${connectionStatus}</strong></span></p>
            ${connectionStatus.includes('Error') ? 
              '<p>Please configure the <code>PHONE_NUMBER</code> variable inside your Railway Dashboard, then rebuild the service.</p>' : 
              '<p>Requesting fresh pairing code. Please wait a few seconds...</p>'
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
