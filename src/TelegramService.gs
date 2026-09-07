/**
 * TelegramService.gs — all Telegram Bot API interaction.
 * Outgoing text goes through MessageFormatter for HTML conversion and
 * splitting; callers pass "app markdown" (plain text + **bold**).
 */

function telegramApi_() {
  return 'https://api.telegram.org/bot' + getBotToken_();
}

function telegramFileApi_() {
  return 'https://api.telegram.org/file/bot' + getBotToken_();
}

/** Low-level call with transient-error retry. Returns parsed JSON response. */
function tgCall_(method, payload) {
  const response = fetchWithRetry_(telegramApi_() + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const data = JSON.parse(response.getContentText());
  if (!data.ok) {
    console.error('Telegram ' + method + ' failed: ' + response.getContentText().substring(0, 300));
  }
  return data;
}

/**
 * Send a (possibly long) message. Splits app markdown BEFORE HTML conversion
 * (so tags are never severed mid-chunk), converts each chunk, sends.
 * Returns {ok: bool, errorCode: number|null} — errorCode from the last
 * failed chunk (403 = blocked/no chat, permanent).
 */
function sendMessage_(chatId, text) {
  const chunks = splitMessage_(text, CONFIG.TELEGRAM_SPLIT_LENGTH);
  let ok = true;
  let errorCode = null;
  for (let i = 0; i < chunks.length; i++) {
    let data = tgCall_('sendMessage', {
      chat_id: chatId,
      text: toTelegramHtml_(chunks[i]),
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    // HTML can break if the model emitted stray angle brackets — retry plain.
    if (!data.ok) {
      data = tgCall_('sendMessage', {
        chat_id: chatId,
        text: chunks[i].replace(/\*\*/g, ''),
        disable_web_page_preview: true
      });
    }
    if (!data.ok) {
      ok = false;
      errorCode = data.error_code || null;
    }
  }
  return { ok: ok, errorCode: errorCode };
}

/** "typing…" indicator while Gemini works. */
function sendTyping_(chatId) {
  try {
    tgCall_('sendChatAction', { chat_id: chatId, action: 'typing' });
  } catch (e) { /* cosmetic only */ }
}

/**
 * Download a Telegram file (voice message) as a Blob.
 * Returns {blob, fileSize} or throws.
 */
function getFileBlob_(fileId) {
  const info = tgCall_('getFile', { file_id: fileId });
  if (!info.ok || !info.result.file_path) throw new Error('getFile failed for ' + fileId);
  const response = fetchWithRetry_(telegramFileApi_() + '/' + info.result.file_path, {
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('File download failed: HTTP ' + response.getResponseCode());
  }
  return response.getBlob();
}

// ===== Webhook management (run manually from the editor) =====

function setWebhook() {
  const url = getRequiredProp_('WEBAPP_URL');
  // GAS can't read request headers, so Telegram's secret_token header is
  // useless here — a URL query secret authenticates the webhook instead.
  let secret = getProp_('WEBHOOK_SECRET');
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '');
    PropertiesService.getScriptProperties().setProperty('WEBHOOK_SECRET', secret);
  }
  const hookUrl = url + (url.indexOf('?') === -1 ? '?' : '&') + 'token=' + secret;
  const result = UrlFetchApp.fetch(
    telegramApi_() + '/setWebhook?url=' + encodeURIComponent(hookUrl) +
    '&allowed_updates=' + encodeURIComponent(JSON.stringify(['message'])) +
    '&drop_pending_updates=true');
  console.log(result.getContentText());
}

function deleteWebhook() {
  console.log(UrlFetchApp.fetch(telegramApi_() + '/deleteWebhook').getContentText());
}

function getWebhookInfo() {
  console.log(UrlFetchApp.fetch(telegramApi_() + '/getWebhookInfo').getContentText());
}
