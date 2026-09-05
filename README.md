# Секретарь — AI Telegram-бот на Google Apps Script

Персональный секретарь в Telegram: понимает обычную речь (текст и голосовые),
создаёт напоминания и задачи, структурирует мысли, расшифровывает голосовые.
Без сервера и без базы данных: Google Apps Script + Google Sheets + Gemini API.

## Архитектура

```
Telegram (text/voice)
        │ webhook
        ▼
Google Apps Script
  Main.gs ──► AIService (Gemini, intent JSON) ──► Actions (реестр intent → handler)
        │                                             │
  SchedulerService (триггер каждые 10 мин)            ▼
        │                                       Google Sheets
        └──► отправка напоминаний ◄─────────── (Reminders/Tasks/Users/Logs/Models)
```

Принцип: Gemini возвращает структурированный JSON (`intent` + данные),
GAS валидирует его и выполняет действие. Модель никогда не пишет в таблицу сама.

## Файлы

| Файл | Назначение |
|------|-----------|
| `Main.gs` | Точка входа `doPost`, роутинг сообщений, контроль доступа |
| `Config.gs` | Константы и доступ к Script Properties |
| `AIService.gs` | Промпт, определение intent, валидация JSON |
| `GeminiService.gs` | Вызов Gemini с автоматическим fallback между моделями |
| `Actions.gs` | Реестр intent → handler (точка расширения бота) |
| `ReminderService.gs` | CRUD напоминаний, расчёт повторений |
| `TaskService.gs` | CRUD задач |
| `SchedulerService.gs` | Триггер `checkReminders`, защита от повторной отправки |
| `TelegramService.gs` | Telegram Bot API, скачивание голосовых, webhook |
| `SheetsService.gs` | Абстракция над Sheets, `setup()`, состояние диалога |
| `MessageFormatter.gs` | HTML-экранирование, разбивка длинных сообщений, шаблоны |
| `Utils.gs` | Время/таймзоны, расчёт следующего повторения, логи |
| `Tests.gs` | Тесты чистых функций — `runTests()` в редакторе GAS |

## Текущее окружение

Проект уже создан через `clasp` (контейнерный скрипт, привязанный к таблице):

- Таблица (база данных): https://drive.google.com/open?id=1sBJJv6mh-TL-Vyx3ax1ihU7x_U4bfYg14eCEtZMwu2Y
- Редактор скрипта: https://script.google.com/d/1GUp9fpSmZa-JTLhrLH05GwlaRNp5KGNC9V-js500KatKtJzDWhEZ7TAX/edit
- Web app (webhook URL): `https://script.google.com/macros/s/AKfycbx7y_471-jfguxIuPzT2iU__-wf1hb7dEcYJUi-tRsHz87P4wbwBEnlYSB_uXw7j6SqCQ/exec`

Скрипт привязан к таблице, поэтому `SPREADSHEET_ID` задавать не нужно.

## Развёртывание (что осталось сделать вручную)

1. **Бот**: в @BotFather создайте бота → получите токен.
2. **Gemini**: получите API key в [Google AI Studio](https://aistudio.google.com/apikey).
3. **Script Properties** (в редакторе: Project Settings → Script Properties):

   | Ключ | Значение |
   |------|----------|
   | `TELEGRAM_BOT_TOKEN` | токен из BotFather |
   | `GEMINI_API_KEY` | ключ Gemini |
   | `ALLOWED_USER_IDS` | ваш Telegram ID (не знаете — бот подскажет при первом сообщении) |
   | `WEBAPP_URL` | URL web app (см. выше) |

4. В редакторе запустите `setup()` — при первом запуске Google попросит
   авторизовать скрипт (это обязательный шаг, без него webhook не заработает).
   Функция создаст листы и заполнит `Models`.
5. Запустите `setWebhook()` — он сам сгенерирует секрет `WEBHOOK_SECRET`
   (защита webhook от посторонних POST-запросов). Проверьте `getWebhookInfo()`.
6. Запустите `setupTrigger()` — включит проверку напоминаний каждые 10 минут.
7. Напишите боту. Если `ALLOWED_USER_IDS` ещё пуст — бот покажет ваш ID,
   добавьте его в свойство и напишите снова.

## Работа с кодом через clasp

```bash
clasp push -f        # залить локальные изменения src/ в GAS
clasp open-script    # открыть редактор
clasp deploy -i AKfycbx7y_471-jfguxIuPzT2iU__-wf1hb7dEcYJUi-tRsHz87P4wbwBEnlYSB_uXw7j6SqCQ \
  --description "update"   # обновить СУЩЕСТВУЮЩИЙ деплой (URL сохраняется!)
```

Важно: обновляйте существующий деплой через `-i <deploymentId>` — тогда URL
web app не меняется и webhook перенастраивать не нужно. `clasp deploy` без
`-i` создаст новый деплой с новым URL.

## Лист Models (fallback без правки кода)

| Model | Text | Audio | Enabled | Priority |
|-------|------|-------|---------|----------|
| gemini-3.5-flash-lite | TRUE | TRUE | TRUE | 1 |
| … | | | | |

При quota/rate-limit/5xx бот автоматически пробует следующую модель
(не более 5 попыток на запрос). «Здоровье» моделей запоминается: проблемные
уходят в конец очереди, успешные возвращаются. Изменения листа подхватываются
в течение 5 минут (кэш).

## Напоминания

- Разовые: «напомни завтра в 9…», «через 2 часа…», конкретной датой.
- Повторяющиеся: каждый день / по будням / дни недели / число месяца.
  Формат в колонке Recurrence — JSON, например
  `{"type":"WEEKLY","days":["SAT"],"time":"10:00"}`.
- Точность — интервал триггера (10 мин). Защита от дублей: LockService +
  отметка LastSent **до** отправки + пропуск всего, что отправлялось за
  последние 15 минут (это же ограничивает частоту повторных попыток при
  сбоях доставки). Постоянные ошибки доставки (бот заблокирован) переводят
  напоминание в статус ERROR.
- Даты хранятся строками `yyyy-MM-dd HH:mm` в поясе пользователя
  (колонка Timezone листа Users; по умолчанию Asia/Bishkek).

## Как добавить новую функцию

1. Опишите новый intent в промпте (`AIService.gs → buildIntentPrompt_`) и
   добавьте его имя в `INTENTS_`.
2. Напишите handler `(user, intent) → строка ответа` в `Actions.gs`.
3. Зарегистрируйте его в `ACTION_HANDLERS_`.

Существующие reminder/task/voice-механизмы при этом не затрагиваются.

## Отладка

- `runTests()` — тесты чистой логики (время, повторения, разбивка сообщений).
- `debugReminders()` — почему напоминание (не) отправляется прямо сейчас.
- Лист `Logs` — каждый запрос: вход, intent, использованная модель, ответ, ошибки.
- `getWebhookInfo()` — состояние webhook (pending updates, последняя ошибка).
