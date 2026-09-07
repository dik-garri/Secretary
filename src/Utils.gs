/**
 * Utils.gs — time helpers, recurrence math, logging, safe JSON parsing.
 *
 * All datetimes are stored in Sheets as 'yyyy-MM-dd HH:mm' strings in the
 * user's timezone. Comparison happens via epoch millis (parseDateTimeInTz_).
 * Lesson from Pulse: never trust new Date().toISOString() in GAS, never
 * run Utilities.formatDate over Date objects that came out of Sheets cells.
 */

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

/** Utilities.formatDate wrapper over epoch millis. */
function formatTz_(millis, tz, pattern) {
  return Utilities.formatDate(new Date(millis), tz, pattern);
}

/** UTC offset of a timezone at a given instant, in millis. */
function tzOffsetMs_(atMillis, tz) {
  const z = formatTz_(atMillis, tz, 'Z'); // e.g. '+0600'
  const sign = z.charAt(0) === '-' ? -1 : 1;
  return sign * (parseInt(z.substr(1, 2), 10) * 60 + parseInt(z.substr(3, 2), 10)) * 60000;
}

/**
 * Parse 'yyyy-MM-dd HH:mm' (or with 'T') as wall time in tz → epoch millis.
 * Two-pass offset lookup keeps DST-transition edges correct.
 * Returns null on bad input.
 */
function parseDateTimeInTz_(str, tz) {
  const m = String(str || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const utcGuess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let ms = utcGuess - tzOffsetMs_(utcGuess, tz);
  ms = utcGuess - tzOffsetMs_(ms, tz);
  return ms;
}

/**
 * Normalize a Sheets cell (Date object or string) to 'yyyy-MM-dd HH:mm'.
 * Date objects from Sheets carry the spreadsheet's timezone in their local
 * components — read components directly, do NOT re-format through a tz.
 */
function cellToDateTimeString_(value) {
  if (!value && value !== 0) return '';
  if (value instanceof Date) {
    return value.getFullYear() + '-' + pad2_(value.getMonth() + 1) + '-' + pad2_(value.getDate())
      + ' ' + pad2_(value.getHours()) + ':' + pad2_(value.getMinutes());
  }
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3] + ' ' + pad2_(+m[4]) + ':' + m[5];
  return String(value);
}

/** Current wall-clock info in tz — injected into the Gemini prompt. */
function nowInfo_(tz) {
  const now = Date.now();
  const days = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
  const dow = +formatTz_(now, tz, 'u'); // 1=Mon..7=Sun
  return {
    millis: now,
    datetime: formatTz_(now, tz, 'yyyy-MM-dd HH:mm'),
    weekday: days[dow - 1],
    tz: tz
  };
}

const DOW_CODES_ = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

