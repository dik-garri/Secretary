/**
 * SchedulerService.gs — time-driven reminder delivery.
 *
 * checkReminders() runs on a time trigger. Duplicate-send protection:
 *   1. LockService around the whole run (no two overlapping runs);
 *   2. row is updated immediately after a successful send;
 *   3. LastSent guard skips anything sent within DUPLICATE_SEND_GUARD_MS.
 */

function checkReminders() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    console.warn('checkReminders: previous run still holds the lock, skipping');
    return;
  }
  try {
    const rows = getAllRows_(getSheet_(SHEETS.REMINDERS));
    const now = Date.now();

    for (let i = 0; i < rows.length; i++) {
      const r = reminderFromRow_(rows[i]);
      if (r.status !== 'PENDING') continue;

      const user = getUser_(r.userId);
      const tz = user ? user.timezone : CONFIG.DEFAULT_TIMEZONE;

      const due = parseDateTimeInTz_(r.dateTime, tz);
      if (due === null || due > now) continue;

      // Duplicate guard: attempted within the guard window — skip. Also
      // paces retries when a send failed transiently.
      const lastSent = parseDateTimeInTz_(r.lastSent, tz);
      if (lastSent !== null && now - lastSent < CONFIG.DUPLICATE_SEND_GUARD_MS) continue;

      try {
        // Claim BEFORE sending: if anything below fails, the guard prevents
        // a duplicate on the next run; retry happens after the guard window.
        claimReminder_(r.id, tz);
        const sent = sendMessage_(r.userId, formatReminderFired_(r.text));
        if (sent.ok) {
          markReminderFired_(r.id, tz);
          logEvent_(r.userId, 'reminder_sent', r.text, '', '', r.id, '');
        } else if (sent.errorCode === 403 || sent.errorCode === 400) {
          // Blocked bot / dead chat — retrying forever is pointless.
          markReminderError_(r.id);
          logEvent_(r.userId, 'reminder_error', r.text, '', '', r.id,
            'permanent delivery failure: HTTP ' + sent.errorCode);
        } else {
          // Transient (429/5xx) — stays PENDING, retried after the guard.
          logEvent_(r.userId, 'reminder_retry', r.text, '', '', r.id,
            'transient delivery failure: HTTP ' + sent.errorCode);
        }
      } catch (e) {
        logEvent_(r.userId, 'reminder_error', r.text, '', '', r.id, e.message);
      }
    }

    // Scheduled daily/weekly digests ride the same trigger.
    try {
      checkSummaries_();
    } catch (e) {
      logEvent_('', 'summary_error', '', '', '', '', e.message);
    }
  } finally {
    lock.releaseLock();
  }
}

// ===== Trigger management (run manually from the editor) =====

function setupTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('checkReminders')
    .timeBased()
    .everyMinutes(CONFIG.SCHEDULER_INTERVAL_MINUTES)
    .create();
  console.log('Trigger created: checkReminders every ' + CONFIG.SCHEDULER_INTERVAL_MINUTES + ' min');
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkReminders') ScriptApp.deleteTrigger(t);
  });
}

/** Debug helper: log why each reminder does or doesn't fire right now. */
function debugReminders() {
  const rows = getAllRows_(getSheet_(SHEETS.REMINDERS));
  const now = Date.now();
  console.log('Now UTC: ' + Utilities.formatDate(new Date(), 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'"));
  rows.forEach(function (row) {
    const r = reminderFromRow_(row);
    const user = getUser_(r.userId);
    const tz = user ? user.timezone : CONFIG.DEFAULT_TIMEZONE;
    const due = parseDateTimeInTz_(r.dateTime, tz);
    console.log('--- ' + r.id + ' "' + r.text + '"'
      + ' | status=' + r.status
      + ' | dateTime=' + r.dateTime + ' (due millis=' + due + ')'
      + ' | lastSent=' + r.lastSent
      + ' | recurrence=' + JSON.stringify(r.recurrence)
      + ' | WOULD SEND: ' + (r.status === 'PENDING' && due !== null && due <= now));
  });
}
