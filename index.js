This is a critical feature for any real-world business chatbot. If you are
actively talking or calling a client yourself, the AI must step aside and not
send automatic, overlapping replies.

How we will solve this (Smart Auto-Pause)

We will implement an automatic 15-minute mute timer in index.js. It works purely
in the background without you having to configure or type any commands:

1.  Manual Text Detection: The moment you send a message manually from your
    phone (fromMe === true), the bot detects it and instantly pauses the AI for
    that specific client for 15 minutes [2].
2.  WhatsApp Call Detection: If you place or receive a WhatsApp call (audio or
    video) with a client, the bot registers the call event and instantly pauses
    the AI for that client [2].
3.  Auto-Resume: Every manual text or call resets the 15-minute countdown. If 15
    minutes pass with absolutely no manual texts or calls, the AI assumes you
    are done and automatically resumes duty for that chat.

Updated index.js (with Smart Auto-Pause)

Replace your index.js file with this complete version:

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

// SMART AUTO-PAUSE MEMORY
const lastManualActive = {}; 
const AUTO_MUTE_DURATION = 15 * 60 * 1000; // 15 minutes in milliseconds (Change this number to adjust duration)

// Prevent random background network/API errors from crashing the process
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
      console.log('✓ Cleared corrupt session directory.');
    } catch (err) {
      console.error('Failed to clear session directory:', err);
    }
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  let waVersion = [2, 3000, 1042466098]; // Reliable fallback version
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
    version: waVersion, // Force modern protocol connection
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '20.0.04'] 
  });

  sock.ev.on('creds.update', saveCreds);

  // LISTEN FOR CALL EVENTS: Pause the AI if you call or get called
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
    try {
      const msg = m.messages[0];
      if (!msg.message) return;

      const sender = msg.key.remoteJid;

      // 1. If you send a message manually from your phone, record the timestamp & pause the AI
      if (msg.key.fromMe) {
        lastManualActive[sender] = Date.now();
        console.log(`Manual message detected for ${sender}. Pausing AI response.`);
        return; // Do not let the AI reply to your own manual messages
      }

      if (sender.endsWith('@g.us')) return; 

      // 2. Check if the AI is currently muted for this specific client
      const lastManualTime = lastManualActive[sender] || 0;
      const timePassed = Date.now() - lastManualTime;
      
      if (timePassed < AUTO_MUTE_DURATION) {
        const minutesRemaining = Math.ceil((AUTO_MUTE_DURATION - timePassed) / 60000);
        console.log(`AI is currently PAUSED for ${sender} (${minutesRemaining} mins remaining) because you recently chatted/called manually.`);
        return; // Silent bypass: Let you talk manually without AI interruption
      }

      const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

      if (text) {
        console.log(`DM from ${sender}: ${text}`);
        await sock.sendPresenceUpdate('composing', sender);
        const reply = await getAIResponse(text);
        await sock.sendPresenceUpdate('paused', sender);
        await sock.sendMessage(sender, { text: reply });
      }
    } catch (msgErr) {
      console.error('Error processing incoming message:', msgErr.message);
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

Next Steps:

1.  Save the file and push the update:
    git add index.js
    git commit -m "Implement smart auto-pause for personal chats and calls"
    git push origin main
2.  Once Railway finishes deploying, you are ready to test it.

How to test it: If you send a WhatsApp message to a client yourself, look at
your Railway logs. You will see: Manual message detected. Pausing AI response.
For the next 15 minutes, you can have a normal personal conversation without the
AI sending any automated replies!
