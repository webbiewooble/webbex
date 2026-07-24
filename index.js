const express = require('express');
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  fetchLatestWaWebVersion, 
  Browsers 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { getAIResponse } = require('./ai');

const app = express();
const port = process.env.PORT || 8080;

let globalSock = null; // SINGLETON REFERENCE: Guarantees only 1 socket runs in memory
let rawQrData = null;
let pairingCode = null;
let connectionStatus = 'Disconnected';
let isConnecting = false;

// SMART AUTO-PAUSE MEMORY
const lastManualActive = {}; 
const botMessageIds = new Set(); 
const AUTO_MUTE_DURATION = 15 * 60 * 1000; 

// CRITICAL PROCESS GUARD: Prevents crashes from network/API drops
process.on('uncaughtException', (err) => {
  console.error('CRITICAL: Caught Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('CRITICAL: Caught Unhandled Rejection:', reason);
});

function clearSessionDirectory() {
  const dir = path.join(__dirname, 'auth_info_baileys');
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log('✓ Cleared session directory.');
    } catch (err) {
      console.error('Failed to clear session directory:', err.message);
    }
  }
}

async function startBot() {
  if (isConnecting) {
    console.log('Connection attempt already in progress. Skipping duplicate execution...');
    return;
  }
  isConnecting = true;

  // GHOST SOCKET ERADICATION: Kill lingering old sockets before launching a new one!
  if (globalSock) {
    try {
      console.log('Cleaning up old lingering socket connection...');
      globalSock.ev.removeAllListeners();
      globalSock.ws.close();
      globalSock.end(undefined);
    } catch (e) {
      // Ignore teardown errors
    }
    globalSock = null;
  }

  let authData = await useMultiFileAuthState('auth_info_baileys');
  let state = authData.state;
  let saveCreds = authData.saveCreds;

  const isRegistered = state?.creds?.registered || false;

  // Clean startup slate if not registered
  if (!isRegistered) {
    console.log('Starting in unregistered state. Purging stale pre-keys for clean slate...');
    clearSessionDirectory();
    
    const freshAuth = await useMultiFileAuthState('auth_info_baileys');
    state = freshAuth.state;
    saveCreds = freshAuth.saveCreds;
  }

  if (!process.env.PHONE_NUMBER) {
    connectionStatus = 'Error: PHONE_NUMBER missing in Railway Variables!';
    console.error('CRITICAL ERROR: PHONE_NUMBER is missing in Railway variables!');
    isConnecting = false;
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
    console.warn('Could not fetch latest version, using fallback:', err.message);
  }

  const sock = makeWASocket({
    auth: state,
    version: waVersion, 
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    
    // NATIVE DESKTOP HANDSHAKE
    browser: Browsers.macOS('Desktop'),
    
    // LIGHTWEIGHT CLOUD CONNECTION: Stops WhatsApp from choking socket with old messages
    syncFullHistory: false,
    fireInitQueries: false,
    
    // ACTIVE CONNECTION KEEP-ALIVES
    keepAliveIntervalMs: 15000,   
    connectTimeoutMs: 60000,      
    defaultQueryTimeoutMs: 0,     
    retryRequestDelayMs: 5000,    
    markOnlineOnConnect: true     
  });

  globalSock = sock; // Save to global singleton

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

    if (connection === 'connecting') {
      connectionStatus = 'Connecting...';
    }

    if (qr && !sock.authState.creds.registered) {
      rawQrData = qr; 
      connectionStatus = 'Ready to Link (Scan QR Code)';
      
      if (process.env.PHONE_NUMBER && !pairingCode) {
        try {
          const cleanNumber = process.env.PHONE_NUMBER.replace(/[^0-9]/g, '');
          console.log(`Requesting pairing code for: ${cleanNumber}`);
          const code = await sock.requestPairingCode(cleanNumber);
          pairingCode = code;
          console.log(`\n=========================================\nYOUR WHATSAPP PAIRING CODE: ${code}\n=========================================\n`);
        } catch (err) {
          console.error('Failed to request pairing code:', err.message);
        }
      }
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log(`Connection closed with status code: ${reason || 'unknown'}`);

      rawQrData = null;
      pairingCode = null; 
      globalSock = null;
      isConnecting = false;

      const isRegisteredNow = state?.creds?.registered || false;

      // PAIRING SUCCESS (515) -> DISK FLUSH BUFFER
      if (reason === DisconnectReason.restartRequired || reason === 515) {
        console.log('✓ Pairing accepted! Flushing credentials to disk before reconnecting...');
        setTimeout(() => {
          startBot();
        }, 3000); // 3-second buffer ensures disk synchronization
        return;
      }

      if (!isRegisteredNow && (reason === DisconnectReason.loggedOut || reason === DisconnectReason.badSession)) {
        console.log('Unregistered session keys corrupted or expired. Purging credentials...');
        clearSessionDirectory();
      }

      connectionStatus = 'Disconnected (Reconnecting in 5s...)';

      setTimeout(() => {
        startBot();
      }, 5000);

    } else if (connection === 'open') {
      console.log('Connected to WhatsApp successfully!');
      connectionStatus = 'Connected';
      rawQrData = null;
      pairingCode = null;
      isConnecting = false;
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

// 24/7 Keep-Alive Ping every 30 seconds
setInterval(async () => {
  if (globalSock && connectionStatus === 'Connected') {
    try {
      await globalSock.sendPresenceUpdate('available');
    } catch (err) {
      // Ignore background variation
    }
  }
}, 30 * 1000); 

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
  } else if (rawQrData || pairingCode) {
    let qrImage = '';
    if (rawQrData) {
      try {
        qrImage = await qrcode.toDataURL(rawQrData);
      } catch (err) {
        console.error('Error generating QR image:', err);
      }
    }

    res.send(`
      <html>
        <head>
          <title>Link Your Bot - Webbiewooble</title>
          <meta http-equiv="refresh" content="15">
          <style>
            body { font-family: sans-serif; text-align: center; margin-top: 30px; background-color: #f0f2f5; }
            .card { background: white; padding: 30px; border-radius: 12px; display: inline-block; box-shadow: 0 4px 10px rgba(0,0,0,0.1); max-width: 480px; }
            .code { font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #128c7e; background-color: #e3f2fd; padding: 12px 20px; border-radius: 6px; margin: 15px 0; display: inline-block; font-family: monospace; }
            img { border: 2px solid #128c7e; padding: 10px; border-radius: 8px; margin: 10px 0; width: 220px; height: 220px; }
            h1 { color: #128c7e; margin-bottom: 5px; }
            .method-box { background: #fafafa; border: 1px solid #e0e0e0; padding: 15px; border-radius: 8px; margin-top: 15px; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Link Your Webbiewooble Bot</h1>
            <p>Status: <strong>${connectionStatus}</strong></p>
            
            ${qrImage ? `
              <div class="method-box">
                <h3 style="margin-top:0; color:#075e54;">METHOD 1: Scan QR Code (Fastest)</h3>
                <p><small>Open WhatsApp on phone → <strong>Linked Devices</strong> → <strong>Link a Device</strong> → Point phone camera at this iPad screen:</small></p>
                <img src="${qrImage}" alt="WhatsApp QR Code" />
              </div>
            ` : ''}

            ${pairingCode ? `
              <div class="method-box">
                <h3 style="margin-top:0; color:#075e54;">METHOD 2: Pairing Code</h3>
                <p><small>WhatsApp → Linked Devices → Link with phone number instead:</small></p>
                <div class="code">${pairingCode}</div>
              </div>
            ` : ''}

            <p><small style="color: #888;">This page auto-refreshes every 15 seconds.</small></p>
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
              '<p>Generating secure QR code and Pairing code. Please wait a few seconds...</p>'
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
