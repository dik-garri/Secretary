# AI Secretary — development context

Telegram bot on Google Apps Script (V8) + Google Sheets (storage) + Gemini API
(intelligence). No server, no database, free-tier Gemini models only. Bot UI
language is Russian; code comments are English.

## Core design rules

- **Intent pipeline**: user message → one Gemini call → strict JSON
  (`intent` + payload + `transcript` for voice) → validated in GAS →
  `Actions.gs` handler → reply. Gemini never writes to Sheets.
- **Extending the bot** = add intent to prompt in `AIService.gs`, add handler
  in `Actions.gs`, register in `ACTION_HANDLERS_`. No other file changes.
- **Model fallback** lives in `GeminiService.gs`; the chain is data in the
  `Models` sheet (Model|Text|Audio|Enabled|Priority), failure counters in
  ScriptProperties `MODEL_FAILS`, max 5 attempts/request. Pattern taken from
  the `kids-de` project. 401/403 and double-400 are fatal; 429/404/5xx rotate.
- **Datetimes** are stored as `yyyy-MM-dd HH:mm` strings in the user's
  timezone (Users sheet, default Asia/Bishkek); comparisons via epoch millis
  (`parseDateTimeInTz_`). Datetime columns are set to text format in `setup()`,
  but `cellToDateTimeString_` still tolerates Date objects from Sheets.
- **Dialog state** (clarify context, transcribe mode) is in ScriptProperties
  `state_<chatId>` — webhook runs anonymously, UserProperties would be empty.
- **doPost returns nothing** — returning ContentService makes Telegram queue
  pending updates (see ../Pulse/LESSONS_LEARNED.md for this and other GAS
  gotchas: Sheets Date objects, UTC via Utilities.formatDate, single
  JSON.stringify for keyboards).

## Testing

- `Tests.gs` → `runTests()` in the GAS editor (pure functions only).
- Locally: the same tests run under Node with a stubbed `Utilities.formatDate`
  (Intl-based). Harness pattern: concat Utils.gs + MessageFormatter.gs +
  Tests.gs, stub PropertiesService/CacheService, eval, call runTests().
- No local GAS runtime — anything touching SpreadsheetApp/UrlFetchApp is
  verified manually in the editor (`debugReminders()`, `getWebhookInfo()`).

## Deployment

clasp is configured (.clasp.json in repo root; container-bound script attached
to the DB spreadsheet, so SPREADSHEET_ID property is optional). Workflow:
`clasp push -f` to upload, `clasp deploy -i <deploymentId>` to update the
EXISTING web app deployment (keeps the URL — never deploy without -i, that
mints a new URL and breaks the webhook). URLs and deploymentId are in README.
Script Properties: TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, ALLOWED_USER_IDS,
WEBAPP_URL (+ auto-generated WEBHOOK_SECRET). Secrets are set manually in the
editor; first setup() run triggers the OAuth grant.

## Reference projects (parent directory)

- `../Pulse` — GAS reminder bot, source of most patterns and gotchas.
- `../kids-de` — Gemini model rotation with health tracking (index.html ~620).
- `../growth-coach` — minimal GAS Gemini call.
