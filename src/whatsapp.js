/**
 * WHATSAPP BOT — whatsapp-web.js integration
 * Monitors groups, detects voice notes, triggers processing pipeline
 */

const { Client, LocalAuth, MessageTypes } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');
const logger = require('./logger');
const { processAudioFile } = require('./processor');
const { identifySender } = require('./phoneMap');

let client = null;
let currentQR = null;
let connectionStatus = { connected: false, phone: null, info: null };

function getQRCode() { return currentQR; }
function getStatus()  { return connectionStatus; }

async function initWhatsApp(io) {
  fs.ensureDirSync('./whatsapp-session');
  fs.ensureDirSync('./uploads/audio');

  const isWin = process.platform === 'win32';
  const CHROME_PATH = isWin ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined;

  const puppeteerConfig = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
    ],
  };

  if (CHROME_PATH) {
    puppeteerConfig.executablePath = CHROME_PATH;
  }

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
    puppeteer: puppeteerConfig,
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
  });

  // ── QR Code ─────────────────────────────────────────────────
  client.on('qr', async (qr) => {
    logger.info('📱 QR code generated — scan with WhatsApp');
    // Also print to terminal for convenience
    const qrTerminal = require('qrcode-terminal');
    qrTerminal.generate(qr, { small: true });
    // Store as data URL for dashboard
    currentQR = await qrcode.toDataURL(qr);
    io.emit('qr', currentQR);
    io.emit('status', { connected: false, message: 'Scan QR code with WhatsApp' });
  });

  // ── Ready ────────────────────────────────────────────────────
  client.on('ready', async () => {
    currentQR = null;
    const info = client.info;
    connectionStatus = {
      connected: true,
      phone: info.wid.user,
      name: info.pushname,
      info,
    };
    logger.info(`✅ WhatsApp connected as ${info.pushname} (+${info.wid.user})`);
    io.emit('status', connectionStatus);
    io.emit('wa_ready', { name: info.pushname, phone: info.wid.user });
  });

  // ── Disconnected ─────────────────────────────────────────────
  client.on('disconnected', (reason) => {
    connectionStatus = { connected: false, phone: null };
    logger.warn('WhatsApp disconnected:', reason);
    io.emit('status', connectionStatus);
    // Auto-reconnect after 10s
    setTimeout(() => initWhatsApp(io), 10_000);
  });

  // ── Message received ─────────────────────────────────────────
  client.on('message', async (msg) => {
    logger.info(`Received message - type: ${msg.type}, from: ${msg.from}, author: ${msg.author || ''}, body: ${msg.body ? msg.body.substring(0, 30) : ''}`);
    try {
      await handleMessage(msg, io);
    } catch (e) {
      logger.error('Message handler error:', e);
    }
  });

  // Also handle messages sent by the authenticated user
  client.on('message_create', async (msg) => {
    if (msg.fromMe) {
      logger.info(`My sent message - type: ${msg.type}, to: ${msg.to}, body: ${msg.body ? msg.body.substring(0, 30) : ''}`);
      try {
        await handleMessage(msg, io);
      } catch (e) {
        logger.error('Message create handler error:', e);
      }
    }
  });

  await client.initialize();
}

async function handleMessage(msg, io) {
  // Only process voice notes (ptt = push to talk = voice note)
  const isVoiceNote = msg.type === MessageTypes.AUDIO || msg.type === 'ptt';
  if (!isVoiceNote) return;

  // Only process from groups (individual student groups)
  const isGroup = msg.from.endsWith('@g.us') || msg.to?.endsWith('@g.us');
  if (!isGroup) return;

  const chatJid = msg.from.endsWith('@g.us') ? msg.from : msg.to;
  logger.info(`🎙️  Voice note detected in group: ${chatJid}`);

  // Identify the sender
  let senderPhone = '';
  if (msg.fromMe) {
    senderPhone = client?.info?.wid?.user || '';
  } else {
    const authorJid = msg.author || msg.from;
    if (authorJid.endsWith('@lid')) {
      try {
        const mappings = await client.getContactLidAndPhone([authorJid]);
        if (mappings && mappings[0] && mappings[0].pn) {
          senderPhone = mappings[0].pn;
          logger.info(`Resolved LID ${authorJid} to phone number: ${senderPhone}`);
        } else {
          logger.warn(`Could not resolve LID mapping for ${authorJid}, mappings returned: ` + JSON.stringify(mappings));
        }
      } catch (err) {
        logger.warn('Failed to resolve LID phone number: ' + err.message);
      }
    }

    if (!senderPhone) {
      try {
        const contact = await msg.getContact();
        senderPhone = contact.number || '';
      } catch (err) {
        logger.error('Failed to get contact number: ' + err.message);
        senderPhone = msg.author?.replace(/[^0-9]/g, '') || msg.from.replace(/[^0-9]/g, '');
      }
    }
  }

  const senderInfo = identifySender(senderPhone, chatJid);

  if (!senderInfo.studentId) {
    logger.warn(`⚠️  Unknown sender ${senderPhone} in group ${chatJid} — skipping`);
    return;
  }

  // Download the audio
  const media = await msg.downloadMedia();
  if (!media || !media.data) {
    logger.warn('Could not download voice note media');
    return;
  }

  // Save audio file
  const audioDir = path.join('./uploads/audio', senderInfo.studentId);
  fs.ensureDirSync(audioDir);
  const audioPath = path.join(audioDir, `${Date.now()}.ogg`);
  fs.writeFileSync(audioPath, Buffer.from(media.data, 'base64'));

  logger.info(`💾 Saved audio: ${audioPath}`);

  // Notify dashboard that processing started
  io.emit('note_processing', {
    studentId: senderInfo.studentId,
    studentName: senderInfo.studentName,
    senderType: senderInfo.senderType,
    senderName: senderInfo.senderName,
    timestamp: new Date().toISOString(),
  });

  // Process the audio through the full pipeline
  const result = await processAudioFile({
    filePath: audioPath,
    studentId: senderInfo.studentId,
    senderType: senderInfo.senderType,
    senderName: senderInfo.senderName,
    senderPhone,
    source: 'whatsapp',
    io,
  });

  // Emit completed note to dashboard
  io.emit('note_complete', result);
  logger.info(`✅ Note processed: ${senderInfo.studentName} — Note #${result.note_number}`);
}

module.exports = { initWhatsApp, getQRCode, getStatus };
