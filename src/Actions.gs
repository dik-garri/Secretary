/**
 * Actions.gs — Intent → Handler registry (the "Skills/Actions" layer).
 *
 * Adding a capability = new intent in the AI prompt + new handler here.
 * Every handler: (user, intent) → reply string (app markdown).
 * GAS validates the AI's JSON here — the model never writes to Sheets.
 */

const ACTION_HANDLERS_ = {
  create_reminder: actionCreateReminder_,
  list_reminders: actionListReminders_,
  delete_reminder: actionDeleteReminder_,
  create_task: actionCreateTask_,
  complete_task: actionCompleteTask_,
  list_tasks: actionListTasks_,
  structure: actionReply_,
  answer: actionReply_,
  transcribe_mode: actionTranscribeMode_,
  clarify: actionClarify_
};

/** Route a validated intent to its handler. Returns reply text. */
function executeIntent_(user, intent) {
  const handler = ACTION_HANDLERS_[intent.intent];
  if (!handler) {
    return '🤔 Я пока не умею это делать. Напишите /help — покажу, что умею.';
  }
  return handler(user, intent);
}

// ===== Handlers =====

function actionCreateReminder_(user, intent) {
  const r = intent.reminder || {};
  const text = String(r.text || '').trim();
  if (!text) {
    return askClarify_(user, 'О чём напомнить?', intent);
  }

  // Recurring reminder: validate recurrence, compute first firing.
  if (r.recurrence && r.recurrence.type) {
    if (!r.recurrence.time) {
      return askClarify_(user, 'В какое время напоминать о «' + text + '»?', intent);
    }
    const first = nextOccurrence_(r.recurrence, Date.now(), user.timezone);
    if (!first) {
      return askClarify_(user, 'Не понял расписание повторения. Уточните: как часто и в какое время напоминать?', intent);
    }
    createReminder_(user.telegramId, text, first, r.recurrence);
    clearState_(user.telegramId);
    return formatReminderCreated_(text, first, r.recurrence);
  }

  // One-off reminder: datetime must be valid and in the future.
  const millis = parseDateTimeInTz_(r.datetime, user.timezone);
  if (millis === null) {
    return askClarify_(user, 'Когда напомнить про «' + text + '»? Укажите дату и время.', intent);
  }
  if (millis <= Date.now()) {
    return askClarify_(user, 'Это время уже прошло (' + r.datetime + '). Когда напомнить про «' + text + '»?', intent);
  }
  const reminder = createReminder_(user.telegramId, text, r.datetime, null);
  clearState_(user.telegramId);
  return formatReminderCreated_(reminder.text, reminder.dateTime, null);
}

function actionListReminders_(user) {
  return formatReminderList_(getActiveReminders_(user.telegramId, user.timezone));
}

function actionDeleteReminder_(user, intent) {
  const matches = findReminders_(user.telegramId, user.timezone, intent.query);
  if (!matches.length) {
    return '🔍 Не нашёл напоминание по запросу «' + (intent.query || '') + '».\n\n' +
      formatReminderList_(getActiveReminders_(user.telegramId, user.timezone));
  }
  if (matches.length > 1 && !intent.all) {
    setState_(user.telegramId, {
      mode: 'clarify',
      question: 'Какое из найденных напоминаний удалить?',
      original: intent._sourceText || ''
    });
    return '🔍 Нашёл несколько напоминаний — уточните, какое удалить (или скажите «все»):\n\n' +
      formatReminderList_(matches);
  }
  matches.forEach(function (m) { cancelReminder_(m.id); });
  if (matches.length === 1) return '🗑 Напоминание удалено:\n**' + matches[0].text + '**';
  return '🗑 Удалено напоминаний: ' + matches.length + '\n\n' +
    matches.map(function (m, i) { return (i + 1) + '. ' + m.text; }).join('\n');
}

function actionCreateTask_(user, intent) {
  const titles = (intent.tasks || []).filter(function (t) { return String(t || '').trim(); });
  if (!titles.length) {
    return askClarify_(user, 'Какую задачу добавить?', intent);
  }
  const created = createTasks_(user.telegramId, titles);
  return formatTasksCreated_(created);
}

function actionCompleteTask_(user, intent) {
  const matches = findTasks_(user.telegramId, intent.query);
  if (!matches.length) {
    return '🔍 Не нашёл открытую задачу по запросу «' + (intent.query || '') + '».\n\n' +
      formatTaskList_(getOpenTasks_(user.telegramId));
  }
  if (matches.length > 1 && !intent.all) {
    setState_(user.telegramId, {
      mode: 'clarify',
      question: 'Какая из найденных задач выполнена?',
      original: intent._sourceText || ''
    });
    return '🔍 Нашёл несколько задач — уточните, какая выполнена (или скажите «все»):\n\n' +
      formatTaskList_(matches);
  }
  matches.forEach(function (m) { completeTask_(m.id); });
  if (matches.length === 1) return '✅ Задача выполнена:\n**' + matches[0].task + '**';
  return '✅ Выполнено задач: ' + matches.length + '\n\n' +
    matches.map(function (m, i) { return (i + 1) + '. ' + m.task; }).join('\n');
}

function actionListTasks_(user) {
  return formatTaskList_(getOpenTasks_(user.telegramId));
}

/** structure / answer — the AI already produced the final reply. */
function actionReply_(user, intent) {
  return intent.reply || '🤔 Не получилось сформировать ответ. Попробуйте переформулировать.';
}

function actionTranscribeMode_(user) {
  setState_(user.telegramId, { mode: 'transcribe' });
  return '🎤 Хорошо, следующее голосовое расшифрую дословно, ничего не меняя.';
}

function actionClarify_(user, intent) {
  return askClarify_(user, intent.clarify_question || 'Уточните, пожалуйста, что вы имеете в виду.', intent);
}

/**
 * Ask a clarifying question and remember the pending context so the next
 * message is interpreted as an answer to it. Across multiple clarify rounds
 * the whole exchange is accumulated — the original request is never lost.
 */
function askClarify_(user, question, intent) {
  const sourceText = intent._sourceText || '';
  const original = intent._prevOriginal
    ? intent._prevOriginal + ' → ' + sourceText
    : sourceText;
  setState_(user.telegramId, { mode: 'clarify', question: question, original: original });
  return '❓ ' + question;
}
