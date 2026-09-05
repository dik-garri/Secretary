/**
 * TaskService.gs — CRUD for the Tasks sheet.
 * Columns: ID | UserID | Task | Status | Priority | DueDate | CreatedAt
 * Status: TODO | DONE | DELETED. Priority: HIGH | NORMAL | LOW.
 * DueDate: 'YYYY-MM-DD' text.
 */

const TASK_COL_ = { ID: 0, USER: 1, TASK: 2, STATUS: 3, PRIORITY: 4, DUE: 5, CREATED: 6 };
const TASK_PRIORITY_ORDER_ = { HIGH: 0, NORMAL: 1, LOW: 2 };

function normalizePriority_(p) {
  const up = String(p || '').toUpperCase();
  return TASK_PRIORITY_ORDER_.hasOwnProperty(up) ? up : 'NORMAL';
}

/** Normalize an AI task item (string or {text, priority, due}) — pure. */
function normalizeTaskItem_(item) {
  const text = String(item && item.text != null ? item.text : (item || '')).trim();
  if (!text) return null;
  const due = item && /^\d{4}-\d{2}-\d{2}$/.test(String(item.due || '')) ? String(item.due) : '';
  return { text: text, priority: normalizePriority_(item && item.priority), due: due };
}

function taskFromRow_(row) {
  let due = '';
  const rawDue = row[TASK_COL_.DUE];
  if (rawDue instanceof Date) {
    due = rawDue.getFullYear() + '-' + pad2_(rawDue.getMonth() + 1) + '-' + pad2_(rawDue.getDate());
  } else if (rawDue) {
    due = String(rawDue).substring(0, 10);
  }
  return {
    id: String(row[TASK_COL_.ID]),
    userId: String(row[TASK_COL_.USER]),
    task: String(row[TASK_COL_.TASK]),
    status: String(row[TASK_COL_.STATUS]),
    priority: normalizePriority_(row[TASK_COL_.PRIORITY]),
    dueDate: due
  };
}

/** Create tasks from AI items (strings or objects). Returns created items. */
function createTasks_(userId, items) {
  const sheet = getSheet_(SHEETS.TASKS);
  const nowUtc = Utilities.formatDate(new Date(), 'UTC', "yyyy-MM-dd'T'HH:mm'Z'");
  const created = [];
  for (let i = 0; i < items.length; i++) {
    const it = normalizeTaskItem_(items[i]);
    if (!it) continue;
    sheet.appendRow([newId_('T'), String(userId), it.text, 'TODO', it.priority, it.due, nowUtc]);
    created.push(it);
  }
  return created;
}

/** Open tasks, HIGH first, then insertion order. */
function getOpenTasks_(userId) {
  const rows = getAllRows_(getSheet_(SHEETS.TASKS));
  const result = [];
  for (let i = 0; i < rows.length; i++) {
    const t = taskFromRow_(rows[i]);
    if (t.userId === String(userId) && t.status === 'TODO') result.push(t);
  }
  result.sort(function (a, b) {
    return TASK_PRIORITY_ORDER_[a.priority] - TASK_PRIORITY_ORDER_[b.priority];
  });
  return result;
}

/** Same morphology-tolerant matching as findReminders_. */
function findTasks_(userId, query) {
  const q = String(query || '').trim();
  const open = getOpenTasks_(userId);
  if (!q) return open;
  return open.filter(function (t) { return fuzzyMatch_(t.task, q); });
}

function setTaskStatus_(taskId, status) {
  const sheet = getSheet_(SHEETS.TASKS);
  const rowNum = findRowByValue_(sheet, TASK_COL_.ID, taskId);
  if (rowNum === -1) return false;
  sheet.getRange(rowNum, TASK_COL_.STATUS + 1).setValue(status);
  return true;
}

function completeTask_(taskId) { return setTaskStatus_(taskId, 'DONE'); }
function deleteTask_(taskId) { return setTaskStatus_(taskId, 'DELETED'); }

/** Update priority and/or due date of a task. fields: {priority?, due?}. */
function updateTask_(taskId, fields) {
  const sheet = getSheet_(SHEETS.TASKS);
  const rowNum = findRowByValue_(sheet, TASK_COL_.ID, taskId);
  if (rowNum === -1) return false;
  if (fields.priority) {
    sheet.getRange(rowNum, TASK_COL_.PRIORITY + 1).setValue(normalizePriority_(fields.priority));
  }
  if (fields.due && /^\d{4}-\d{2}-\d{2}$/.test(String(fields.due))) {
    sheet.getRange(rowNum, TASK_COL_.DUE + 1).setValue(String(fields.due));
  }
  return true;
}
