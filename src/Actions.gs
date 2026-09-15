/**
 * Actions.gs — Intent → Handler registry (the "Skills/Actions" layer).
 *
 * Adding a capability = new intent in the AI prompt + new handler here.
 * Every handler: (user, intent) → reply string (app markdown).
 * GAS validates the AI's JSON here — the model never writes to Sheets.
 */

// ===== Tool registry — the single source of truth (MCP-style) =====
// Each entry declares: what the tool is FOR (desc — shown to the model),
// its parameters (name → spec string, also shown to the model), and the
// handler. The AI prompt and intent validation are GENERATED from this
// registry (AIService.gs), so the model can never see a capability that
// the code doesn't have, and vice versa.
//
// Adding a feature = one entry here + one handler function below.

const QUERY_SPEC_ = '"..." — ТОЛЬКО слова, идентифицирующие элемент по содержанию; ' +
  'служебные («все», «три», «задачи», «напоминания») не включай, при «все/оба» оставь пустым';
const ALL_SPEC_ = 'true, если пользователь имеет в виду ВСЕ подходящие («все», «оба», «всё про…»)';

const TOOLS_ = [
  {
    name: 'create_reminder',
    desc: 'создать напоминание (разовое или повторяющееся)',
    params: {
      reminder: '{"text": "...", "datetime": "YYYY-MM-DD HH:mm" или null, ' +
        '"recurrence": null или {"type": "DAILY|WEEKDAYS|WEEKLY|MONTHLY", "days": ["MON",...], ' +
        '"day_of_month": 1..31, "time": "HH:mm"}} — для разового recurrence = null, ' +
        'для повторяющегося datetime = null'
    },
    handler: actionCreateReminder_
  },
  { name: 'list_reminders', desc: 'показать активные напоминания', params: {}, handler: actionListReminders_ },
  {
    name: 'delete_reminder',
    desc: 'удалить/отменить напоминание',
    params: { query: QUERY_SPEC_, all: ALL_SPEC_ },
    handler: actionDeleteReminder_
  },
  {
    name: 'create_task',
    desc: 'добавить задачу или несколько задач (дела, требующие действия)',
    params: {
      tasks: '[{"text": "...", "priority": "HIGH|NORMAL|LOW", "due": "YYYY-MM-DD" или null}] — ' +
        'priority: «важно», «срочно» = HIGH; «неважно», «потом» = LOW; иначе NORMAL; ' +
        'due только если назван срок («до пятницы», «к 15-му»); формулировки короткие, в инфинитиве'
    },
    handler: actionCreateTask_
  },
  {
    name: 'complete_task',
    desc: 'отметить задачу выполненной',
    params: { query: QUERY_SPEC_, all: ALL_SPEC_ },
    handler: actionCompleteTask_
  },
  {
    name: 'delete_task',
    desc: 'удалить задачу совсем, не выполнив («убери из списка»)',
    params: { query: QUERY_SPEC_, all: ALL_SPEC_ },
    handler: actionDeleteTask_
  },
  {
    name: 'update_task',
    desc: 'изменить приоритет или срок существующей задачи («задача про отчёт — срочная», «перенеси на пятницу»)',
    params: {
      query: QUERY_SPEC_,
      priority: '"HIGH|NORMAL|LOW"',
      due: '"YYYY-MM-DD"'
    },
    handler: actionUpdateTask_
  },
  { name: 'list_tasks', desc: 'показать открытые задачи', params: {}, handler: actionListTasks_ },
  {
    name: 'create_note',
    desc: 'сохранить заметку/мысль/факт БЕЗ действия и срока («запиши:», «сохрани мысль», «запомни, что…»)',
    params: { note: '"..." — текст заметки', tags: '["..."] — 1-3 коротких тега' },
    handler: actionCreateNote_
  },
  { name: 'list_notes', desc: 'показать заметки', params: {}, handler: actionListNotes_ },
  {
    name: 'search_notes',
    desc: 'найти заметку («что я записывал про…»)',
    params: { query: QUERY_SPEC_ },
    handler: actionSearchNotes_
  },
  {
    name: 'delete_note',
    desc: 'удалить заметку',
    params: { query: QUERY_SPEC_, all: ALL_SPEC_ },
    handler: actionDeleteNote_
  },
  {
    name: 'summary',
    desc: 'сводка по запросу: «что у меня сегодня/на неделю», «сводка», «мой день»',
    params: { period: '"daily" или "weekly"' },
    handler: actionSummary_
  },
  {
    name: 'summary_schedule',
    desc: 'настроить регулярную сводку («присылай сводку каждый день в 8», «отключи ежедневную сводку»)',
    params: {
      period: '"daily" или "weekly"',
      time: '"HH:mm"',
      day: '"MON".."SUN" — только для weekly',
      enabled: 'false для отключения, иначе true'
    },
    handler: actionSummarySchedule_
  },
  {
    name: 'draft_message',
    desc: 'составить сообщение или письмо кому-то от лица пользователя ' +
      '(«напиши сообщение X о…», «составь письмо…», «ответь ему, что…»). ' +
      'Если просят доработать предыдущий черновик («короче», «формальнее») — ' +
      'верни draft_message с полным ОБНОВЛЁННЫМ текстом',
    params: {
      draft: '{"recipient": "кому", "channel": "message" или "email", ' +
        '"subject": "тема (только email)", "text": "полный готовый текст от первого лица, ' +
        'вежливо, без плейсхолдеров вроде [имя]"}'
    },
    handler: actionDraftMessage_
  },
  {
    name: 'structure',
    desc: 'структурировать/суммировать/оформить текст пользователя ' +
      '(выбери формат: список, чеклист, план, тезисы, action items — ГОТОВЫЙ результат в reply)',
    params: { reply: '"..." — готовый структурированный результат' },
    handler: actionReply_
  },
  {
    name: 'transcribe_mode',
    desc: 'пользователь просит расшифровать СЛЕДУЮЩЕЕ голосовое дословно, ничего не меняя',
    params: {},
    handler: actionTranscribeMode_
  },
  {
    name: 'answer',
    desc: 'обычный вопрос или просьба, не подходящая под остальное',
    params: { reply: '"..." — ответ пользователю' },
    handler: actionReply_
  },
  {
    name: 'clarify',
    desc: 'для действия не хватает критичных данных — задай вопрос',
    params: { clarify_question: '"..." — уточняющий вопрос' },
    handler: actionClarify_
  }
];

