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
let activeSock = null; // Globally tracks the active socket for 24/7 pings

// SMART AUTO-PAUSE MEMORY
const lastManualActive = {}; 
const botMessageIds = new Set(); 
const AUTO_MUTE_DURATION = 15 * 60 * 1000; // 15 minutes in milliseconds

// CRITICAL SAFETY GUARDS: Prevent crashes from background network/API glitches
process.on('uncaughtException', (err) => {
  console.error('CRITICAL: Caught Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL: Caught Unhandled Rejection:', reason);
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

  // Purge files ONLY if starting fresh and completely unregistered
  if (!isRegistered) {
    console.log('Bot starting in unregistered state. Purging stale pre-keys for clean slate...');
    clearSessionDirectory();
    
    const freshAuth = await useMultiFileAuthState('auth_info_baileys');
    state = freshAuth.state;
    saveCreds = freshAuth.saveCreds;
  }

  if (!process.env.PHONE_NUMBER) {
    connectionStatus = 'Error: PHONE_NUMBER variable missing in Railway Dashboard!';
    console.error('CRITICAL ERROR: PHONE_NUMBER is missing in Railway variables!');
    return;
  }

  let waVersion = [2, 3000, 1043708157]; // Tested modern fallback version
  try {
    const fetched = await fetchLatestWaWebVersion();
    if (fetched && fetched.version) {
      waVersion = fetched.version;
      console.log(`Using WhatsApp Web version: ${waVersion.join('.')}`);
    }
  } catch (err) {
    console.warn('Could not fetch latest version, using fallback:', err.message);
  }

  const sock = makeWASocket({
    auth: state,
    version: waVersion, 
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    
    // ADVANCED ACTIVE CONNECTION KEEP-ALIVES (FOR 24/7 RUNTIME)
    keepAliveIntervalMs: 15000,   // Ping WhatsApp every 15 seconds
    connectTimeoutMs: 60000,      // Allow up to 60s for cloud handshakes
    defaultQueryTimeoutMs: 0,     // Disable query timeouts to prevent drops
    retryRequestDelayMs: 5000,    // Delay between request retries
    markOnlineOnConnect: true     // Keep account active on connection
  });

  activeSock = sock; // Store active socket reference

  // Explicitly await saveCreds to prevent disk write race conditions
  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
    } catch (e) {
      console.error('Error writing creds to disk:', e.message);
    }
  });

  // Handle WhatsApp Call Events for Auto-Pause
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

  // Handle Connection State Updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (connection === 'connecting') {
      connectionStatus = 'Connecting...';
    }

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
      activeSock = null;

      const isRegisteredNow = state?.creds?.registered || false;

      // FIX FOR "COULD NOT LINK DEVICE":
      // Status 515 (restartRequired) means pairing code was ACCEPTED by WhatsApp.
      // We MUST wait 2 seconds before restarting so Railway's disk volume finishes writing registered: true!
      if (reason === DisconnectReason.restartRequired || reason === 515) {
        console.log('✓ Pairing code accepted by WhatsApp! Flushing credentials to disk before reconnecting...');
        setTimeout(() => {
          startBot();
        }, 2000); // 2-second buffer solves the disk race condition!
        return;
      }

      // Clear credentials ONLY if unregistered and connection closed due to 401/500
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

  // Handle Incoming / Outgoing Messages
  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg.message) return;

      const sender = msg.key.remoteJid;

      if (msg.key.fromMe) {
        // If message was sent by the AI bot, ignore it so it doesn't self-mute
        if (botMessageIds.has(msg.key.id)) {
          botMessageIds.delete(msg.key.id); 
          return;
        }

        // If message was sent manually by you from your phone, pause the AI for 15 mins
        lastManualActive[sender] = Date.now();
        console.log(`Manual message detected for ${sender}. Pausing AI response.`);
        return; 
      }

      if (sender.endsWith('@g.us')) return; // Block group messages

      // Check if AI is currently muted for this contact
      const lastManualTime = lastManualActive[sender] || 0;
      const timePassed = Date.now() - lastManualTime;
      
      if (timePassed < AUTO_MUTE_DURATION) {
        const minutesRemaining = Math.ceil((AUTO_MUTE_DURATION - timePassed) / 60000);
        console.log(`AI PAUSED for ${sender} (${minutesRemaining} mins remaining) due to recent manual chat/call.`);
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

// 24/7 ANTI-IDLE HEARTBEAT:
// Sends a presence ping to WhatsApp every 30 seconds to keep the socket alive continuously
setInterval(async () => {
  if (activeSock && connectionStatus === 'Connected') {
    try {
      await activeSock.sendPresenceUpdate('available');
    } catch (err) {
      // Ignored: transient background network variation
    }
  }
}, 30 * 1000); // 30 seconds

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
            <p>The bot is active and replying 24/7 to personal messages on WhatsApp.</p>
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
