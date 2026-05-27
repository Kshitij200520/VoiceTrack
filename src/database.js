/**
 * DATABASE — SQLite via better-sqlite3
 * Stores voice notes, students, action items
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs-extra');

let db;

function getDb() {
  if (!db) {
    fs.ensureDirSync('./data');
    db = new Database(path.join('./data', 'voicetrack.db'));
    db.pragma('journal_mode = WAL');
  }
  return db;
}

function initDb() {
  const db = getDb();

  // Students table
  db.exec(`
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      parent_phone TEXT,
      parent_name TEXT,
      counselor TEXT,
      counselor_phone TEXT,
      group_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Voice notes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      note_number INTEGER NOT NULL,
      sender_type TEXT NOT NULL CHECK(sender_type IN ('edoofa','student','parent','unknown')),
      sender_name TEXT,
      sender_phone TEXT,
      transcript TEXT,
      summary TEXT,
      action_items TEXT,
      tags TEXT,
      duration TEXT,
      audio_path TEXT,
      source TEXT DEFAULT 'whatsapp',
      sheets_synced INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(student_id) REFERENCES students(student_id)
    );
  `);

  // Action items table (normalized)
  db.exec(`
    CREATE TABLE IF NOT EXISTS action_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      voice_note_id INTEGER,
      action TEXT NOT NULL,
      resolved INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(student_id) REFERENCES students(student_id)
    );
  `);

  // Create indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_notes_student ON voice_notes(student_id);
    CREATE INDEX IF NOT EXISTS idx_notes_date ON voice_notes(created_at);
    CREATE INDEX IF NOT EXISTS idx_actions_resolved ON action_items(resolved);
  `);

  console.log('✅ Database initialized');
  return db;
}

module.exports = { getDb, initDb };
