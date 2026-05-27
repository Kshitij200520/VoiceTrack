/**
 * EDOOFA VOICETRACK — LIVE FRONTEND APP
 * Connects to real backend APIs + Socket.IO
 */

const socket = io();
let allStudents = [];
let notesOffset = 0;
const NOTES_LIMIT = 10;

// ── SOCKET.IO EVENTS ──────────────────────────────────────────
socket.on('connect', () => console.log('✅ Connected to server'));

socket.on('status', (status) => {
  updateWaStatus(status);
});

socket.on('qr', (qrDataUrl) => {
  showQR(qrDataUrl);
});

socket.on('wa_ready', (info) => {
  showConnected(info);
  updateWaStatus({ connected: true, name: info.name });
});

socket.on('note_processing', (data) => {
  showNotif(`🎙️ Processing voice note for ${data.studentName} (${data.senderType})…`);
});

socket.on('note_complete', (note) => {
  showNotif(`✅ New note processed: ${note.student_name} — Note #${note.note_number}`);
  addLiveFeedItem(note);
  refreshDashboard();
});

// ── WHATSAPP STATUS ───────────────────────────────────────────
function updateWaStatus(status) {
  const dot  = document.getElementById('waDot');
  const text = document.getElementById('waStatusText');
  const ind  = document.getElementById('waStatusIndicator');
  if (status.connected) {
    dot.className = 'status-dot connected';
    text.textContent = status.name ? `${status.name}` : 'WhatsApp Connected';
    ind.style.color = '#34d399';
  } else {
    dot.className = 'status-dot error';
    text.textContent = 'WhatsApp Disconnected';
    ind.style.color = '#f87171';
  }
}

// ── NOTIFICATION BAR ─────────────────────────────────────────
let notifTimer;
function showNotif(text) {
  const bar = document.getElementById('notifBar');
  document.getElementById('notifText').textContent = text;
  bar.style.display = 'flex';
  clearTimeout(notifTimer);
  notifTimer = setTimeout(() => bar.style.display = 'none', 6000);
}

// ── TAB SWITCHING ─────────────────────────────────────────────
function switchTab(tab, el) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  if (el) el.classList.add('active');
  const names = { dashboard:'Dashboard', connect:'WhatsApp Connect', students:'Students',
                  notes:'Voice Notes', actions:'Action Items', upload:'Manual Upload' };
  document.getElementById('breadcrumb').textContent = names[tab] || tab;

  // Load data for each tab
  if (tab === 'dashboard')  refreshDashboard();
  if (tab === 'connect')    pollQR();
  if (tab === 'students')   loadStudents();
  if (tab === 'notes')      loadNotes();
  if (tab === 'actions')    loadActions(0);
  if (tab === 'upload')     populateStudentSelect();
}

// ── DASHBOARD ─────────────────────────────────────────────────
async function refreshDashboard() {
  try {
    const [statusRes, notesRes, actionsRes] = await Promise.all([
      fetch('/api/status').then(r => r.json()),
      fetch('/api/notes?limit=5').then(r => r.json()),
      fetch('/api/actions?resolved=0').then(r => r.json()),
    ]);

    // Stats
    document.getElementById('statNotes').textContent    = statusRes.notes_today || 0;
    document.getElementById('statStudents').textContent = statusRes.total_students || 0;
    document.getElementById('statActions').textContent  = statusRes.pending_actions || 0;
    document.getElementById('statUptime').textContent   = formatUptime(statusRes.uptime || 0);

    // Subtitle
    document.getElementById('dashSubtitle').textContent =
      `Today (${new Date().toLocaleDateString('en-IN')}) — ${statusRes.notes_today || 0} voice notes processed`;

    // Live feed
    const feed = document.getElementById('liveFeed');
    if (notesRes.notes && notesRes.notes.length > 0) {
      feed.innerHTML = notesRes.notes.map(n => buildFeedItem(n)).join('');
    }

    // Pending actions
    const pane = document.getElementById('pendingActions');
    if (actionsRes && actionsRes.length > 0) {
      pane.innerHTML = actionsRes.slice(0, 6).map(a => `
        <div class="action-item-row" id="action-${a.id}">
          <span>⏰</span>
          <div>
            <strong style="font-size:12px">${a.student_name}</strong>
            <div style="font-size:11px;color:var(--text-muted)">${a.action}</div>
          </div>
          <button class="resolve-btn" onclick="resolveAction(${a.id})">✓ Done</button>
        </div>
      `).join('');
    } else {
      pane.innerHTML = '<div style="text-align:center;color:var(--green-soft);padding:20px;font-size:13px">✅ All actions resolved!</div>';
    }
  } catch (e) {
    console.error('Dashboard refresh failed:', e);
  }
}

