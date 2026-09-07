/**
 * GeminiService.gs — Gemini API with automatic model fallback.
 *
 * The model chain lives in the Models sheet (editable without code changes):
 *   Model | Text | Audio | Enabled | Priority
 *
 * Per-model failure counters are kept in ScriptProperties and healthy models
 * are tried first (pattern from the kids-de project). Error classification:
 *   401/403        → fatal: bad API key, no model will help
 *   429/5xx/404    → try the next model
 *   400            → try next once; two 400s in a row = bad request, fatal
 * One request never tries more than CONFIG.MAX_MODEL_ATTEMPTS models.
 */

const GEMINI_BASE_ = 'https://generativelanguage.googleapis.com/v1beta/models/';

/** Read the Models sheet (cached) → [{name, text, audio, priority}]. */
function getModelConfig_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('models_config');
  if (cached) return JSON.parse(cached);

  const rows = getAllRows_(getSheet_(SHEETS.MODELS));
  const models = [];
  for (let i = 0; i < rows.length; i++) {
    const enabled = rows[i][3] === true || String(rows[i][3]).toUpperCase() === 'TRUE' || rows[i][3] === '✅';
    if (!rows[i][0] || !enabled) continue;
    models.push({
      name: String(rows[i][0]).trim(),
      text: rows[i][1] === true || String(rows[i][1]).toUpperCase() === 'TRUE' || rows[i][1] === '✅',
      audio: rows[i][2] === true || String(rows[i][2]).toUpperCase() === 'TRUE' || rows[i][2] === '✅',
      priority: Number(rows[i][4]) || 99
    });
  }
  models.sort(function (a, b) { return a.priority - b.priority; });
  cache.put('models_config', JSON.stringify(models), CONFIG.MODELS_CACHE_TTL);
  return models;
}

// ===== Model health tracking (ScriptProperties) =====

/**
 * Raw counters: {model: {n: failCount, t: lastFailMillis}}.
 * Entries older than MODEL_FAIL_TTL_MS are expired, so a model penalized by
 * a transient error returns to its sheet priority within an hour.
 */
function modelFailsRaw_() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty('MODEL_FAILS') || '{}');
  } catch (e) { return {}; }
}

function modelFails_() {
  const raw = modelFailsRaw_();
  const now = Date.now();
  const counts = {};
  for (const model in raw) {
    if (raw[model] && raw[model].t && now - raw[model].t < CONFIG.MODEL_FAIL_TTL_MS) {
      counts[model] = raw[model].n || 0;
    }
  }
  return counts;
}

function bumpModelFail_(model) {
  const raw = modelFailsRaw_();
  const fresh = raw[model] && raw[model].t && Date.now() - raw[model].t < CONFIG.MODEL_FAIL_TTL_MS;
  raw[model] = { n: fresh ? (raw[model].n || 0) + 1 : 1, t: Date.now() };
  PropertiesService.getScriptProperties().setProperty('MODEL_FAILS', JSON.stringify(raw));
}

function clearModelFail_(model) {
  const raw = modelFailsRaw_();
  if (raw[model]) {
    delete raw[model];
    PropertiesService.getScriptProperties().setProperty('MODEL_FAILS', JSON.stringify(raw));
  }
}

/** Candidate models for a request: filtered by capability, healthy first. */
function orderedModels_(needAudio) {
  const fails = modelFails_();
  return getModelConfig_()
    .filter(function (m) { return needAudio ? m.audio : m.text; })
    .sort(function (a, b) {
      const fa = fails[a.name] || 0;
      const fb = fails[b.name] || 0;
      return fa !== fb ? fa - fb : a.priority - b.priority;
    })
    .slice(0, CONFIG.MAX_MODEL_ATTEMPTS);
}

/**
 * Call Gemini with fallback.
 * parts: generateContent parts array, e.g. [{text}, {inline_data:{...}}]
 * options: {audio?: bool, json?: bool, temperature?: number}
 * Returns {text, model}. Throws GeminiError with .userMessage on failure.
 */
function callGemini_(parts, options) {
  options = options || {};
  const key = getGeminiKey_();
  const models = orderedModels_(!!options.audio);
  if (!models.length) {
    throw geminiError_('No enabled models in the Models sheet',
      '⚠️ Нет доступных AI-моделей. Проверьте лист Models в таблице.');
  }

  const generationConfig = { temperature: options.temperature != null ? options.temperature : 0.2 };
  if (options.json) generationConfig.responseMimeType = 'application/json';

  const body = JSON.stringify({
    contents: [{ parts: parts }],
    generationConfig: generationConfig
  });

  let sawRateLimit = false;
  let badRequests = 0;
  let lastError = '';

  for (let i = 0; i < models.length; i++) {
    const model = models[i].name;
    try {
      const response = fetchWithRetry_(
        GEMINI_BASE_ + model + ':generateContent?key=' + encodeURIComponent(key),
        { method: 'post', contentType: 'application/json', payload: body, muteHttpExceptions: true },
        2); // 2 attempts per model — the fallback chain is the bigger retry
      const code = response.getResponseCode();

      if (code === 200) {
        const data = JSON.parse(response.getContentText());
        const text = data && data.candidates && data.candidates[0] &&
          data.candidates[0].content && data.candidates[0].content.parts &&
          data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
        if (!text) {
          lastError = model + ': empty candidates';
          bumpModelFail_(model);
          continue;
        }
        clearModelFail_(model);
        return { text: text, model: model };
      }

      lastError = model + ': HTTP ' + code + ' ' + response.getContentText().substring(0, 200);
      console.warn(lastError);

      if (code === 401 || code === 403) {
        throw geminiError_(lastError, '⚠️ Проблема с ключом Gemini API. Проверьте GEMINI_API_KEY.');
      }
      if (code === 400) {
        badRequests++;
        if (badRequests >= 2) {
          throw geminiError_(lastError, '⚠️ Не удалось обработать запрос (модели отклоняют его как некорректный).');
        }
        bumpModelFail_(model);
        continue;
      }
      if (code === 429) sawRateLimit = true;
      bumpModelFail_(model); // 429 / 404 / 5xx → next model
    } catch (e) {
      if (e && e.isGeminiFatal) throw e;
      lastError = model + ': ' + e.message; // network error, JSON parse, etc.
      console.warn(lastError);
      bumpModelFail_(model);
    }
  }

  throw geminiError_('All models failed. Last: ' + lastError,
    sawRateLimit
      ? '⚠️ Сейчас я не могу обработать запрос: все доступные AI-модели достигли лимита. Попробуйте немного позже.'
      : '⚠️ Сейчас я не могу обработать запрос: все доступные AI-модели временно недоступны. Попробуйте немного позже.');
}

function geminiError_(message, userMessage) {
  const err = new Error(message);
  err.isGeminiFatal = true;
  err.userMessage = userMessage;
  return err;
}
