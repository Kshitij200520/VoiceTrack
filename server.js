/**
 * EDOOFA VOICETRACK — MAIN SERVER
 * Express + Socket.IO backend
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');

const { initWhatsApp, getQRCode, getStatus } = require('./src/whatsapp');
const { getDb } = require('./src/database');
const { getStudentMap, addStudent, getAllStudents } = require('./src/phoneMap');
const sheetsModule = require('./src/sheets');
const logger = require('./src/logger');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// app.use(rateLimit({ windowMs: 60_000, max: 1000 }));

// ── Make io available to route handlers ─────────────────────
app.set('io', io);

// ── API Routes ───────────────────────────────────────────────

/** System status */
app.get('/api/status', (req, res) => {
  const db = getDb();
  const todayNotes = db.prepare(
    "SELECT COUNT(*) as count FROM voice_notes WHERE date(created_at) = date('now')"
  ).get();
  const pendingActions = db.prepare(
    "SELECT COUNT(*) as count FROM action_items WHERE resolved = 0"
  ).get();
  const totalStudents = db.prepare(
    "SELECT COUNT(*) as count FROM students"
  ).get();

  res.json({
    whatsapp: getStatus(),
    notes_today: todayNotes.count,
    pending_actions: pendingActions.count,
    total_students: totalStudents.count,
    uptime: process.uptime(),
  });
});

/** Get WhatsApp QR code (for first-time login) */
app.get('/api/qr', (req, res) => {
  const qr = getQRCode();
  if (qr) {
    res.json({ qr, status: 'pending' });
  } else {
    const status = getStatus();
    res.json({ qr: null, status: status.connected ? 'connected' : 'initializing' });
  }
});

/** Get all voice notes (with optional filters) */
app.get('/api/notes', (req, res) => {
  const db = getDb();
  const { studentId, sender, date, limit = 50, offset = 0 } = req.query;

  let query = `
    SELECT n.*, s.name as student_name, s.counselor
    FROM voice_notes n
    JOIN students s ON n.student_id = s.student_id
    WHERE 1=1
  `;
  const params = [];

  if (studentId) { query += ' AND n.student_id = ?'; params.push(studentId); }
  if (sender)    { query += ' AND n.sender_type = ?'; params.push(sender); }
  if (date)      { query += ' AND date(n.created_at) = ?'; params.push(date); }

  query += ' ORDER BY n.created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const notes = db.prepare(query).all(...params);
  const total = db.prepare(
    'SELECT COUNT(*) as c FROM voice_notes WHERE 1=1'
    + (studentId ? ' AND student_id = ?' : '')
  ).get(...(studentId ? [studentId] : [])).c;

  res.json({ notes, total });
});

/** Get single student's full timeline */
app.get('/api/notes/:studentId', (req, res) => {
  const db = getDb();
  const notes = db.prepare(`
    SELECT n.*, s.name as student_name, s.counselor
    FROM voice_notes n
    JOIN students s ON n.student_id = s.student_id
    WHERE n.student_id = ?
    ORDER BY n.note_number ASC
  `).all(req.params.studentId);
  res.json(notes);
});

/** Get all students */
app.get('/api/students', (req, res) => {
  res.json(getAllStudents());
});

/** Add / update a student (phone mapping) */
app.post('/api/students', (req, res) => {
  try {
    const student = addStudent(req.body);
    res.json({ success: true, student });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Get action items (pending) */
app.get('/api/actions', (req, res) => {
  const db = getDb();
  const { resolved = 0 } = req.query;
  const items = db.prepare(`
    SELECT a.*, s.name as student_name
    FROM action_items a
    JOIN students s ON a.student_id = s.student_id
    WHERE a.resolved = ?
    ORDER BY a.created_at DESC
  `).all(Number(resolved));
  res.json(items);
});

/** Resolve an action item */
app.patch('/api/actions/:id/resolve', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE action_items SET resolved = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

/** Manual upload endpoint (for fallback: ops team uploads exported audio) */
const multer = require('multer');
const fs = require('fs-extra');
const { processAudioFile } = require('./src/processor');

const upload = multer({ dest: 'uploads/temp/' });
app.post('/api/upload', upload.single('audio'), async (req, res) => {
  try {
    const { studentId, senderType, senderName } = req.body;
    if (!studentId || !senderType || !req.file) {
      return res.status(400).json({ error: 'studentId, senderType, and audio file are required' });
    }

    const result = await processAudioFile({
      filePath: req.file.path,
      studentId,
      senderType,
      senderName: senderName || senderType,
      source: 'manual_upload',
      io,
    });

    res.json({ success: true, note: result });
  } catch (e) {
    logger.error('Upload error:', e);
    res.status(500).json({ error: e.message });
  }
});

/** Export to CSV */
app.get('/api/export/csv', (req, res) => {
  const db = getDb();
  const notes = db.prepare(`
    SELECT n.*, s.name as student_name, s.counselor
    FROM voice_notes n JOIN students s ON n.student_id = s.student_id
    ORDER BY n.created_at DESC
  `).all();

  const headers = [
    'Date','Student ID','Student Name','Note #','Sender Type',
    'Sender Name','Duration','Transcript','AI Summary','Action Items',
    'Tags','Counselor','Status'
  ];

  const rows = notes.map(n => [
    new Date(n.created_at).toLocaleDateString('en-IN'),
    n.student_id,
    n.student_name,
    n.note_number,
    n.sender_type,
    n.sender_name,
    n.duration || '',
    `"${(n.transcript || '').replace(/"/g, '""')}"`,
    `"${(n.summary || '').replace(/"/g, '""')}"`,
    `"${(n.action_items || '').replace(/"/g, '""')}"`,
    n.tags || '',
    n.counselor || '',
    'Processed',
  ]);

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition',
    `attachment; filename=edoofa_voicenotes_${new Date().toISOString().split('T')[0]}.csv`);
  res.send(csv);
});

/** Trigger manual Google Sheets sync */
app.post('/api/sync-sheets', async (req, res) => {
  try {
    const count = await sheetsModule.syncAllPending();
    res.json({ success: true, synced: count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Health check for Railway */
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

/** Serve dashboard for all other routes */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Socket.IO ────────────────────────────────────────────────
io.on('connection', (socket) => {
  logger.info('Dashboard connected: ' + socket.id);
  socket.emit('status', getStatus());
});

// ── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  logger.info(`🚀 Edoofa VoiceTrack running on http://localhost:${PORT}`);

  // Init database
  require('./src/database').initDb();

  // Seed sample students if empty
  require('./src/phoneMap').seedSampleStudents();

  // Init Google Sheets
  try {
    await sheetsModule.initSheet();
    logger.info('✅ Google Sheets connected');
  } catch (e) {
    logger.warn('⚠️  Google Sheets not configured: ' + e.message);
  }

  // Start WhatsApp bot (non-fatal — rest of server works without it)
  try {
    await initWhatsApp(io);
    logger.info('✅ WhatsApp bot starting...');
  } catch (e) {
    logger.warn('⚠️  WhatsApp bot failed to start: ' + e.message);
    logger.warn('    Dashboard and manual upload still work. Fix WhatsApp and restart.');
  }
});

module.exports = { app, io };