function buildFeedItem(n) {
  const color = n.sender_type === 'edoofa' ? '#7c3aed' : n.sender_type === 'student' ? '#059669' : '#2563eb';
  const emoji = n.sender_type === 'edoofa' ? '🎓' : n.sender_type === 'parent' ? '👨‍👩‍👦' : '👤';
  const label = n.sender_type === 'edoofa' ? 'Edoofa' : n.sender_type === 'student' ? 'Student' : 'Parent';
  const time  = new Date(n.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const preview = (n.summary || n.transcript || '').substring(0, 60) + '…';
  return `
    <div class="activity-item" onclick="openStudentModal('${n.student_id}', '${n.student_name}')">
      <div class="activity-avatar" style="background:${color}22;color:${color}">${emoji}</div>
      <div class="activity-info">
        <div class="activity-name">${n.student_name} <span class="badge badge-${n.sender_type}" style="font-size:10px">${label}</span></div>
        <div class="activity-preview">${preview}</div>
      </div>
      <div class="activity-meta">
        <div class="activity-time">${time}</div>
        <div style="font-size:10px;color:var(--text-muted)">#${n.note_number}</div>
      </div>
    </div>`;
}

function addLiveFeedItem(note) {
  const feed = document.getElementById('liveFeed');
  const placeholder = feed.querySelector('div[style]');
  if (placeholder) placeholder.remove();
  feed.insertAdjacentHTML('afterbegin', buildFeedItem(note));
}

// ── QR CODE ───────────────────────────────────────────────────
let qrPoller;

async function pollQR() {
  clearInterval(qrPoller);
  try {
    const data = await fetch('/api/qr').then(r => r.json());
    if (data.status === 'connected') {
      showConnected({});
    } else if (data.qr) {
      showQR(data.qr);
    } else {
      document.getElementById('qrSpinner').style.display = 'block';
      document.getElementById('qrImageWrap').style.display = 'none';
      document.getElementById('qrConnected').style.display = 'none';
    }
    if (data.status !== 'connected') {
      qrPoller = setInterval(pollQR, 3000);
    }
  } catch (e) {
    console.error('QR poll error:', e);
    qrPoller = setInterval(pollQR, 5000);
  }
}

function showQR(qrDataUrl) {
  clearInterval(qrPoller);
  document.getElementById('qrSpinner').style.display = 'none';
  document.getElementById('qrConnected').style.display = 'none';
  document.getElementById('qrImageWrap').style.display = 'block';
  document.getElementById('qrImage').src = qrDataUrl;
  qrPoller = setInterval(pollQR, 30000); // Refresh if not scanned
}

function showConnected(info) {
  clearInterval(qrPoller);
  document.getElementById('qrSpinner').style.display = 'none';
  document.getElementById('qrImageWrap').style.display = 'none';
  document.getElementById('qrConnected').style.display = 'flex';
  if (info.name || info.phone) {
    document.getElementById('connectedPhone').textContent =
      `Logged in as: ${info.name || ''} ${info.phone ? '(+' + info.phone + ')' : ''}`;
  }
}

// ── STUDENTS ─────────────────────────────────────────────────
async function loadStudents() {
  const tbody = document.getElementById('studentsBody');
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:30px">Loading…</td></tr>';
  try {
    allStudents = await fetch('/api/students').then(r => r.json());
    renderStudents(allStudents);
    // Populate upload dropdown
    populateStudentSelect();
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--red);padding:30px">Error loading students</td></tr>';
  }
}