function daysInMonth_(year, month1) { // month1: 1..12
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/**
 * Next occurrence of a recurring reminder, strictly after afterMillis.
 * rec: {type: 'DAILY'|'WEEKDAYS'|'WEEKLY'|'MONTHLY', days?: ['MON',...],
 *       day_of_month?: n, time: 'HH:mm'}
 * Returns 'yyyy-MM-dd HH:mm' in tz, or null if rec is invalid.
 */
function nextOccurrence_(rec, afterMillis, tz) {
  if (!rec || !rec.type || !rec.time) return null;
  const tm = String(rec.time).match(/^(\d{1,2}):(\d{2})$/);
  if (!tm) return null;
  const timeStr = pad2_(+tm[1]) + ':' + tm[2];
  const type = String(rec.type).toUpperCase();

  for (let offset = 0; offset <= 62; offset++) {
    const dayMs = afterMillis + offset * 86400000;
    const dateStr = formatTz_(dayMs, tz, 'yyyy-MM-dd');
    const dowNum = +formatTz_(dayMs, tz, 'u');
    let match = false;

    if (type === 'DAILY') {
      match = true;
    } else if (type === 'WEEKDAYS') {
      match = dowNum <= 5;
    } else if (type === 'WEEKLY') {
      const days = (rec.days || []).map(function (d) { return String(d).toUpperCase(); });
      if (!days.length) return null;
      match = days.indexOf(DOW_CODES_[dowNum - 1]) !== -1;
    } else if (type === 'MONTHLY') {
      const parts = dateStr.split('-');
      const dom = +parts[2];
      const last = daysInMonth_(+parts[0], +parts[1]);
      const want = +rec.day_of_month || 1;
      match = dom === want || (dom === last && want > last); // clamp 31st → last day
    } else {
      return null;
    }

    if (!match) continue;
    const candidate = parseDateTimeInTz_(dateStr + ' ' + timeStr, tz);
    if (candidate !== null && candidate > afterMillis) return dateStr + ' ' + timeStr;
  }
  return null;
}

/** Human-readable recurrence description (Russian). */
function describeRecurrence_(rec) {
  if (!rec || !rec.type) return '';
  const names = { MON: 'понедельник', TUE: 'вторник', WED: 'среду', THU: 'четверг', FRI: 'пятницу', SAT: 'субботу', SUN: 'воскресенье' };
  const type = String(rec.type).toUpperCase();
  const time = rec.time ? ' в ' + rec.time : '';
  if (type === 'DAILY') return 'Каждый день' + time;
  if (type === 'WEEKDAYS') return 'По будням' + time;
  if (type === 'WEEKLY') {
    const days = (rec.days || []).map(function (d) { return names[String(d).toUpperCase()] || d; });
    return 'Каждую неделю: ' + days.join(', ') + time;
  }
  if (type === 'MONTHLY') return 'Каждый месяц, ' + (rec.day_of_month || 1) + '-го числа' + time;
  return '';
}

/**
 * Morphology-tolerant word match for Russian: «петра» matches «петром»,
 * «парта» does NOT match «парк». Two words match when they share a prefix
 * of at least 4 chars (or the full shorter word) and each leaves at most
 * 2 trailing chars beyond it (case endings).
 */
function wordsMatch_(a, b) {
  a = String(a).toLowerCase().replace(/ё/g, 'е');
  b = String(b).toLowerCase().replace(/ё/g, 'е');
  if (a === b) return true;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  const need = Math.min(4, Math.min(a.length, b.length));
  return p >= need && a.length - p <= 2 && b.length - p <= 2;
}

/**
 * Does `text` match the search `query`? Every significant query word
 * (4+ chars) must fuzzy-match some text word; 3-char words are optional
 * (short prepositions like «про» must not block a match).
 */
function fuzzyMatch_(text, query) {
  const textWords = String(text || '').toLowerCase().split(/[^a-zа-яё0-9]+/i).filter(String);
  const queryWords = String(query || '').toLowerCase().split(/[^a-zа-яё0-9]+/i).filter(String);
  const required = queryWords.filter(function (w) { return w.length >= 4; });
  const optional = queryWords.filter(function (w) { return w.length === 3; });
  const hits = function (w) {
    return textWords.some(function (t) { return wordsMatch_(w, t); });
  };
  if (required.length) return required.every(hits);
  if (optional.length) return optional.some(hits);
  return String(text || '').toLowerCase().indexOf(String(query || '').toLowerCase().trim()) !== -1;
}

/**
 * Extract a JSON object from model output. Tolerates ``` fences and
 * leading/trailing prose. Returns null if nothing parses.
 */
function extractJson_(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch (e) { /* fall through */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(s.substring(start, end + 1)); } catch (e2) { /* fall through */ }
  }
  return null;
}

/**
 * Mask credentials that leak into error messages: GAS exceptions include the
 * full request URL, and Telegram/Gemini URLs embed the bot token / API key.
 */
function maskSecrets_(s) {
  return String(s == null ? '' : s)
    .replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, 'bot<token>')
    .replace(/([?&]key=)[A-Za-z0-9_-]{10,}/g, '$1<redacted>')
    .replace(/([?&]token=)[A-Za-z0-9_-]{10,}/g, '$1<redacted>');
}

/**
 * UrlFetchApp.fetch with retries: GAS sporadically throws transient network
 * errors ("Address unavailable", timeouts, DNS). A short backoff fixes them.
 */
function fetchWithRetry_(url, params, attempts) {
  attempts = attempts || 3;
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      return UrlFetchApp.fetch(url, params);
    } catch (e) {
      lastError = e;
      if (i < attempts) Utilities.sleep(500 * i);
    }
  }
  throw lastError;
}

/**
 * Append a row to the Logs sheet. Must never throw — logging failures
 * cannot be allowed to break request handling.
 */
function logEvent_(telegramId, type, input, intent, model, result, error) {
  try {
    const sheet = getSheet_(SHEETS.LOGS);
    sheet.appendRow([
      Utilities.formatDate(new Date(), 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'"),
      String(telegramId || ''),
      String(type || ''),
      maskSecrets_(input).substring(0, 2000),
      String(intent || ''),
      String(model || ''),
      maskSecrets_(result).substring(0, 2000),
      maskSecrets_(error).substring(0, 2000)
    ]);
  } catch (e) {
    try { console.error('logEvent_ failed: ' + e.message); } catch (e2) { /* ignore */ }
  }
}