function findTool_(name) {
  for (let i = 0; i < TOOLS_.length; i++) {
    if (TOOLS_[i].name === name) return TOOLS_[i];
  }
  return null;
}

/** Route a validated intent to its handler. Returns reply text. */
function executeIntent_(user, intent) {
  // Several independent commands in one message («удали X и добавь Y»):
  // execute in order, join the replies.
  if (intent.intent === 'multi') {
    const replies = [];
    for (let i = 0; i < intent.actions.length; i++) {
      const sub = intent.actions[i];
      sub._sourceText = intent._sourceText;
      sub._prevOriginal = intent._prevOriginal;
      const tool = findTool_(sub.intent);
      replies.push(tool ? tool.handler(user, sub) : '🤔 Не умею: ' + sub.intent);
    }
    return replies.join('\n\n');
  }
  const tool = findTool_(intent.intent);
  if (!tool) {
    return '🤔 Я пока не умею это делать. Напишите /help — покажу, что умею.';
  }
  return tool.handler(user, intent);
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
  const items = (intent.tasks || []).map(normalizeTaskItem_).filter(Boolean);
  if (!items.length) {
    return askClarify_(user, 'Какую задачу добавить?', intent);
  }
  const created = createTasks_(user.telegramId, items);
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

function actionDeleteTask_(user, intent) {
  const matches = findTasks_(user.telegramId, intent.query);
  if (!matches.length) {
    return '🔍 Не нашёл открытую задачу по запросу «' + (intent.query || '') + '».\n\n' +
      formatTaskList_(getOpenTasks_(user.telegramId));
  }
  if (matches.length > 1 && !intent.all) {
    setState_(user.telegramId, {
      mode: 'clarify',
      question: 'Какую из найденных задач удалить?',
      original: intent._sourceText || ''
    });
    return '🔍 Нашёл несколько задач — уточните, какую удалить (или скажите «все»):\n\n' +
      formatTaskList_(matches);
  }
  matches.forEach(function (m) { deleteTask_(m.id); });
  if (matches.length === 1) return '🗑 Задача удалена:\n**' + matches[0].task + '**';
  return '🗑 Удалено задач: ' + matches.length + '\n\n' +
    matches.map(function (m, i) { return (i + 1) + '. ' + m.task; }).join('\n');
}

function actionUpdateTask_(user, intent) {
  if (!intent.priority && !intent.due) {
    return askClarify_(user, 'Что изменить в задаче — приоритет или срок?', intent);
  }
  const matches = findTasks_(user.telegramId, intent.query);
  if (!matches.length) {
    return '🔍 Не нашёл открытую задачу по запросу «' + (intent.query || '') + '».\n\n' +
      formatTaskList_(getOpenTasks_(user.telegramId));
  }
  if (matches.length > 1 && !intent.all) {
    setState_(user.telegramId, {
      mode: 'clarify',
      question: 'Какую из найденных задач изменить?',
      original: intent._sourceText || ''
    });
    return '🔍 Нашёл несколько задач — уточните, какую изменить:\n\n' + formatTaskList_(matches);
  }
  matches.forEach(function (m) {
    updateTask_(m.id, { priority: intent.priority, due: intent.due });
  });
  const updated = findTasks_(user.telegramId, intent.query);
  return '✏️ Обновлено:\n\n' + updated.map(function (t, i) {
    return (i + 1) + '. ' + taskLine_(t);
  }).join('\n');
}

// ===== Notes =====

function actionCreateNote_(user, intent) {
  const text = String(intent.note || '').trim();
  if (!text) {
    return askClarify_(user, 'Что записать в заметку?', intent);
  }
  createNote_(user.telegramId, text, intent.tags || []);
  return '📝 **Заметка сохранена**\n\n' + text +
    (intent.tags && intent.tags.length ? '\n#' + intent.tags.join(' #') : '');
}

function actionListNotes_(user) {
  const notes = getNotes_(user.telegramId);
  const shown = notes.slice(0, 15);
  let out = formatNoteList_(shown, 'Заметки');
  if (notes.length > 15) out += '\n… и ещё ' + (notes.length - 15) + ' (ищите по словам)';
  return out;
}

function actionSearchNotes_(user, intent) {
  const matches = findNotes_(user.telegramId, intent.query);
  if (!matches.length) {
    return '🔍 Ничего не нашёл по запросу «' + (intent.query || '') + '».';
  }
  return formatNoteList_(matches.slice(0, 15), 'Найдено: ' + (intent.query || ''));
}

function actionDeleteNote_(user, intent) {
  const matches = findNotes_(user.telegramId, intent.query);
  if (!matches.length) {
    return '🔍 Не нашёл заметку по запросу «' + (intent.query || '') + '».';
  }
  if (matches.length > 1 && !intent.all) {
    setState_(user.telegramId, {
      mode: 'clarify',
      question: 'Какую из найденных заметок удалить?',
      original: intent._sourceText || ''
    });
    return '🔍 Нашёл несколько заметок — уточните, какую удалить (или скажите «все»):\n\n' +
      formatNoteList_(matches, 'Найдено');
  }
  matches.forEach(function (m) { deleteNote_(m.id); });
  if (matches.length === 1) return '🗑 Заметка удалена:\n' + matches[0].note;
  return '🗑 Удалено заметок: ' + matches.length;
}

// ===== Summaries =====

function actionSummary_(user, intent) {
  return buildSummary_(user, intent.period === 'weekly' ? 'weekly' : 'daily');
}

function actionSummarySchedule_(user, intent) {
  const period = intent.period === 'weekly' ? 'weekly' : 'daily';
  const settings = getUserSettings_(user);

  if (intent.enabled === false) {
    delete settings[period];
    saveUserSettings_(user.telegramId, settings);
    return '🔕 ' + (period === 'weekly' ? 'Еженедельная' : 'Ежедневная') + ' сводка отключена.';
  }

  const tm = String(intent.time || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!tm) {
    return askClarify_(user, 'В какое время присылать ' +
      (period === 'weekly' ? 'еженедельную' : 'ежедневную') + ' сводку?', intent);
  }
  const time = pad2_(+tm[1]) + ':' + tm[2];

  if (period === 'weekly') {
    const day = DOW_CODES_.indexOf(String(intent.day || '').toUpperCase()) !== -1
      ? String(intent.day).toUpperCase() : 'MON';
    settings.weekly = day + ' ' + time;
    saveUserSettings_(user.telegramId, settings);
    return '📅 Буду присылать сводку: ' + describeRecurrence_({ type: 'WEEKLY', days: [day], time: time });
  }

  settings.daily = time;
  saveUserSettings_(user.telegramId, settings);
  return '🌅 Буду присылать сводку каждый день в ' + time +
    '\n(точность — в пределах ' + CONFIG.SCHEDULER_INTERVAL_MINUTES + ' минут)';
}

/**
 * Draft a message/email. The draft is kept in dialog state so follow-ups
 * («короче», «формальнее», «добавь…») revise it instead of starting over.
 */
function actionDraftMessage_(user, intent) {
  const d = intent.draft || {};
  const text = String(d.text || '').trim();
  if (!text) {
    return askClarify_(user, 'Кому и о чём написать сообщение?', intent);
  }
  setState_(user.telegramId, {
    mode: 'draft',
    text: text,
    recipient: String(d.recipient || ''),
    request: intent._sourceText || ''
  });
  let out = '✉️ **Черновик' + (d.recipient ? ' для ' + d.recipient : '') + '**\n\n';
  if (d.channel === 'email' && d.subject) out += '**Тема:** ' + d.subject + '\n\n';
  out += '```\n' + text + '\n```\n\n';
  out += 'Нажмите на текст — он скопируется. Могу переделать: «короче», «формальнее», «добавь …».';
  return out;
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
