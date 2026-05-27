/**
 * AUDIO PROCESSOR — Full pipeline using GROQ (100% Free)
 * Groq Whisper → Transcribe  |  Groq Llama-3 → Summarize
 * Stores to SQLite → Syncs to Google Sheets
 */

const fs   = require('fs-extra');
const path = require('path');
const Groq = require('groq-sdk');
const { getDb }      = require('./database');
const sheetsModule   = require('./sheets');
const logger         = require('./logger');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Groq models ──────────────────────────────────────────────
const WHISPER_MODEL = 'whisper-large-v3';       // Best transcription — free on Groq
const CHAT_MODEL    = 'llama-3.3-70b-versatile'; // Powerful, free on Groq

/**
 * Main pipeline: audio file → stored structured note
 * Called by WhatsApp bot or manual upload endpoint
 */
async function processAudioFile({
  filePath, studentId, senderType, senderName, senderPhone, source, io
}) {
  const db = getDb();

  // ── Verify student ──────────────────────────────────────────
  const student = db.prepare('SELECT * FROM students WHERE student_id = ?').get(studentId);
  if (!student) throw new Error(`Student ${studentId} not found in database`);

  // ── Stage 1: Transcribe with Groq Whisper ──────────────────
  emitStage(io, studentId, 'transcribe', 'running');
  let transcript = '';

  try {
    logger.info(`🎙️  Transcribing with Groq Whisper (${WHISPER_MODEL})…`);

    const audioStream = fs.createReadStream(filePath);
    const response = await groq.audio.transcriptions.create({
      file: audioStream,
      model: WHISPER_MODEL,
      response_format: 'json',
      language: 'hi',          // Handles Hindi, English, Hinglish automatically
      temperature: 0.0,         // Deterministic for accuracy
    });

    transcript = response.text?.trim() || '';
    logger.info(`📝 Transcribed (${transcript.length} chars): "${transcript.substring(0, 80)}…"`);
  } catch (err) {
    logger.error('Groq Whisper transcription error:', err.message);
    transcript = '[Transcription failed — please listen to original audio]';
  }

  emitStage(io, studentId, 'transcribe', 'done');

  // ── Stage 2: Summarize with Groq Llama-3 ───────────────────
  emitStage(io, studentId, 'summarize', 'running');

  // Estimate duration from file size (OGG ~4 KB/s)
  const stats          = fs.statSync(filePath);
  const estimatedSecs  = Math.max(1, Math.round(stats.size / 4000));
  const duration       = formatDuration(estimatedSecs);

  let summary = '', actionItemsText = '', tags = '', urgency = 'low', sentiment = 'neutral';

  try {
    const senderLabel =
      senderType === 'edoofa'  ? 'Edoofa Counselor' :
      senderType === 'student' ? 'Student' : 'Parent/Guardian';

    logger.info(`🤖 Summarizing with Groq ${CHAT_MODEL}…`);

    const completion = await groq.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.2,
      max_tokens: 512,
      messages: [
        {
          role: 'system',
          content: `You are an AI assistant for Edoofa, an Indian study-abroad consulting company.
You analyze WhatsApp voice note transcripts sent in individual student groups.
Groups contain: the student, their parents, and Edoofa counselors.
Your job: extract structured information to help the operations team track student progress.
Respond ONLY with valid JSON — no extra text, no markdown code blocks.`,
        },
        {
          role: 'user',
          content: `Analyze this voice note transcript:

Sender: ${senderLabel} (${senderName})
Student: ${student.name} (ID: ${studentId})
Counselor: ${student.counselor || 'Not assigned'}
Date: ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}

Transcript:
"${transcript}"

Respond with exactly this JSON structure:
{
  "summary": "2-3 sentence summary of what was communicated",
  "action_items": ["Action 1", "Action 2"],
  "tags": ["tag1", "tag2"],
  "urgency": "low|medium|high",
  "sentiment": "positive|neutral|concerned|urgent"
}`,
        },
      ],
    });

    const raw     = completion.choices[0]?.message?.content?.trim() || '{}';
    // Strip markdown code fences if Llama adds them
    const jsonStr = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed  = JSON.parse(jsonStr);

    summary         = parsed.summary       || '';
    actionItemsText = (parsed.action_items || []).join(' | ');
    tags            = (parsed.tags         || []).join(', ');
    urgency         = parsed.urgency       || 'low';
    sentiment       = parsed.sentiment     || 'neutral';

    logger.info(`✅ Summary: "${summary.substring(0, 80)}…"`);
  } catch (err) {
    logger.error('Groq Llama summarization error:', err.message);
    summary = transcript.length > 10
      ? transcript.substring(0, 200) + (transcript.length > 200 ? '…' : '')
      : 'Summary unavailable';
  }

  emitStage(io, studentId, 'summarize', 'done');
  emitStage(io, studentId, 'store', 'running');

  // ── Stage 3: Sequential note numbering ─────────────────────
  const noteCount  = db.prepare(`
    SELECT COUNT(*) AS c FROM voice_notes
    WHERE student_id = ? AND date(created_at) = date('now')
  `).get(studentId);
  const noteNumber = noteCount.c + 1;

  // ── Stage 4: Store to SQLite ────────────────────────────────
  const insertResult = db.prepare(`
    INSERT INTO voice_notes
      (student_id, note_number, sender_type, sender_name, sender_phone,
       transcript, summary, action_items, tags, duration, audio_path, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    studentId, noteNumber, senderType, senderName, senderPhone || null,
    transcript, summary, actionItemsText, tags, duration, filePath, source
  );
  const noteId = insertResult.lastInsertRowid;

  // Store individual action items for the action-items tab
  const insertAction = db.prepare(
    'INSERT INTO action_items (student_id, voice_note_id, action) VALUES (?, ?, ?)'
  );
  actionItemsText.split(' | ')
    .map(a => a.trim())
    .filter(Boolean)
    .forEach(action => insertAction.run(studentId, noteId, action));

  emitStage(io, studentId, 'store', 'done');
  emitStage(io, studentId, 'sheets', 'running');

  // ── Stage 5: Sync to Google Sheets ─────────────────────────
  const noteData = {
    id:           noteId,
    student_id:   studentId,
    student_name: student.name,
    note_number:  noteNumber,
    sender_type:  senderType,
    sender_name:  senderName,
    transcript,
    summary,
    action_items: actionItemsText,
    tags,
    duration,
    urgency,
    sentiment,
    counselor:    student.counselor,
    created_at:   new Date().toISOString(),
  };

  try {
    await sheetsModule.appendRow(noteData);
    db.prepare('UPDATE voice_notes SET sheets_synced = 1 WHERE id = ?').run(noteId);
    logger.info('📊 Row appended to Google Sheets');
  } catch (err) {
    logger.warn(`Sheets sync failed (will retry on next manual sync): ${err.message}`);
  }

  emitStage(io, studentId, 'sheets', 'done');
  return noteData;
}

// ── Helpers ───────────────────────────────────────────────────
function emitStage(io, studentId, stage, status) {
  if (!io) return;
  io.emit('pipeline_stage', { studentId, stage, status, ts: Date.now() });
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

module.exports = { processAudioFile };
