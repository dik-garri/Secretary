/**
 * AIService.gs — prompts, intent detection, JSON validation.
 *
 * One Gemini call per user message: the model returns intent AND payload
 * (and, for voice, the transcript) in a single JSON object. GAS validates
 * the JSON and executes the action — the model never touches Sheets.
 */

const INTENTS_ = [
  'create_reminder', 'list_reminders', 'delete_reminder',
  'create_task', 'complete_task', 'list_tasks', 'delete_task', 'update_task',
  'create_note', 'list_notes', 'search_notes', 'delete_note',
  'summary', 'summary_schedule', 'draft_message',
  'structure', 'transcribe_mode', 'answer', 'clarify'
];

function buildIntentPrompt_(user, contextNote, isAudio) {
  const now = nowInfo_(user.timezone);
  let p =
    'Ты — AI-ядро персонального Telegram-секретаря. Пользователь пишет обычным языком, ' +
    'без команд. Определи намерение и верни СТРОГО один JSON-объект, без markdown и пояснений.\n\n' +
    'Текущая дата и время: ' + now.datetime + ' (' + now.weekday + ')\n' +
    'Часовой пояс пользователя: ' + now.tz + '\n\n' +
    'Возможные значения intent:\n' +
    '- create_reminder — создать напоминание (разовое или повторяющееся)\n' +
    '- list_reminders — показать активные напоминания\n' +
    '- delete_reminder — удалить/отменить напоминание (query — ключевые слова для поиска, ' +
    'без служебных слов; all = true, если пользователь хочет удалить ВСЕ подходящие: «оба», «все», «всё про…»)\n' +
    '- create_task — добавить задачу/задачи. tasks — массив объектов ' +
    '{"text": "...", "priority": "HIGH|NORMAL|LOW", "due": "YYYY-MM-DD" или null}. ' +
    'priority: «важно», «срочно», «в первую очередь» = HIGH; «неважно», «потом», «как-нибудь» = LOW; иначе NORMAL. ' +
    'due заполняй только если назван срок («до пятницы», «к 15-му»)\n' +
    '- complete_task — отметить задачу выполненной (query — ключевые слова; all = true для «все»/«обе»)\n' +
    '- delete_task — удалить задачу совсем, не выполнив («удали задачу», «убери из списка»; query, all)\n' +
    '- update_task — изменить приоритет или срок существующей задачи ' +
    '(«задача про отчёт — срочная», «перенеси срок на пятницу»; query + priority и/или due)\n' +
    '- list_tasks — показать открытые задачи\n' +
    '- create_note — сохранить заметку/мысль/факт БЕЗ действия и срока ' +
    '(«запиши:», «заметка:», «сохрани мысль», «запомни, что…»; note — текст, tags — 1-3 коротких тега)\n' +
    '- list_notes — показать заметки\n' +
    '- search_notes — найти заметку («что я записывал про…»; query)\n' +
    '- delete_note — удалить заметку (query, all)\n' +
    '- summary — сводка по запросу: «что у меня сегодня/на неделю», «сводка», «мой день» ' +
    '(period: "daily" или "weekly")\n' +
    '- summary_schedule — настроить регулярную сводку: «присылай сводку каждый день в 8», ' +
    '«еженедельную сводку по понедельникам в 9», «отключи ежедневную сводку» ' +
    '(period: "daily"|"weekly", time: "HH:mm", day: "MON".."SUN" для weekly, enabled: true|false)\n' +
    '- draft_message — составить сообщение или письмо кому-то от лица пользователя ' +
    '(«напиши сообщение Кут-Назару о…», «составь письмо…», «ответь ему, что…», «черновик…»). ' +
    'draft: {"recipient": "имя/кому", "channel": "message" или "email", ' +
    '"subject": "тема (только для email)", "text": "полный готовый к отправке текст"}. ' +
    'Текст пиши от первого лица, вежливо, без плейсхолдеров вроде [имя]. ' +
    'Если пользователь просит доработать предыдущий черновик («короче», «формальнее», «добавь…») — ' +
    'верни draft_message с полным ОБНОВЛЁННЫМ текстом\n' +
    '- structure — пользователь просит структурировать/суммировать/оформить свой текст ' +
    '(выбери подходящий формат: список, чеклист, план, тезисы, action items — и положи ГОТОВЫЙ результат в reply)\n' +
    '- transcribe_mode — просит расшифровать СЛЕДУЮЩЕЕ голосовое дословно, ничего не меняя\n' +
    '- answer — обычный вопрос или просьба, не подходящая под остальное (ответ в reply)\n' +
    '- clarify — для действия не хватает критичных данных (вопрос в clarify_question)\n\n' +
    'Формат ответа:\n' +
    '{\n' +
    '  "intent": "...",\n' +
    '  "transcript": "только для аудио: полный распознанный текст",\n' +
    '  "reminder": {"text": "...", "datetime": "YYYY-MM-DD HH:mm" или null,\n' +
    '    "recurrence": null или {"type": "DAILY|WEEKDAYS|WEEKLY|MONTHLY", "days": ["MON",...], "day_of_month": 1..31, "time": "HH:mm"}},\n' +
    '  "tasks": [{"text": "...", "priority": "NORMAL", "due": null}],\n' +
    '  "query": "...",\n' +
    '  "all": true,\n' +
    '  "priority": "HIGH|NORMAL|LOW",\n' +
    '  "due": "YYYY-MM-DD",\n' +
    '  "note": "...",\n' +
    '  "tags": ["..."],\n' +
    '  "draft": {"recipient": "...", "channel": "message|email", "subject": "...", "text": "..."},\n' +
    '  "period": "daily|weekly",\n' +
    '  "time": "HH:mm",\n' +
    '  "day": "MON",\n' +
    '  "enabled": true,\n' +
    '  "reply": "...",\n' +
    '  "clarify_question": "...",\n' +
    '  "confidence": 0.0\n' +
    '}\n' +
    'Заполняй только поля, относящиеся к intent.\n\n' +
    'Правила:\n' +
    '- ВАЖНЕЙШЕЕ ПРАВИЛО для create_reminder: если в сообщении НЕТ указания времени — ' +
    'ни точного («в 15:00»), ни словесного («утром», «вечером», «через час») — ты ОБЯЗАН вернуть ' +
    'intent = clarify и спросить время. Выдумывать или подставлять время по умолчанию ЗАПРЕЩЕНО.\n' +
    '  Пример: «Напомни мне завтра встретиться с Петром» → {"intent": "clarify", ' +
    '"clarify_question": "Во сколько завтра напомнить о встрече с Петром?"} — здесь есть дата (завтра), но НЕТ времени.\n' +
    '- Все относительные даты («завтра», «через 2 часа», «в субботу») вычисляй от текущего времени выше.\n' +
    '- Словесные времена конвертируй ТОЛЬКО если пользователь сам употребил эти слова: ' +
    '«утром» = 09:00, «днём» = 13:00, «вечером» = 19:00.\n' +
    '- datetime — строго "YYYY-MM-DD HH:mm" в часовом поясе пользователя, всегда в будущем.\n' +
    '- Для повторяющегося напоминания: datetime = null, recurrence заполнено. Для разового: recurrence = null.\n' +
    '- В голосовом сообщении с несколькими делами (например «нужно А, потом Б, ещё В») — intent = create_task, ' +
    'каждое дело отдельным элементом tasks, формулировки короткие, в инфинитиве.\n' +
    '- reply — краткий, структурированный текст для Telegram: короткие абзацы, нумерованные списки или «•». ' +
    'Из разметки допустим только **жирный**. Без заголовков #, без таблиц. Отвечай на языке пользователя.\n' +
    '- confidence — твоя уверенность от 0 до 1.\n';

  if (isAudio) {
    p += '\nВо вложении — голосовое сообщение пользователя. Сначала полностью распознай его ' +
      '(поле transcript обязательно), затем определи intent по содержанию.\n';
  }
  if (contextNote) {
    p += '\nКонтекст диалога: ' + contextNote + '\n';
  }
  return p;
}