function renderStudents(students) {
  const tbody = document.getElementById('studentsBody');
  if (!students.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:30px">No students yet — add your first student</td></tr>';
    return;
  }
  tbody.innerHTML = students.map(s => `
    <tr>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-muted)">${s.student_id}</td>
      <td style="font-weight:600;color:var(--text-primary)">${s.name}</td>
      <td style="font-size:12px">${s.phone || '—'}</td>
      <td style="font-size:12px">${s.counselor || '—'}</td>
      <td><span style="background:var(--purple-dim);color:var(--purple-soft);padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600">${s.notes_today || 0}</span></td>
      <td><span class="${s.pending_actions > 0 ? 'badge badge-pending' : 'badge badge-done'}">${s.pending_actions || 0}</span></td>
      <td>
        <button class="btn-ghost btn-sm" onclick="openStudentModal('${s.student_id}', '${s.name}')">Timeline →</button>
      </td>
    </tr>
  `).join('');
}

function filterStudents(q) {
  const filtered = allStudents.filter(s =>
    s.name.toLowerCase().includes(q.toLowerCase()) ||
    s.student_id.toLowerCase().includes(q.toLowerCase()) ||
    (s.counselor || '').toLowerCase().includes(q.toLowerCase())
  );
  renderStudents(filtered);
}

