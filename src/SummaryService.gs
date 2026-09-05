/**
 * SummaryService.gs — on-demand and scheduled daily/weekly digests.
 *
 * Schedule lives in the user's Settings JSON (Users sheet):
 *   {"daily": "08:00", "weekly": "MON 08:00"}   // absent key = off
 * Delivery rides the existing checkReminders trigger (checkSummaries_ is
 * called from it) — no extra trigger setup needed. Dedup: the sent-date key
 * is claimed in ScriptProperties BEFORE sending (same pattern as reminders).
 */

/**
 * Pure decision: if the `period` summary is due at nowMillis, return today's
 * 'yyyy-MM-dd' key (used for once-per-day dedup); otherwise null.
 * cfg: parsed Settings object.
 */
function summaryDueKey_(cfg, period, nowMillis, tz) {
  const spec = cfg && cfg[period];
  if (!spec) return null;
  const today = formatTz_(nowMillis, tz, 'yyyy-MM-dd');
  const nowHM = formatTz_(nowMillis, tz, 'HH:mm');

  if (period === 'daily') {
    const m = String(spec).match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return nowHM >= pad2_(+m[1]) + ':' + m[2] ? today : null;
  }
  if (period === 'weekly') {
    const m = String(spec).toUpperCase().match(/^(MON|TUE|WED|THU|FRI|SAT|SUN)\s+(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const dow = +formatTz_(nowMillis, tz, 'u');
    if (DOW_CODES_[dow - 1] !== m[1]) return null;
    return nowHM >= pad2_(+m[2]) + ':' + m[3] ? today : null;
  }
  return null;
}

/** Build the digest text for 'daily' or 'weekly'. */
function buildSummary_(user, period) {
  const tz = user.timezone;
  const now = Date.now();
  const days = period === 'weekly' ? 7 : 1;
  const today = formatTz_(now, tz, 'yyyy-MM-dd');
  const horizonEnd = parseDateTimeInTz_(
    formatTz_(now + (days - 1) * 86400000, tz, 'yyyy-MM-dd') + ' 23:59', tz);

  const lines = [];
  lines.push(period === 'weekly'
    ? '📅 **Сводка на неделю** (' + today + ')'
    : '🌅 **Сводка на сегодня** (' + today + ')');

  const reminders = getActiveReminders_(user.telegramId, tz).filter(function (r) {
    const due = parseDateTimeInTz_(r.dateTime, tz);
    return due !== null && due <= horizonEnd;
  });
  lines.push('');
  if (reminders.length) {
    lines.push('🔔 **Напоминания:**');
    reminders.forEach(function (r, i) {
      const when = period === 'weekly' ? r.dateTime : r.dateTime.split(' ')[1];
      lines.push((i + 1) + '. ' + when + ' — ' + r.text);
    });
  } else {
    lines.push('🔔 Напоминаний ' + (period === 'weekly' ? 'на неделю' : 'на сегодня') + ' нет.');
  }

  const tasks = getOpenTasks_(user.telegramId);
  lines.push('');
  if (tasks.length) {
    const overdue = tasks.filter(function (t) { return t.dueDate && t.dueDate < today; });
    lines.push('📋 **Открытые задачи (' + tasks.length + '):**');
    tasks.slice(0, 15).forEach(function (t, i) {
      lines.push((i + 1) + '. ' + priorityMark_(t.priority) + t.task +
        (t.dueDate ? ' (до ' + t.dueDate + ')' : ''));
    });
    if (tasks.length > 15) lines.push('… и ещё ' + (tasks.length - 15));
    if (overdue.length) {
      lines.push('');
      lines.push('⚠️ **Просрочено:** ' + overdue.map(function (t) { return t.task; }).join('; '));
    }
  } else {
    lines.push('📋 Открытых задач нет. 🎉');
  }
  return lines.join('\n');
}

/** Called from the checkReminders trigger run. */
function checkSummaries_() {
  const rows = getAllRows_(getSheet_(SHEETS.USERS));
  const props = PropertiesService.getScriptProperties();

  rows.forEach(function (row) {
    const user = {
      telegramId: String(row[0]),
      timezone: row[2] || CONFIG.DEFAULT_TIMEZONE,
      settings: row[4]
    };
    const cfg = getUserSettings_(user);

    ['daily', 'weekly'].forEach(function (period) {
      const key = summaryDueKey_(cfg, period, Date.now(), user.timezone);
      if (!key) return;
      const propKey = 'summary_' + period + '_' + user.telegramId;
      if (props.getProperty(propKey) === key) return; // already sent today
      props.setProperty(propKey, key); // claim BEFORE sending
      const sent = sendMessage_(user.telegramId, buildSummary_(user, period));
      logEvent_(user.telegramId, sent.ok ? 'summary_sent' : 'summary_error',
        period, '', '', key, sent.ok ? '' : 'HTTP ' + sent.errorCode);
    });
  });
}
