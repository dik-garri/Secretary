/**
 * SheetsService.gs — abstraction over Google Sheets (the database).
 * All other services go through these helpers; nothing else touches
 * SpreadsheetApp directly.
 */

function getSpreadsheet_() {
  // Container-bound script: the bound spreadsheet is the default DB;
  // SPREADSHEET_ID property overrides it (e.g. for a standalone deploy).
  const id = getProp_('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const bound = SpreadsheetApp.getActiveSpreadsheet();
  if (bound) return bound;
  throw new Error('No bound spreadsheet and no SPREADSHEET_ID property');
}

function getSheet_(name) {
  const sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: ' + name + '. Run setup() first.');
  return sheet;
}

/** All data rows (without header) as arrays. */
function getAllRows_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  return sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
}

/** 1-indexed row number where column col (0-indexed) equals value, or -1. */
function findRowByValue_(sheet, col, value) {
  const data = getAllRows_(sheet);
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][col]) === String(value)) return i + 2;
  }
  return -1;
}

/** Compact unique ID: prefix + base36 timestamp + 2 random chars. */
function newId_(prefix) {
  const rand = Math.random().toString(36).substring(2, 4);
  return prefix + Date.now().toString(36).toUpperCase() + rand.toUpperCase();
}

/**
 * setup() entry point — creates all sheets with headers, seeds Models,
 * forces text format on datetime columns so Sheets doesn't coerce our
 * 'yyyy-MM-dd HH:mm' strings into Date objects.
 */
function setup() {
  const ss = getSpreadsheet_();

  function ensure(name, headers) {
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    if (sheet.getLastRow() === 0) sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    return sheet;
  }

  const reminders = ensure(SHEETS.REMINDERS,
    ['ID', 'UserID', 'Text', 'DateTime', 'Recurrence', 'Status', 'CreatedAt', 'LastSent']);
  reminders.getRange('D:D').setNumberFormat('@'); // DateTime as plain text
  reminders.getRange('H:H').setNumberFormat('@'); // LastSent as plain text

  const tasks = ensure(SHEETS.TASKS,
    ['ID', 'UserID', 'Task', 'Status', 'Priority', 'DueDate', 'CreatedAt']);
  tasks.getRange('F:F').setNumberFormat('@');

  ensure(SHEETS.NOTES, ['ID', 'UserID', 'Note', 'Tags', 'CreatedAt']);
  ensure(SHEETS.USERS, ['TelegramID', 'Name', 'Timezone', 'Language', 'Settings']);
  ensure(SHEETS.LOGS, ['Timestamp', 'TelegramID', 'Type', 'Input', 'Intent', 'Model', 'Result', 'Error']);

  const models = ensure(SHEETS.MODELS, ['Model', 'Text', 'Audio', 'Enabled', 'Priority']);
  if (models.getLastRow() <= 1) {
    CONFIG.DEFAULT_MODELS.forEach(function (m) {
      models.appendRow([m.name, m.text, m.audio, true, m.priority]);
    });
  }

  console.log('Sheets initialized. Next: deploy as Web App, put the deployment URL into ' +
    'Script Property WEBAPP_URL, run setWebhook(), then setupTrigger().');
}

/** Get a sheet, creating it with headers if missing (self-healing for
 * sheets added after the initial setup() run, e.g. Notes). */
function ensureSheetExists_(name, headers) {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ===== Users =====

function getUser_(telegramId) {
  const sheet = getSheet_(SHEETS.USERS);
  const data = getAllRows_(sheet);
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]) === String(telegramId)) {
      return {
        telegramId: String(data[i][0]),
        name: data[i][1],
        timezone: data[i][2] || CONFIG.DEFAULT_TIMEZONE,
        language: data[i][3] || CONFIG.DEFAULT_LANGUAGE,
        settings: data[i][4]
      };
    }
  }
  return null;
}

function ensureUser_(telegramId, name) {
  let user = getUser_(telegramId);
  if (user) return user;
  getSheet_(SHEETS.USERS).appendRow(
    [String(telegramId), name || '', CONFIG.DEFAULT_TIMEZONE, CONFIG.DEFAULT_LANGUAGE, '']);
  return getUser_(telegramId);
}

/** Parse the Settings JSON column of a user row ({} on empty/broken). */
function getUserSettings_(user) {
  try { return user.settings ? JSON.parse(user.settings) : {}; } catch (e) { return {}; }
}

function saveUserSettings_(telegramId, settings) {
  const sheet = getSheet_(SHEETS.USERS);
  const rowNum = findRowByValue_(sheet, 0, telegramId);
  if (rowNum !== -1) sheet.getRange(rowNum, 5).setValue(JSON.stringify(settings));
}

// ===== Dialog state (ScriptProperties — webhook runs anonymously,
// UserProperties would be empty) =====

function getState_(chatId) {
  const json = PropertiesService.getScriptProperties().getProperty('state_' + chatId);
  return json ? JSON.parse(json) : null;
}

function setState_(chatId, state) {
  PropertiesService.getScriptProperties().setProperty('state_' + chatId, JSON.stringify(state));
}

function clearState_(chatId) {
  PropertiesService.getScriptProperties().deleteProperty('state_' + chatId);
}
