/**
 * ReminderService.gs — CRUD for the Reminders sheet.
 * Columns: ID | UserID | Text | DateTime | Recurrence | Status | CreatedAt | LastSent
 * Status: PENDING | SENT | CANCELLED. Recurring reminders stay PENDING —
 * the scheduler advances DateTime to the next occurrence after each send.
 */

const REM_COL_ = { ID: 0, USER: 1, TEXT: 2, DATETIME: 3, RECURRENCE: 4, STATUS: 5, CREATED: 6, LAST_SENT: 7 };

function reminderFromRow_(row) {
  let recurrence = null;
  if (row[REM_COL_.RECURRENCE]) {
    try { recurrence = JSON.parse(row[REM_COL_.RECURRENCE]); } catch (e) { recurrence = null; }
  }
  return {
    id: String(row[REM_COL_.ID]),
    userId: String(row[REM_COL_.USER]),
    text: String(row[REM_COL_.TEXT]),
    dateTime: cellToDateTimeString_(row[REM_COL_.DATETIME]),
    recurrence: recurrence,
    status: String(row[REM_COL_.STATUS]),
    lastSent: cellToDateTimeString_(row[REM_COL_.LAST_SENT])
  };
}

/**
 * Create a reminder. dateTimeStr: 'yyyy-MM-dd HH:mm' (first/only firing),
 * recurrence: object or null. Returns the created reminder.
 */
function createReminder_(userId, text, dateTimeStr, recurrence) {
  const sheet = getSheet_(SHEETS.REMINDERS);
  const id = newId_('R');
  const nowUtc = Utilities.formatDate(new Date(), 'UTC', "yyyy-MM-dd'T'HH:mm'Z'");
  sheet.appendRow([
    id, String(userId), text, dateTimeStr,
    recurrence ? JSON.stringify(recurrence) : '',
    'PENDING', nowUtc, ''
  ]);
  return { id: id, userId: String(userId), text: text, dateTime: dateTimeStr, recurrence: recurrence, status: 'PENDING' };
}

/** Active (PENDING) reminders of a user, sorted by next firing time. */
function getActiveReminders_(userId, tz) {
  const rows = getAllRows_(getSheet_(SHEETS.REMINDERS));
  const result = [];
  for (let i = 0; i < rows.length; i++) {
    const r = reminderFromRow_(rows[i]);
    if (r.userId === String(userId) && r.status === 'PENDING') result.push(r);
  }
  result.sort(function (a, b) {
    return (parseDateTimeInTz_(a.dateTime, tz) || 0) - (parseDateTimeInTz_(b.dateTime, tz) || 0);
  });
  return result;
}

/**
 * Case-insensitive substring match of query words against reminder text.
 * Returns matching active reminders.
 */
function findReminders_(userId, tz, query) {
  const q = String(query || '').toLowerCase().trim();
  const active = getActiveReminders_(userId, tz);
  if (!q) return active;
  return active.filter(function (r) {
    const text = r.text.toLowerCase();
    const words = q.split(/\s+/).filter(function (w) { return w.length > 2; });
    if (!words.length) return text.indexOf(q) !== -1;
    return words.every(function (w) { return text.indexOf(w) !== -1; });
  });
}

function cancelReminder_(reminderId) {
  const sheet = getSheet_(SHEETS.REMINDERS);
  const rowNum = findRowByValue_(sheet, REM_COL_.ID, reminderId);
  if (rowNum === -1) return false;
  sheet.getRange(rowNum, REM_COL_.STATUS + 1).setValue('CANCELLED');
  return true;
}

/**
 * Scheduler helper: claim a reminder BEFORE sending by stamping LastSent.
 * Combined with DUPLICATE_SEND_GUARD_MS this guarantees at most one send
 * attempt per guard window, even if later row updates fail.
 */
function claimReminder_(reminderId, tz) {
  const sheet = getSheet_(SHEETS.REMINDERS);
  const rowNum = findRowByValue_(sheet, REM_COL_.ID, reminderId);
  if (rowNum === -1) return false;
  sheet.getRange(rowNum, REM_COL_.LAST_SENT + 1)
    .setValue(formatTz_(Date.now(), tz, 'yyyy-MM-dd HH:mm'));
  return true;
}

/** Scheduler helper: after a successful send — advance recurring, close one-off. */
function markReminderFired_(reminderId, tz) {
  const sheet = getSheet_(SHEETS.REMINDERS);
  const rowNum = findRowByValue_(sheet, REM_COL_.ID, reminderId);
  if (rowNum === -1) return;
  const row = sheet.getRange(rowNum, 1, 1, 8).getValues()[0];
  const r = reminderFromRow_(row);

  if (r.recurrence) {
    const next = nextOccurrence_(r.recurrence, Date.now(), tz);
    if (next) {
      sheet.getRange(rowNum, REM_COL_.DATETIME + 1).setValue(next);
    } else {
      sheet.getRange(rowNum, REM_COL_.STATUS + 1).setValue('SENT'); // broken recurrence — stop looping
    }
  } else {
    sheet.getRange(rowNum, REM_COL_.STATUS + 1).setValue('SENT');
  }
}

/** Scheduler helper: permanent delivery failure (blocked bot etc.). */
function markReminderError_(reminderId) {
  const sheet = getSheet_(SHEETS.REMINDERS);
  const rowNum = findRowByValue_(sheet, REM_COL_.ID, reminderId);
  if (rowNum === -1) return;
  sheet.getRange(rowNum, REM_COL_.STATUS + 1).setValue('ERROR');
}
