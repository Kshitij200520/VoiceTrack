/**
 * PHONE MAP — Maps WhatsApp phone numbers to student roles
 * This is the key to identifying who sent each voice note
 */

const { getDb } = require('./database');
const logger = require('./logger');

/**
 * Identify who sent a voice note based on their phone number and group ID
 * Returns: { studentId, studentName, senderType, senderName }
 */
function identifySender(phone, groupId) {
  const db = getDb();

  // Normalize phone (remove country code prefixes, spaces, etc.)
  const normalized = normalizePhone(phone);

  // Search in students table — counselor phone
  const byCounselor = db.prepare(`
    SELECT student_id, name, counselor, counselor_phone
    FROM students
    WHERE replace(replace(counselor_phone, '+', ''), '-', '') LIKE ?
    LIMIT 1
  `).get('%' + normalized.slice(-8));

  if (byCounselor) {
    return {
      studentId:   byCounselor.student_id,
      studentName: byCounselor.name,
      senderType:  'edoofa',
      senderName:  byCounselor.counselor + ' (Counselor)',
    };
  }

  // Search as student
  const byStudent = db.prepare(`
    SELECT student_id, name, counselor
    FROM students
    WHERE replace(replace(phone, '+', ''), '-', '') LIKE ?
    LIMIT 1
  `).get('%' + normalized.slice(-8));

  if (byStudent) {
    return {
      studentId:   byStudent.student_id,
      studentName: byStudent.name,
      senderType:  'student',
      senderName:  byStudent.name,
    };
  }

  // Search as parent
  const byParent = db.prepare(`
    SELECT student_id, name, parent_name, parent_phone
    FROM students
    WHERE replace(replace(parent_phone, '+', ''), '-', '') LIKE ?
    LIMIT 1
  `).get('%' + normalized.slice(-8));

  if (byParent) {
    return {
      studentId:   byParent.student_id,
      studentName: byParent.name,
      senderType:  'parent',
      senderName:  (byParent.parent_name || 'Parent') + ' (Parent)',
    };
  }

  // Unknown
  logger.warn(`Unknown sender: ${phone} in group: ${groupId}`);
  return {
    studentId:   null,
    studentName: null,
    senderType:  'unknown',
    senderName:  phone,
  };
}

function normalizePhone(phone) {
  return phone.replace(/[^0-9]/g, '');
}

/** Add or update a student record */
function addStudent(data) {
  const db = getDb();
  const {
    student_id, name, phone, parent_phone, parent_name,
    counselor, counselor_phone, group_name
  } = data;

  if (!student_id || !name) throw new Error('student_id and name are required');

  db.prepare(`
    INSERT INTO students (student_id, name, phone, parent_phone, parent_name, counselor, counselor_phone, group_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(student_id) DO UPDATE SET
      name = excluded.name,
      phone = excluded.phone,
      parent_phone = excluded.parent_phone,
      parent_name = excluded.parent_name,
      counselor = excluded.counselor,
      counselor_phone = excluded.counselor_phone,
      group_name = excluded.group_name
  `).run(student_id, name, phone || null, parent_phone || null, parent_name || null,
         counselor || null, counselor_phone || null, group_name || null);

  return db.prepare('SELECT * FROM students WHERE student_id = ?').get(student_id);
}

function getAllStudents() {
  const db = getDb();
  const students = db.prepare('SELECT * FROM students ORDER BY name').all();

  // Enrich with note counts
  return students.map(s => {
    const notesToday = db.prepare(
      "SELECT COUNT(*) as c FROM voice_notes WHERE student_id = ? AND date(created_at) = date('now')"
    ).get(s.student_id);
    const pendingActions = db.prepare(
      'SELECT COUNT(*) as c FROM action_items WHERE student_id = ? AND resolved = 0'
    ).get(s.student_id);
    return {
      ...s,
      notes_today: notesToday.c,
      pending_actions: pendingActions.c,
    };
  });
}

/** Seed sample students for demo/testing */
function seedSampleStudents() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as c FROM students').get();
  if (count.c > 0) return; // Already seeded

  const samples = [
    {
      student_id: 'EDU-1001',
      name: 'Aarav Sharma',
      phone: '+919810000001',
      parent_phone: '+919810000002',
      parent_name: 'Mrs. Sharma',
      counselor: 'Priya Nair',
      counselor_phone: '+919900000001',
      group_name: 'Aarav Sharma - Edoofa Group',
    },
    {
      student_id: 'EDU-1042',
      name: 'Sneha Gupta',
      phone: '+919810000042',
      parent_phone: '+919810000043',
      parent_name: 'Mr. Gupta',
      counselor: 'Rahul Mehta',
      counselor_phone: '+919900000002',
      group_name: 'Sneha Gupta - Edoofa Group',
    },
    {
      student_id: 'EDU-1089',
      name: 'Rohit Verma',
      phone: '+919810000089',
      parent_phone: '+919810000090',
      parent_name: 'Mr. Verma',
      counselor: 'Priya Nair',
      counselor_phone: '+919900000001',
      group_name: 'Rohit Verma - Edoofa Group',
    },
    {
      student_id: 'EDU-1155',
      name: 'Arjun Patel',
      phone: '+919810000155',
      parent_phone: '+919810000156',
      parent_name: 'Mr. Patel',
      counselor: 'Rahul Mehta',
      counselor_phone: '+919900000002',
      group_name: 'Arjun Patel - Edoofa Group',
    },
    {
      student_id: 'EDU-1201',
      name: 'Meera Joshi',
      phone: '+919810000201',
      parent_phone: '+919810000202',
      parent_name: 'Mrs. Joshi',
      counselor: 'Amit Singh',
      counselor_phone: '+919900000003',
      group_name: 'Meera Joshi - Edoofa Group',
    },
  ];

  samples.forEach(s => addStudent(s));
  logger.info('🌱 Sample students seeded');
}

module.exports = { identifySender, addStudent, getAllStudents, seedSampleStudents };
