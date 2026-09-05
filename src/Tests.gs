/**
 * Tests.gs — run runTests() in the GAS editor. Covers the pure logic that
 * breaks most often (time math, recurrence, splitting, JSON extraction).
 */

let testsPassed_ = 0;
let testsFailed_ = 0;

function assertEqual_(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    testsPassed_++;
  } else {
    testsFailed_++;
    console.error('FAIL ' + label + '\n  expected: ' + JSON.stringify(expected) + '\n  actual:   ' + JSON.stringify(actual));
  }
}

function assertTrue_(value, label) {
  assertEqual_(!!value, true, label);
}

function runTests() {
  testsPassed_ = 0;
  testsFailed_ = 0;
  const TZ = 'Asia/Bishkek'; // UTC+6, no DST

  // --- parseDateTimeInTz_ / formatTz_ round-trip ---
  const ms = parseDateTimeInTz_('2026-09-05 18:00', TZ);
  assertEqual_(formatTz_(ms, TZ, 'yyyy-MM-dd HH:mm'), '2026-09-05 18:00', 'tz round-trip');
  assertEqual_(formatTz_(ms, 'UTC', 'HH:mm'), '12:00', 'Bishkek 18:00 = 12:00 UTC');
  assertEqual_(parseDateTimeInTz_('garbage', TZ), null, 'parse garbage → null');
  assertEqual_(parseDateTimeInTz_('2026-09-05T09:30', TZ), parseDateTimeInTz_('2026-09-05 09:30', TZ), 'T separator accepted');

  // --- cellToDateTimeString_ ---
  assertEqual_(cellToDateTimeString_(new Date(2026, 8, 5, 18, 0)), '2026-09-05 18:00', 'Date cell → string');
  assertEqual_(cellToDateTimeString_('2026-09-05 18:00'), '2026-09-05 18:00', 'string cell passthrough');
  assertEqual_(cellToDateTimeString_(''), '', 'empty cell');

  // --- nextOccurrence_ (2026-09-05 is a Saturday) ---
  const sat12 = parseDateTimeInTz_('2026-09-05 12:00', TZ);
  assertEqual_(nextOccurrence_({ type: 'WEEKLY', days: ['SAT'], time: '10:00' }, sat12, TZ),
    '2026-09-12 10:00', 'weekly SAT 10:00 asked at SAT 12:00 → next Saturday');
  assertEqual_(nextOccurrence_({ type: 'WEEKLY', days: ['SAT'], time: '15:00' }, sat12, TZ),
    '2026-09-05 15:00', 'weekly SAT 15:00 asked at SAT 12:00 → today');
  assertEqual_(nextOccurrence_({ type: 'DAILY', time: '09:00' }, sat12, TZ),
    '2026-09-06 09:00', 'daily 09:00 asked at 12:00 → tomorrow');
  assertEqual_(nextOccurrence_({ type: 'WEEKDAYS', time: '08:00' }, sat12, TZ),
    '2026-09-07 08:00', 'weekdays asked on Saturday → Monday');
  assertEqual_(nextOccurrence_({ type: 'MONTHLY', day_of_month: 31, time: '10:00' }, sat12, TZ),
    '2026-09-30 10:00', 'monthly 31st clamps to Sep 30');
  assertEqual_(nextOccurrence_({ type: 'WEEKLY', days: [], time: '10:00' }, sat12, TZ), null, 'weekly without days → null');
  assertEqual_(nextOccurrence_(null, sat12, TZ), null, 'null recurrence → null');
  assertEqual_(nextOccurrence_({ type: 'DAILY', time: 'noon' }, sat12, TZ), null, 'bad time → null');

  // --- splitMessage_ ---
  assertEqual_(splitMessage_('short', 100), ['short'], 'short message untouched');
  const paragraphs = 'aaaa\n\nbbbb\n\ncccc';
  assertEqual_(splitMessage_(paragraphs, 11), ['aaaa\n\nbbbb', 'cccc'], 'split at paragraph');
  const longWord = 'x'.repeat(25);
  assertEqual_(splitMessage_(longWord, 10).length, 3, 'hard cut for a giant word');
  splitMessage_('a b c d e f', 4).forEach(function (c) {
    assertTrue_(c.length <= 4, 'chunk within limit: "' + c + '"');
  });

  // --- toTelegramHtml_ / escapeHtml_ ---
  assertEqual_(toTelegramHtml_('**bold** & <tag>'), '<b>bold</b> &amp; &lt;tag&gt;', 'bold + escaping');
  assertEqual_(toTelegramHtml_('2 ** 3 = 8'), '2 ** 3 = 8', 'lone ** untouched');

  // --- extractJson_ ---
  assertEqual_(extractJson_('{"a":1}'), { a: 1 }, 'plain JSON');
  assertEqual_(extractJson_('```json\n{"a":1}\n```'), { a: 1 }, 'fenced JSON');
  assertEqual_(extractJson_('Вот ответ: {"a":1} — готово'), { a: 1 }, 'JSON inside prose');
  assertEqual_(extractJson_('no json here'), null, 'no JSON → null');

  // --- fuzzyMatch_ / wordsMatch_ (Russian case endings) ---
  assertTrue_(wordsMatch_('петра', 'петром'), 'петра ~ петром');
  assertTrue_(wordsMatch_('Пётр', 'петре'), 'Пётр ~ петре (ё → е)');
  assertEqual_(wordsMatch_('парта', 'парк'), false, 'парта !~ парк');
  assertTrue_(fuzzyMatch_('Встретиться с Петром', 'петра'), 'query петра finds Петром');
  assertTrue_(fuzzyMatch_('Проверить отчёт', 'отчета'), 'отчета finds отчёт');
  assertTrue_(fuzzyMatch_('Позвонить Андрею', 'про андрея'), 'short «про» does not block');
  assertEqual_(fuzzyMatch_('Купить продукты', 'петра'), false, 'no false positive');
  assertEqual_(fuzzyMatch_('Позвонить маме', 'позвонить папе'), false, 'both words required');

  // --- describeRecurrence_ ---
  assertEqual_(describeRecurrence_({ type: 'WEEKLY', days: ['SAT'], time: '10:00' }),
    'Каждую неделю: субботу в 10:00', 'describe weekly');
  assertEqual_(describeRecurrence_({ type: 'DAILY', time: '08:30' }), 'Каждый день в 08:30', 'describe daily');

  console.log('Tests: ' + testsPassed_ + ' passed, ' + testsFailed_ + ' failed');
  if (testsFailed_ > 0) throw new Error(testsFailed_ + ' test(s) failed — see log above');
}
