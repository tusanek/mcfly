import test from 'node:test';
import assert from 'node:assert/strict';
import { numWords, plural, dateWords, timeWords, numGenitive, speakable, clipSentences } from '../src/speech.js';

test('numWords: числа словами, род, тысячи', () => {
  assert.equal(numWords(0), 'ноль');
  assert.equal(numWords(2), 'два');
  assert.equal(numWords(2, 'f'), 'две');
  assert.equal(numWords(1, 'n'), 'одно');
  assert.equal(numWords(14), 'четырнадцать');
  assert.equal(numWords(21), 'двадцать один');
  assert.equal(numWords(429), 'четыреста двадцать девять');
  assert.equal(numWords(2001), 'две тысячи один');
  assert.equal(numWords(21000), 'двадцать одна тысяча');
  assert.equal(numWords(-5), 'минус пять');
});

test('plural, dateWords, timeWords', () => {
  const w = ['прогон', 'прогона', 'прогонов'];
  assert.deepEqual([1, 2, 5, 11, 21, 104].map((n) => plural(n, w)), ['прогон', 'прогона', 'прогонов', 'прогонов', 'прогон', 'прогона']);
  assert.equal(dateWords(16, 11), 'шестнадцатого ноября');
  assert.equal(dateWords(1, 1), 'первого января');
  assert.equal(dateWords(23, 2), 'двадцать третьего февраля');
  assert.equal(dateWords(30, 4), 'тридцатого апреля');
  assert.equal(dateWords(31, 12), 'тридцать первого декабря');
  assert.equal(dateWords(40, 1), '');
  assert.equal(timeWords(4, 0), 'четыре ноль ноль');
  assert.equal(timeWords(9, 5), 'девять ноль пять');
  assert.equal(timeWords(19, 30), 'девятнадцать тридцать');
});

test('numGenitive: «из шести», «до двадцати одного»', () => {
  assert.deepEqual([1, 6, 20, 21, 99].map(numGenitive), ['одного', 'шести', 'двадцати', 'двадцати одного', 'девяноста девяти']);
});

test('speakable: в тексте для диктора не остаётся цифр, латиницы и разметки', () => {
  const src = '☀️ <b>Проект</b> · 16.11 — прогон 04:00 прошёл за 55 мин, готово 70% задач (`src/cli.js`, README.md), версия 0.11.3, сделано 3 из 6 &amp; ещё';
  const out = speakable(src);
  assert.doesNotMatch(out, /[0-9A-Za-z<>`&]/);
  assert.match(out, /шестнадцатого ноября/);
  assert.match(out, /четыре ноль ноль/);
  assert.match(out, /пятьдесят пять мин/);
  assert.match(out, /семьдесят процентов/);
  assert.match(out, /ноль точка одиннадцать точка три/);
  assert.match(out, /три из шести/);
});

test('speakable: иностранные слова читаются только по словарю, остальные пропускаются', () => {
  assert.equal(speakable('Проект mcfly готов'), 'Проект макфл+ай готов');
  assert.equal(speakable('Проект Acme готов', { acme: '+акме' }), 'Проект +акме готов');
  assert.equal(speakable('mcfly', { mcfly: 'мак флай' }), 'мак флай');
  assert.equal(speakable('Одобрить restore-removed-repeat и проверить'), 'Одобрить и проверить');
  assert.equal(speakable('версия v2 в ветке main готова'), 'версия в ветке готова');
  assert.equal(speakable('встречи из «Google Календаря»'), 'встречи из «гугл Календаря»');
  assert.equal(speakable('2 + 2'), 'два плюс два');
});

test('clipSentences: по границе предложения, иначе по слову', () => {
  assert.equal(clipSentences('Раз два. Три четыре. Пять шесть.', 22), 'Раз два. Три четыре.');
  assert.equal(clipSentences('Коротко.', 50), 'Коротко.');
  assert.equal(clipSentences('Одно очень длинное предложение без точки в середине', 20), 'Одно очень длинное…');
});