/**
 * Detect intent for a text message.
 * Returns validated intent object with ._model set.
 */
function detectIntentFromText_(user, text, contextNote) {
  const prompt = buildIntentPrompt_(user, contextNote, false) + '\nСообщение пользователя:\n' + text;
  const result = callGemini_([{ text: prompt }], { json: true });
  return validateIntent_(result);
}

/** Detect intent for a voice message (blob = OGG/Opus from Telegram). */
function detectIntentFromVoice_(user, blob, contextNote) {
  const prompt = buildIntentPrompt_(user, contextNote, true);
  const parts = [
    { text: prompt },
    { inline_data: { mime_type: 'audio/ogg', data: Utilities.base64Encode(blob.getBytes()) } }
  ];
  const result = callGemini_(parts, { json: true, audio: true });
  return validateIntent_(result);
}

/** Verbatim transcription (transcribe mode). Returns {text, model}. */
function transcribeVoice_(user, blob) {
  const prompt = 'Расшифруй это голосовое сообщение в текст максимально точно и дословно. ' +
    'Ничего не добавляй, не сокращай и не комментируй. Сохрани язык оригинала. ' +
    'Верни только текст расшифровки. Расставь знаки препинания.';
  const parts = [
    { text: prompt },
    { inline_data: { mime_type: 'audio/ogg', data: Utilities.base64Encode(blob.getBytes()) } }
  ];
  return callGemini_(parts, { audio: true, temperature: 0 });
}

/**
 * Parse and validate the model's JSON. Unknown/broken output degrades to a
 * clarify intent instead of crashing.
 */
function validateIntent_(geminiResult) {
  const obj = extractJson_(geminiResult.text);
  if (!obj || INTENTS_.indexOf(obj.intent) === -1) {
    return {
      intent: 'clarify',
      clarify_question: 'Я не понял запрос. Сформулируйте, пожалуйста, иначе.',
      confidence: 0,
      _model: geminiResult.model,
      _raw: String(geminiResult.text).substring(0, 500)
    };
  }
  obj._model = geminiResult.model;
  return obj;
}