async function openStudentModal(studentId, studentName) {
  document.getElementById('modalStudentName').textContent = studentName;
  document.getElementById('modalStudentId').textContent = studentId;
  document.getElementById('studentModal').style.display = 'flex';
  document.getElementById('modalTimeline').innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px">Loading…</div>';

  try {
    const notes = await fetch('/api/notes/' + studentId).then(r => r.json());
    if (!notes.length) {
      document.getElementById('modalTimeline').innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px">No voice notes yet for this student</div>';
      return;
    }
    document.getElementById('modalTimeline').innerHTML = notes.map(n => {
      const label = n.sender_type === 'edoofa' ? 'Edoofa Team' : n.sender_type === 'student' ? 'Student' : 'Parent';
      const emoji = n.sender_type === 'edoofa' ? '🎓' : n.sender_type === 'parent' ? '👨‍👩‍👦' : '👤';
      const actions = (n.action_items || '').split(' | ').filter(Boolean);
      const time = new Date(n.created_at).toLocaleTimeString('en-IN', {hour:'2-digit',minute:'2-digit'});
      return `
        <div class="timeline-item">
          <div class="timeline-dot dot-${n.sender_type}">${emoji}</div>
          <div class="timeline-content">
            <div class="timeline-header">
              <span class="timeline-name">${n.sender_name || label}</span>
              <span class="badge badge-${n.sender_type}">${label}</span>
              <span class="timeline-num">Note #${n.note_number}</span>
              <span class="timeline-time">${time} · ${n.duration || ''}</span>
            </div>
            <div class="timeline-transcript">"${n.transcript || 'No transcript'}"</div>
            ${n.summary ? `<div class="timeline-summary">🤖 ${n.summary}</div>` : ''}
            ${actions.length ? `<div class="record-actions-row" style="margin-top:6px">${actions.map(a=>`<span class="action-chip" style="font-size:10px">⏰ ${a}</span>`).join('')}</div>` : ''}
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    document.getElementById('modalTimeline').innerHTML = '<div style="color:var(--red);padding:20px">Error loading timeline</div>';
  }
}

function showAddStudent() {
  document.getElementById('addStudentForm').reset();
  document.getElementById('addStudentModal').style.display = 'flex';
}

async function saveStudent(e) {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  try {
    const res = await fetch('/api/students', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(await res.text());
    document.getElementById('addStudentModal').style.display = 'none';
    showNotif('✅ Student saved: ' + data.name);
    loadStudents();
  } catch (e) {
    alert('Error saving student: ' + e.message);
  }
}

// ── VOICE NOTES ───────────────────────────────────────────────
async function loadNotes(reset = true) {
  if (reset) notesOffset = 0;
  const sender = document.getElementById('senderFilter').value;
  const search = document.getElementById('noteSearch').value;

  let url = `/api/notes?limit=${NOTES_LIMIT}&offset=${notesOffset}`;
  if (sender) url += `&sender=${sender}`;

  const container = document.getElementById('notesList');
  if (reset) container.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:40px">Loading…</div>';

  try {
    const data = await fetch(url).then(r => r.json());
    let notes = data.notes || [];

    if (search) {
      notes = notes.filter(n =>
        (n.transcript||'').toLowerCase().includes(search.toLowerCase()) ||
        (n.summary||'').toLowerCase().includes(search.toLowerCase()) ||
        (n.student_name||'').toLowerCase().includes(search.toLowerCase())
      );
    }

    if (reset) container.innerHTML = '';

    if (!notes.length && reset) {
      container.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:40px">No voice notes yet. Connect WhatsApp or use Manual Upload to get started.</div>';
      document.getElementById('loadMoreBtn').style.display = 'none';
      return;
    }

    notes.forEach(n => container.insertAdjacentHTML('beforeend', buildNoteCard(n)));

    const hasMore = data.total > notesOffset + NOTES_LIMIT;
    document.getElementById('loadMoreBtn').style.display = hasMore ? 'inline-block' : 'none';
  } catch (e) {
    container.innerHTML = '<div style="color:var(--red);padding:40px;text-align:center">Error loading notes</div>';
  }
}

function buildNoteCard(n) {
  const label  = n.sender_type === 'edoofa' ? 'Edoofa Team' : n.sender_type === 'student' ? 'Student' : 'Parent';
  const time   = new Date(n.created_at).toLocaleString('en-IN');
  const date   = new Date(n.created_at).toLocaleDateString('en-IN');
  const actions = (n.action_items || '').split(' | ').filter(Boolean);
  const tags   = (n.tags || '').split(',').filter(Boolean);
  return `
    <div class="record-card">
      <div class="record-top">
        <div>
          <div class="record-student">${n.student_name}</div>
          <div class="record-meta">
            <span>${n.student_id}</span><span>•</span>
            <span>Note #${n.note_number}</span><span>•</span>
            <span>${date}</span><span>•</span>
            <span>${new Date(n.created_at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}</span>
            ${n.duration ? `<span>•</span><span>⏱ ${n.duration}</span>` : ''}
            ${n.counselor ? `<span>•</span><span>👤 ${n.counselor}</span>` : ''}
          </div>
        </div>
        <div class="record-badges">
          <span class="badge badge-${n.sender_type}">${label}</span>
          <span style="font-size:11px;color:var(--text-muted)">${n.sender_name || ''}</span>
        </div>
      </div>
      <div class="record-transcript">"${n.transcript || 'Transcript not available'}"</div>
      ${n.summary ? `<div class="record-summary"><strong>🤖 AI Summary:</strong> ${n.summary}</div>` : ''}
      ${actions.length ? `<div class="record-actions-row">${actions.map(a=>`<span class="action-chip">⏰ ${a}</span>`).join('')}</div>` : ''}
      ${tags.length ? `<div style="margin-top:8px;display:flex;gap:4px;flex-wrap:wrap">${tags.map(t=>`<span style="background:rgba(255,255,255,.05);border:1px solid var(--border);color:var(--text-muted);font-size:10px;padding:2px 8px;border-radius:20px">#${t.trim()}</span>`).join('')}</div>` : ''}
    </div>`;
}

async function loadMoreNotes() {
  notesOffset += NOTES_LIMIT;
  await loadNotes(false);
}

function searchNotes(q) {
  loadNotes(true);
}

// ── ACTION ITEMS ──────────────────────────────────────────────
async function loadActions(resolved = 0) {
  const container = document.getElementById('actionsList');
  container.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:40px">Loading…</div>';
  try {
    const items = await fetch(`/api/actions?resolved=${resolved}`).then(r => r.json());
    if (!items.length) {
      container.innerHTML = `<div style="text-align:center;color:var(--${resolved?'text-muted':'green-soft'});padding:40px">${resolved ? 'No resolved actions' : '✅ No pending actions!'}</div>`;
      return;
    }
    container.innerHTML = items.map(a => {
      const date = new Date(a.created_at).toLocaleDateString('en-IN');
      return `
        <div class="action-item-row" id="action-${a.id}" style="${resolved ? 'opacity:0.6' : ''}">
          <span>${resolved ? '✅' : '⏰'}</span>
          <div style="flex:1">
            <strong style="font-size:12px">${a.student_name}</strong>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">${a.action}</div>
            <div style="font-size:10px;color:var(--text-muted);margin-top:2px">${date}</div>
          </div>
          ${!resolved ? `<button class="resolve-btn" onclick="resolveAction(${a.id})">✓ Mark Done</button>` : ''}
        </div>`;
    }).join('');
  } catch (e) {
    container.innerHTML = '<div style="color:var(--red);padding:40px;text-align:center">Error loading actions</div>';
  }
}

async function resolveAction(id) {
  try {
    await fetch(`/api/actions/${id}/resolve`, { method: 'PATCH' });
    const el = document.getElementById('action-' + id);
    if (el) {
      el.style.opacity = '0.4';
      setTimeout(() => el.remove(), 500);
    }
    refreshDashboard();
  } catch (e) {
    console.error('Resolve error:', e);
  }
}

// ── MANUAL UPLOAD ─────────────────────────────────────────────
function populateStudentSelect() {
  const sel = document.getElementById('uploadStudentId');
  if (!sel) return;
  if (!allStudents.length) {
    fetch('/api/students').then(r => r.json()).then(students => {
      allStudents = students;
      populateStudentSelect();
    });
    return;
  }
  sel.innerHTML = '<option value="">Select student…</option>' +
    allStudents.map(s => `<option value="${s.student_id}">${s.name} (${s.student_id})</option>`).join('');
}

async function uploadAudio(e) {
  e.preventDefault();
  const form = e.target;
  const btn  = document.getElementById('uploadBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Processing…';

  const formData = new FormData(form);
  try {
    const res  = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Upload failed');

    const note = data.note;
    const actions = (note.action_items || '').split(' | ').filter(Boolean);

    document.getElementById('uploadResult').style.display = 'block';
    document.getElementById('uploadResultContent').innerHTML = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="font-size:13px;color:var(--text-secondary)"><strong>Student:</strong> ${note.student_name}</div>
        <div style="font-size:13px;color:var(--text-secondary)"><strong>Note #:</strong> ${note.note_number}</div>
        <div style="font-size:13px;color:var(--text-secondary)"><strong>Sender:</strong> ${note.sender_name}</div>
        <div class="record-transcript">"${note.transcript}"</div>
        <div class="record-summary"><strong>🤖 AI Summary:</strong> ${note.summary}</div>
        ${actions.length ? `<div class="record-actions-row">${actions.map(a=>`<span class="action-chip">⏰ ${a}</span>`).join('')}</div>` : ''}
      </div>`;

    showNotif(`✅ Processed: ${note.student_name} — Note #${note.note_number}`);
    form.reset();
  } catch (err) {
    alert('❌ Error: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🎙️ Upload & Process';
  }
}

// ── GOOGLE SHEETS SYNC ────────────────────────────────────────
async function syncSheets() {
  const btn = document.getElementById('syncBtn');
  btn.textContent = '⏳ Syncing…';
  btn.disabled = true;
  try {
    const res = await fetch('/api/sync-sheets', { method: 'POST' }).then(r => r.json());
    showNotif(`✅ Synced ${res.synced} notes to Google Sheets`);
  } catch (e) {
    showNotif('❌ Sync failed: ' + e.message);
  } finally {
    btn.textContent = '🔄 Sync to Sheets';
    btn.disabled = false;
  }
}

// ── EXPORT CSV ────────────────────────────────────────────────
function exportCSV() {
  window.location.href = '/api/export/csv';
}

// ── GLOBAL SEARCH ─────────────────────────────────────────────
function liveSearch(q) {
  if (q.length > 2) {
    switchTab('notes', document.querySelector('[onclick="switchTab(\'notes\',this)"]'));
    document.getElementById('noteSearch').value = q;
    searchNotes(q);
  }
}

// ── UTILS ─────────────────────────────────────────────────────
function formatUptime(seconds) {
  if (seconds < 60) return Math.floor(seconds) + 's';
  if (seconds < 3600) return Math.floor(seconds/60) + 'm';
  return Math.floor(seconds/3600) + 'h ' + Math.floor((seconds%3600)/60) + 'm';
}

// ── INIT ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  refreshDashboard();
  loadStudents();
  // Auto-refresh dashboard every 30s
  setInterval(refreshDashboard, 30_000);
});
