/**
 * GOOGLE SHEETS — Append voice note rows via Google Sheets API v4
 * Uses a Service Account for authentication (no OAuth needed)
 */

const { google } = require('googleapis');
const logger = require('./logger');

let sheets = null;
let sheetsReady = false;

const SHEET_HEADERS = [
  'Date', 'Student ID', 'Student Name', 'Voice Note #',
  'Sender Type', 'Sender Name', 'Duration', 'Transcript',
  'AI Summary', 'Action Items', 'Tags', 'Urgency',
  'Sentiment', 'Counselor', 'Status', 'Timestamp'
];

/** Initialize the Google Sheets connection */
async function initSheet() {
  if (!process.env.GOOGLE_SHEET_ID ||
      !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
      !process.env.GOOGLE_PRIVATE_KEY) {
    throw new Error('Google Sheets credentials not configured in .env');
  }

  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheets = google.sheets({ version: 'v4', auth });

  // Check if headers exist, add them if not
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Sheet1!A1:P1',
  });

  const existingHeaders = response.data.values?.[0] || [];
  if (existingHeaders.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A1',
      valueInputOption: 'RAW',
      requestBody: { values: [SHEET_HEADERS] },
    });

    // Format header row
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      requestBody: {
        requests: [{
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.18, green: 0.18, blue: 0.29 },
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat)',
          },
        }],
      },
    });
  }

  sheetsReady = true;
  logger.info('✅ Google Sheets initialized with headers');
}

/** Append a single voice note row to the sheet */
async function appendRow(note) {
  if (!sheetsReady || !sheets) {
    try {
      await initSheet();
    } catch (e) {
      logger.warn('Sheets not ready and initialization failed — skipping append: ' + e.message);
      return;
    }
  }

  const date = new Date(note.created_at);

  const senderTypeLabel = note.sender_type === 'edoofa' ? 'Edoofa Team' :
                          note.sender_type === 'student' ? 'Student' :
                          note.sender_type === 'parent'  ? 'Parent' : 'Unknown';

  const row = [
    date.toLocaleDateString('en-IN'),        // Date
    note.student_id,                          // Student ID
    note.student_name,                        // Student Name
    note.note_number,                         // Voice Note #
    senderTypeLabel,                          // Sender Type
    note.sender_name,                         // Sender Name
    note.duration || '',                      // Duration
    note.transcript || '',                    // Transcript
    note.summary || '',                       // AI Summary
    note.action_items || '',                  // Action Items
    note.tags || '',                          // Tags
    note.urgency || 'low',                    // Urgency
    note.sentiment || 'neutral',              // Sentiment
    note.counselor || '',                     // Counselor
    'Processed',                              // Status
    date.toLocaleTimeString('en-IN'),         // Timestamp
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Sheet1!A:P',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });

  // Color-code the row based on sender type
  try {
    const sheetMeta = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:A',
    });
    const lastRow = (sheetMeta.data.values?.length || 1) - 1;

    const color = note.sender_type === 'edoofa'  ? { red: 0.49, green: 0.23, blue: 0.93, alpha: 0.15 } :
                  note.sender_type === 'student' ? { red: 0.02, green: 0.59, blue: 0.41, alpha: 0.15 } :
                                                   { red: 0.15, green: 0.39, blue: 0.92, alpha: 0.15 };

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      requestBody: {
        requests: [{
          repeatCell: {
            range: { sheetId: 0, startRowIndex: lastRow, endRowIndex: lastRow + 1 },
            cell: { userEnteredFormat: { backgroundColor: color } },
            fields: 'userEnteredFormat.backgroundColor',
          },
        }],
      },
    });
  } catch (e) {
    // Color formatting is optional — don't fail the whole thing
    logger.warn('Sheet color formatting failed:', e.message);
  }
}

/** Sync all unsynced notes from DB to Sheets */
async function syncAllPending() {
  if (!sheetsReady || !sheets) {
    await initSheet();
  }

  const { getDb } = require('./database');
  const db = getDb();

  const pending = db.prepare(`
    SELECT n.*, s.name as student_name, s.counselor
    FROM voice_notes n
    JOIN students s ON n.student_id = s.student_id
    WHERE n.sheets_synced = 0
    ORDER BY n.created_at ASC
  `).all();

  let synced = 0;
  for (const note of pending) {
    try {
      await appendRow(note);
      db.prepare('UPDATE voice_notes SET sheets_synced = 1 WHERE id = ?').run(note.id);
      synced++;
    } catch (e) {
      logger.error('Failed to sync note ' + note.id + ':', e.message);
    }
  }

  return synced;
}

module.exports = { initSheet, appendRow, syncAllPending };

