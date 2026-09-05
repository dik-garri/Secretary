/**
 * Main.gs — webhook entry point and message routing.
 *
 * Pipeline: Telegram update → access check → (voice? download+transcribe)
 * → Gemini intent JSON → GAS validation → Action handler → reply.
 */

function doPost(e) {
  try {
    // Authenticate: only Telegram knows the ?token= secret baked into the
    // webhook URL by setWebhook(). Forged POSTs are dropped silently.
    const secret = getProp_('WEBHOOK_SECRET');
    if (!secret || !e.parameter || e.parameter.token !== secret) {
      logEvent_('', 'webhook_rejected', '', '', '', '', 'bad or missing token');
      return;
    }

    const update = JSON.parse(e.postData.contents);

    // Deduplicate: slow handling (voice + model fallback) can outlive
    // Telegram's webhook timeout, causing redelivery of the same update.
    if (update.update_id != null) {
      const cache = CacheService.getScriptCache();
      const key = 'upd_' + update.update_id;
      if (cache.get(key)) return;
      cache.put(key, '1', 3600);
    }

    if (update.message) handleMessage_(update.message);
    // CRITICAL: return nothing else — returning ContentService makes Telegram
    // queue pending updates (Pulse lesson #4).
  } catch (err) {
    logEvent_('', 'webhook_error', (e && e.postData && e.postData.contents || '').substring(0, 500),
      '', '', '', err.message + '\n' + err.stack);
  }
}

function doGet() {
  return ContentService.createTextOutput('AI Secretary is running.');
}

function handleMessage_(message) {
  const chatId = message.chat && message.chat.id;
  const from = message.from || {};
  if (!chatId || from.is_bot) return;
  // Personal secretary: private chats only. Also guarantees chat.id ==
  // from.id, so scheduled reminders always have a deliverable chat.
  if (message.chat.type !== 'private') return;

  // Private bot: only IDs from ALLOWED_USER_IDS are served.
  const allowed = getAllowedUserIds_();
  if (allowed.length && allowed.indexOf(String(from.id)) === -1) {
    logEvent_(from.id, 'access_denied', message.text || '(non-text)', '', '', '', '');
    sendMessage_(chatId, '⛔ Это приватный бот. Ваш Telegram ID: ' + from.id);
    return;
  }
  if (!allowed.length) {
    // Not configured yet — help the owner find their ID, serve nobody.
    sendMessage_(chatId, '⚙️ Бот ещё не настроен. Добавьте в Script Properties ключ ' +
      'ALLOWED_USER_IDS со значением: ' + from.id);
    return;
  }

  const name = [from.first_name, from.last_name].filter(String).join(' ') || from.username || '';
  const user = ensureUser_(from.id, name);

  try {
    if (message.voice) {
      handleVoice_(user, chatId, message.voice);
    } else if (message.text) {
      handleText_(user, chatId, message.text);
    } else {
      sendMessage_(chatId, '🤷 Пока я понимаю только текст и голосовые сообщения.');
    }
  } catch (err) {
    const userMessage = err.userMessage ||
      '⚠️ Что-то пошло не так. Попробуйте ещё раз чуть позже.';
    sendMessage_(chatId, userMessage);
    logEvent_(user.telegramId, 'handler_error', message.text || '(voice)', '', '', '', err.message + '\n' + (err.stack || ''));
  }
}

// ===== Text =====

function handleText_(user, chatId, text) {
  const trimmed = text.trim();

  // Minimal command surface; everything else is natural language.
  if (trimmed === '/start' || trimmed === '/help') {
    clearState_(user.telegramId);
    sendMessage_(chatId, helpText_());
    return;
  }
  if (trimmed === '/id') {
    sendMessage_(chatId, 'Ваш Telegram ID: ' + user.telegramId);
    return;
  }

  sendTyping_(chatId);
  const pending = getState_(user.telegramId);
  const intent = detectIntentFromText_(user, trimmed, clarifyContextNote_(pending));
  intent._sourceText = trimmed;
  attachClarifyChain_(intent, pending);

  // A non-clarify intent resolves any pending clarification (handlers may
  // set a fresh clarify state via askClarify_ afterwards).
  if (intent.intent !== 'clarify') clearState_(user.telegramId);

  const reply = executeIntent_(user, intent);
  sendMessage_(chatId, reply);
  logEvent_(user.telegramId, 'text', trimmed, intent.intent, intent._model, reply, '');
}

// ===== Voice =====

function handleVoice_(user, chatId, voice) {
  if (voice.file_size && voice.file_size > CONFIG.MAX_VOICE_FILE_BYTES) {
    sendMessage_(chatId, '⚠️ Голосовое слишком большое для обработки. Отправьте покороче.');
    return;
  }

  sendTyping_(chatId);
  const blob = getFileBlob_(voice.file_id);
  const state = getState_(user.telegramId);

  // Transcription mode: verbatim transcript, no interpretation.
  if (state && state.mode === 'transcribe') {
    clearState_(user.telegramId);
    const result = transcribeVoice_(user, blob);
    sendMessage_(chatId, formatTranscript_(result.text.trim(), null));
    logEvent_(user.telegramId, 'voice_transcribe', '(voice ' + (voice.duration || '?') + 's)',
      'transcribe', result.model, result.text, '');
    return;
  }

  const pending = getState_(user.telegramId);
  const intent = detectIntentFromVoice_(user, blob, clarifyContextNote_(pending));
  intent._sourceText = intent.transcript || '(voice)';
  attachClarifyChain_(intent, pending);

  if (intent.intent !== 'clarify') clearState_(user.telegramId);

  let reply = executeIntent_(user, intent);
  // Show what was heard so the user can catch recognition errors.
  if (intent.transcript) {
    reply = '🎤 **Распознанный текст:**\n' + intent.transcript + '\n\n' + reply;
  }
  sendMessage_(chatId, reply);
  logEvent_(user.telegramId, 'voice', intent.transcript || '(voice)',
    intent.intent, intent._model, reply, '');
}

/** If a clarifying question is pending, describe it for the AI prompt. */
function clarifyContextNote_(pending) {
  if (pending && pending.mode === 'clarify') {
    return 'Предыдущие сообщения пользователя: «' + (pending.original || '') + '». ' +
      'Бот задал уточняющий вопрос: «' + pending.question + '». ' +
      'Текущее сообщение — ответ на этот вопрос: объедини все части и определи итоговый intent.';
  }
  return '';
}

/** Carry the clarify-dialog history into the intent for askClarify_. */
function attachClarifyChain_(intent, pending) {
  if (pending && pending.mode === 'clarify' && pending.original) {
    intent._prevOriginal = pending.original;
  }
}
