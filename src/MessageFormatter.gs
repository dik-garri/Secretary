/**
 * MessageFormatter.gs — HTML conversion and intelligent splitting.
 *
 * App code and Gemini both produce "app markdown": plain text where the only
 * markup is **bold**. Everything is HTML-escaped first, then **…** becomes
 * <b>…</b>. This keeps user/AI content from ever injecting HTML.
 */

function escapeHtml_(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function toTelegramHtml_(text) {
  return escapeHtml_(text).replace(/\*\*([^*\n][^*]*?)\*\*/g, '<b>$1</b>');
}

/**
 * Split text into chunks of at most maxLen characters, preferring
 * paragraph boundaries, then line boundaries, then a hard cut.
 * Never cuts mid-word unless a single word exceeds maxLen.
 */
function splitMessage_(text, maxLen) {
  const s = String(text == null ? '' : text);
  if (s.length <= maxLen) return [s];

  const chunks = [];
  let rest = s;
  while (rest.length > maxLen) {
    // Window is one char wider so a boundary exactly at maxLen is found.
    const window = rest.substring(0, maxLen + 1);
    let cut = window.lastIndexOf('\n\n');
    if (cut < maxLen * 0.3) cut = window.lastIndexOf('\n');
    if (cut < maxLen * 0.3) cut = window.lastIndexOf(' ');
    if (cut < 1) cut = maxLen;
    chunks.push(rest.substring(0, cut).replace(/\s+$/, ''));
    rest = rest.substring(cut).replace(/^\s+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// ===== Reply templates (app markdown, Russian — the bot's UI language) =====

function formatReminderCreated_(text, dateTimeStr, recurrence) {
  if (recurrence) {
    return '🔔 **Напоминание создано**\n\n' +
      describeRecurrence_(recurrence) + '\n**' + text + '**\n\n' +
      '📅 Ближайшее: ' + dateTimeStr;
  }
  const parts = dateTimeStr.split(' ');
  return '✅ **Напоминание создано**\n\n📅 ' + parts[0] + '\n🕕 ' + parts[1] + '\n\n🔔 ' + text;
}

function formatReminderFired_(text) {
  return '🔔 **Напоминание**\n\n' + text;
}

function formatReminderList_(reminders) {
  if (!reminders.length) return '📭 Активных напоминаний нет.';
  const lines = reminders.map(function (r, i) {
    const when = r.recurrence
      ? describeRecurrence_(r.recurrence) + ' (ближайшее: ' + r.dateTime + ')'
      : r.dateTime;
    return (i + 1) + '. **' + r.text + '**\n   ⏰ ' + when;
  });
  return '🔔 **Напоминания**\n\n' + lines.join('\n');
}

function formatTaskList_(tasks) {
  if (!tasks.length) return '📭 Открытых задач нет.';
  const lines = tasks.map(function (t, i) {
    let line = (i + 1) + '. ' + t.task;
    if (t.dueDate) line += ' (до ' + t.dueDate + ')';
    return line;
  });
  return '📋 **Задачи**\n\n' + lines.join('\n');
}

function formatTasksCreated_(titles) {
  if (titles.length === 1) return '✅ **Задача добавлена**\n\n📋 ' + titles[0];
  return '✅ **Добавлено задач: ' + titles.length + '**\n\n' +
    titles.map(function (t, i) { return (i + 1) + '. ' + t; }).join('\n');
}

function formatTranscript_(transcript, structured) {
  let out = '🎤 **Распознанный текст:**\n' + transcript;
  if (structured) out += '\n\n📋 **Структурировано:**\n' + structured;
  return out;
}

function helpText_() {
  return '🤖 **Секретарь**\n\n' +
    'Пишите или отправляйте голосовые — обычным языком, без команд.\n\n' +
    '**Примеры:**\n' +
    '• «Напомни завтра в 9 позвонить Андрею»\n' +
    '• «Каждую субботу в 10 напоминай про план на неделю»\n' +
    '• «Добавь задачу: проверить отчёт»\n' +
    '• «Какие у меня задачи?» / «Покажи напоминания»\n' +
    '• «Задача про отчёт выполнена»\n' +
    '• «Удали напоминание про Андрея»\n' +
    '• «Вот мои мысли, структурируй их: …»\n' +
    '• «Расшифруй следующее голосовое дословно»\n\n' +
    '**Команды:** /help — справка, /id — ваш Telegram ID';
}
