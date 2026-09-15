/**
 * AIService.gs — prompts, intent detection, JSON validation.
 *
 * One Gemini call per user message: the model returns intent AND payload
 * (and, for voice, the transcript) in a single JSON object. GAS validates
 * the JSON and executes the action — the model never touches Sheets.
 *
 * MCP-style contract: the list of intents, their descriptions and parameter
 * schemas shown to the model are GENERATED from the TOOLS_ registry
 * (Actions.gs). The same registry validates the response and routes it, so
 * prompt, validation and code can never drift apart.
 */

/** Intent names the model is allowed to return (registry + the multi wrapper). */
function knownIntents_() {
  return TOOLS_.map(function (t) { return t.name; }).concat(['multi']);
}

/** Render the tool registry as the prompt's capability list. */
function renderToolList_() {
  return TOOLS_.map(function (t) {
    let line = '- ' + t.name + ' — ' + t.desc;
    const params = Object.keys(t.params || {});
    if (params.length) {
      line += '\n  Параметры: ' + params.map(function (p) {
        return p + ': ' + t.params[p];
      }).join('; ');
    }
    return line;
  }).join('\n');
}

function buildIntentPrompt_(user, contextNote, isAudio) {
  const now = nowInfo_(user.timezone);
  let p =
    'Ты — AI-ядро персонального Telegram-секретаря. Пользователь пишет обычным языком, ' +
    'без команд. Определи намерение и верни СТРОГО один JSON-объект, без markdown и пояснений.\n\n' +
    'Текущая дата и время: ' + now.datetime + ' (' + now.weekday + ')\n' +
    'Часовой пояс пользователя: ' + now.tz + '\n\n' +
    'Доступные intent (используй ТОЛЬКО их):\n' +
    renderToolList_() + '\n' +
    '- multi — в сообщении НЕСКОЛЬКО независимых команд. Верни ' +
    '{"intent": "multi", "actions": [полные intent-объекты по порядку]}. Примеры:\n' +
    '  «удали все задачи и добавь задачу доработать видео» → {"intent": "multi", "actions": [' +
    '{"intent": "delete_task", "query": "", "all": true}, ' +
    '{"intent": "create_task", "tasks": [{"text": "Доработать видео", "priority": "NORMAL", "due": null}]}]}\n' +
    '  «напомни 5-го и 10-го ноября в 9 утра сдать документы» → multi из ДВУХ create_reminder ' +
    '(2026-11-05 09:00 и 2026-11-10 09:00). Перечисление дат = отдельные разовые напоминания, ' +
    'НЕ recurrence! MONTHLY только при явном «каждый месяц» / «каждое 5-е число»\n\n' +
    'Формат ответа — один JSON-объект:\n' +
    '{"intent": "<имя intent>", ...параметры выбранного intent (см. список выше), ' +
    '"transcript": "(только для аудио) полный распознанный текст", "confidence": 0..1}\n' +
    'Заполняй только параметры выбранного intent.\n\n' +
    'Правила:\n' +
    '- ВАЖНЕЙШЕЕ ПРАВИЛО для create_reminder: если в сообщении НЕТ указания времени — ' +
    'ни точного («в 15:00»), ни словесного («утром», «вечером», «через час») — ты ОБЯЗАН вернуть ' +
    'intent = clarify и спросить время. Выдумывать или подставлять время по умолчанию ЗАПРЕЩЕНО. ' +
    'Это касается и recurrence.time, и нескольких напоминаний сразу ' +
    '(«напомни 5-го и 10-го ноября сдать документы» → один clarify: «Во сколько напомнить 5 и 10 ноября?»).\n' +
    '  Пример: «Напомни мне завтра встретиться с Петром» → {"intent": "clarify", ' +
    '"clarify_question": "Во сколько завтра напомнить о встрече с Петром?"} — здесь есть дата (завтра), но НЕТ времени.\n' +
    '- Все относительные даты («завтра», «через 2 часа», «в субботу») вычисляй от текущего времени выше.\n' +
    '- Словесные времена конвертируй ТОЛЬКО если пользователь сам употребил эти слова: ' +
    '«утром» = 09:00, «днём» = 13:00, «вечером» = 19:00.\n' +
    '- datetime — строго "YYYY-MM-DD HH:mm" в часовом поясе пользователя, всегда в будущем.\n' +
    '- Для повторяющегося напоминания: datetime = null, recurrence заполнено. Для разового: recurrence = null.\n' +
    '- В голосовом сообщении с несколькими делами (например «нужно А, потом Б, ещё В») — intent = create_task, ' +
    'каждое дело отдельным элементом tasks, формулировки короткие, в инфинитиве.\n' +
    '- В query для delete/complete/update/search клади ТОЛЬКО слова, идентифицирующие конкретный ' +
    'элемент по содержанию. Служебные слова («все», «три», «задачи», «напоминания») в query не пиши: ' +
    '«удали все три задачи» → {"query": "", "all": true}; «удали задачу про видео» → {"query": "видео"}.\n' +
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
  const invalid = {
    intent: 'clarify',
    clarify_question: 'Я не понял запрос. Сформулируйте, пожалуйста, иначе.',
    confidence: 0,
    _model: geminiResult.model,
    _raw: String(geminiResult.text).substring(0, 500)
  };
  const known = knownIntents_();
  if (!obj || known.indexOf(obj.intent) === -1) return invalid;

  if (obj.intent === 'multi') {
    obj.actions = (obj.actions || []).filter(function (a) {
      return a && a.intent !== 'multi' && known.indexOf(a.intent) !== -1;
    }).slice(0, 5);
    if (!obj.actions.length) return invalid;
    if (obj.actions.length === 1) {
      obj.actions[0]._model = geminiResult.model;
      return obj.actions[0]; // single action wrapped in multi — unwrap
    }
  }

  obj._model = geminiResult.model;
  return obj;
}
