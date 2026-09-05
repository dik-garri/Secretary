/**
 * NotesService.gs — CRUD for the Notes sheet (free-form thoughts/facts).
 * Columns: ID | UserID | Note | Tags | CreatedAt
 * The sheet is created lazily so existing deployments need no manual setup.
 */

const NOTE_COL_ = { ID: 0, USER: 1, NOTE: 2, TAGS: 3, CREATED: 4 };
const NOTES_HEADERS_ = ['ID', 'UserID', 'Note', 'Tags', 'CreatedAt'];

function notesSheet_() {
  return ensureSheetExists_(SHEETS.NOTES, NOTES_HEADERS_);
}

function noteFromRow_(row) {
  let created = '';
  const raw = row[NOTE_COL_.CREATED];
  if (raw instanceof Date) {
    created = raw.getFullYear() + '-' + pad2_(raw.getMonth() + 1) + '-' + pad2_(raw.getDate());
  } else if (raw) {
    created = String(raw).substring(0, 10);
  }
  return {
    id: String(row[NOTE_COL_.ID]),
    userId: String(row[NOTE_COL_.USER]),
    note: String(row[NOTE_COL_.NOTE]),
    tags: String(row[NOTE_COL_.TAGS] || ''),
    created: created
  };
}

function createNote_(userId, text, tags) {
  const sheet = notesSheet_();
  const id = newId_('N');
  const nowUtc = Utilities.formatDate(new Date(), 'UTC', "yyyy-MM-dd'T'HH:mm'Z'");
  sheet.appendRow([id, String(userId), String(text).trim(),
    (tags || []).join(', '), nowUtc]);
  return { id: id, note: String(text).trim() };
}

/** All notes of a user, newest first. */
function getNotes_(userId) {
  const rows = getAllRows_(notesSheet_());
  const result = [];
  for (let i = 0; i < rows.length; i++) {
    const n = noteFromRow_(rows[i]);
    if (n.userId === String(userId)) result.push(n);
  }
  return result.reverse();
}

/** Morphology-tolerant search over note text and tags. */
function findNotes_(userId, query) {
  const q = String(query || '').trim();
  const all = getNotes_(userId);
  if (!q) return all;
  return all.filter(function (n) { return fuzzyMatch_(n.note + ' ' + n.tags, q); });
}

/** Hard delete (notes have no status lifecycle). */
function deleteNote_(noteId) {
  const sheet = notesSheet_();
  const rowNum = findRowByValue_(sheet, NOTE_COL_.ID, noteId);
  if (rowNum === -1) return false;
  sheet.deleteRow(rowNum);
  return true;
}
