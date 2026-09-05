/**
 * TaskService.gs — CRUD for the Tasks sheet.
 * Columns: ID | UserID | Task | Status | Priority | DueDate | CreatedAt
 * Status: TODO | DONE. Priority/DueDate reserved for future intents.
 */

const TASK_COL_ = { ID: 0, USER: 1, TASK: 2, STATUS: 3, PRIORITY: 4, DUE: 5, CREATED: 6 };

function taskFromRow_(row) {
  return {
    id: String(row[TASK_COL_.ID]),
    userId: String(row[TASK_COL_.USER]),
    task: String(row[TASK_COL_.TASK]),
    status: String(row[TASK_COL_.STATUS]),
    priority: row[TASK_COL_.PRIORITY],
    dueDate: row[TASK_COL_.DUE] ? cellToDateTimeString_(row[TASK_COL_.DUE]) : ''
  };
}

/** Create tasks from an array of titles. Returns created titles. */
function createTasks_(userId, titles) {
  const sheet = getSheet_(SHEETS.TASKS);
  const nowUtc = Utilities.formatDate(new Date(), 'UTC', "yyyy-MM-dd'T'HH:mm'Z'");
  const created = [];
  for (let i = 0; i < titles.length; i++) {
    const title = String(titles[i] || '').trim();
    if (!title) continue;
    sheet.appendRow([newId_('T'), String(userId), title, 'TODO', '', '', nowUtc]);
    created.push(title);
  }
  return created;
}

function getOpenTasks_(userId) {
  const rows = getAllRows_(getSheet_(SHEETS.TASKS));
  const result = [];
  for (let i = 0; i < rows.length; i++) {
    const t = taskFromRow_(rows[i]);
    if (t.userId === String(userId) && t.status === 'TODO') result.push(t);
  }
  return result;
}

/** Same morphology-tolerant matching as findReminders_. */
function findTasks_(userId, query) {
  const q = String(query || '').trim();
  const open = getOpenTasks_(userId);
  if (!q) return open;
  return open.filter(function (t) { return fuzzyMatch_(t.task, q); });
}

function completeTask_(taskId) {
  const sheet = getSheet_(SHEETS.TASKS);
  const rowNum = findRowByValue_(sheet, TASK_COL_.ID, taskId);
  if (rowNum === -1) return false;
  sheet.getRange(rowNum, TASK_COL_.STATUS + 1).setValue('DONE');
  return true;
}
