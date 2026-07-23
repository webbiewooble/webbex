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
let activeSock = null; // Globally tracks the active WhatsApp socket for keep-alive pings

// SMART AUTO-PAUSE MEMORY
const lastManualActive = {}; 
const botMessageIds = new Set(); 
const AUTO_MUTE_DURATION = 15 * 60 * 1000; 

// Prevent background network or API errors from crashing the process
process.on('uncaughtException', (err) => {
  console.error('CRITICAL: Caught Uncaught Exception to prevent crash:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL: Caught Unhandled Rejection at:', promise, 'reason:', reason);
});

function clearSessionDirectory() {
  const dir = path.join(__dirname, 'auth_info_baileys');
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log('✓ Cleared corrupt/stale session directory.');
    } catch (err) {
      console.error('Failed to clear session directory:', err);
    }
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  const isRegistered = state?.creds?.registered || false;

  // Only clear the directory if starting fresh and completely unregistered
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

  let waVersion = [2, 3000, 1043708157]; // Set fallback to modern working logs version
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
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    
    // ADVANCED ACTIVE CONNECTION KEEP-ALIVES
    keepAliveIntervalMs: 15000,   // Ping WhatsApp every 15 seconds to prevent network idle timeout
    connectTimeoutMs: 60000,      // Allow up to 60 seconds for slow cloud handshakes
    defaultQueryTimeoutMs: 0,     // Disable timeout for queries to prevent random disconnects
    retryRequestDelayMs: 5000     // Delay between query retries
  });

  activeSock = sock; // Store socket globally for keep-alive interval
  sock.ev.on('creds.update', saveCreds);

  // Listen for call events to trigger auto-pause
  sock.ev.on('call', (calls) => {
    try {
      for (const call of calls) {
        const jid = call.chatId || call.from;
        if (jid) {
          lastManualActive[jid] = Date.now();
          console.log(`Manual WhatsApp call activity detected with ${jid}. Pausing AI.`);
        }
      }
    } catch (callErr) {
      console.error('Error handling WhatsApp call event:', callErr.message);
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr && !sock.authState.creds.registered && process.env.PHONE_NUMBER && !pairingCodeRequested) {
      pairingCodeRequested = true;
      connectionStatus = 'Generating Pairing Code...';
      try {
        const cleanNumber = process.env.PHONE_NUMBER.replace(/[^0-9]/g, '');
        console.log(`Requesting pairing code for clean number: ${cleanNumber}`);
        
        const code = await sock.requestPairingCode(cleanNumber);
        pairingCode = code;
        connectionStatus = 'Pairing Code Ready';
        
        console.log(`\n=========================================\n`);
        console.log(`YOUR WHATSAPP PAIRING CODE: ${code}`);
        console.log(`\n=========================================\n`);
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
      activeSock = null;

      const isRegistered = state?.creds?.registered || false;

      // Only wipe credentials on close if we are UNREGISTERED (pairing failed / expired)
      if (!isRegistered && (reason === DisconnectReason.loggedOut || reason === DisconnectReason.badSession)) {
        console.log('Unregistered pairing session keys corrupted or expired. Purging credentials...');
        clearSessionDirectory();
      }

      // Handle Immediate Reconnect for status 515 (restartRequired)
      if (reason === DisconnectReason.restartRequired) {
        console.log('✓ Got restartRequired (515). Reconnecting IMMEDIATELY to complete pairing...');
        startBot();
        return; 
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
        console.log(`AI is currently PAUSED for ${sender} (${minutesRemaining} mins remaining) because you recently chatted/called manually.`);
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

// 3. BACKGROUND ANTI-IDLE INTERVAL:
// Simulates a presence ping to WhatsApp every 5 minutes to keep the WebSocket active
setInterval(async () => {
  if (activeSock && connectionStatus === 'Connected') {
    try {
      console.log('Sending background keep-alive presence ping...');
      await activeSock.sendPresenceUpdate('available');
    } catch (err) {
      console.warn('Background keep-alive ping skipped (normal if connection is reconnecting):', err.message);
    }
  }
}, 5 * 60 * 1000); // 5 minutes

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
