/**
 * AIService.gs — prompts, intent detection, JSON validation.
 *
 * One Gemini call per user message: the model returns intent AND payload
 * (and, for voice, the transcript) in a single JSON object. GAS validates
 * the JSON and executes the action — the model never touches Sheets.
 */

const INTENTS_ = [
  'create_reminder', 'list_reminders', 'delete_reminder',
  'create_task', 'complete_task', 'list_tasks',
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
    '- delete_reminder — удалить/отменить напоминание (query — по каким словам искать)\n' +
    '- create_task — добавить задачу или несколько задач (tasks — массив формулировок)\n' +
    '- complete_task — отметить задачу выполненной (query — по каким словам искать)\n' +
    '- list_tasks — показать открытые задачи\n' +
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
    '  "tasks": ["..."],\n' +
    '  "query": "...",\n' +
    '  "reply": "...",\n' +
    '  "clarify_question": "...",\n' +
    '  "confidence": 0.0\n' +
    '}\n' +
    'Заполняй только поля, относящиеся к intent.\n\n' +
    'Правила:\n' +
    '- Все относительные даты («завтра», «через 2 часа», «в субботу», «вечером») вычисляй от текущего времени выше. ' +
    '«Вечером» = 19:00, «утром» = 09:00, «днём» = 13:00, если точнее не сказано.\n' +
    '- datetime — строго "YYYY-MM-DD HH:mm" в часовом поясе пользователя, всегда в будущем.\n' +
    '- Для повторяющегося напоминания: datetime = null, recurrence заполнено. Для разового: recurrence = null.\n' +
    '- Если для напоминания не указано время и его нельзя разумно вывести — intent = clarify, ' +
    'спроси время. Не выдумывай время сам.\n' +
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
