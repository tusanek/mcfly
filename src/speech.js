// 0.12.0: текст для диктора. Локальный синтезатор речи читает только русские буквы: цифры и латиницу он молча пропускает,
// поэтому числа, время, даты и иностранные слова здесь превращаются в русские слова.

const ONES = { m: ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'], f: ['ноль', 'одна', 'две'], n: ['ноль', 'одно', 'два'] };
const TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

/** Слово по числу: plural(2, ['прогон', 'прогона', 'прогонов']) → «прогона». */
export function plural(n, [one, few, many]) {
  const a = Math.abs(n) % 100; const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

function below1000(n, gender) {
  const out = [];
  if (n >= 100) out.push(HUNDREDS[Math.floor(n / 100)]);
  const r = n % 100;
  if (r >= 10 && r < 20) out.push(TEENS[r - 10]);
  else {
    if (r >= 20) out.push(TENS[Math.floor(r / 10)]);
    const o = r % 10;
    if (o) out.push(ONES[gender][o] || ONES.m[o]);
  }
  return out;
}

/** Число словами: numWords(21) → «двадцать один», numWords(2, 'f') → «две». Род: m, f или n. До миллиарда; больше — по цифрам. */
export function numWords(n, gender = 'm') {
  n = Math.trunc(Number(n));
  if (!Number.isFinite(n)) return '';
  if (n < 0) return `минус ${numWords(-n, gender)}`;
  if (n === 0) return 'ноль';
  if (n >= 1e9) return String(n).split('').map((d) => ONES.m[d]).join(' ');
  const out = [];
  const mil = Math.floor(n / 1e6); const th = Math.floor(n / 1000) % 1000; const rest = n % 1000;
  if (mil) out.push(...below1000(mil, 'm'), plural(mil, ['миллион', 'миллиона', 'миллионов']));
  if (th) out.push(...below1000(th, 'f'), plural(th, ['тысяча', 'тысячи', 'тысяч']));
  if (rest) out.push(...below1000(rest, gender));
  return out.join(' ');
}

const DAY_GEN = ['', 'первого', 'второго', 'третьего', 'четвёртого', 'пятого', 'шестого', 'седьмого', 'восьмого', 'девятого', 'десятого', 'одиннадцатого', 'двенадцатого', 'тринадцатого', 'четырнадцатого', 'пятнадцатого', 'шестнадцатого', 'семнадцатого', 'восемнадцатого', 'девятнадцатого', 'двадцатого'];
const DAY_ONES_GEN = ['', 'первого', 'второго', 'третьего', 'четвёртого', 'пятого', 'шестого', 'седьмого', 'восьмого', 'девятого'];
export const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const GEN = ['ноля', 'одного', 'двух', 'трёх', 'четырёх', 'пяти', 'шести', 'семи', 'восьми', 'девяти', 'десяти', 'одиннадцати', 'двенадцати', 'тринадцати', 'четырнадцати', 'пятнадцати', 'шестнадцати', 'семнадцати', 'восемнадцати', 'девятнадцати'];
const GEN_TENS = ['', '', 'двадцати', 'тридцати', 'сорока', 'пятидесяти', 'шестидесяти', 'семидесяти', 'восьмидесяти', 'девяноста'];
/** Число в родительном падеже («из шести», «из двадцати одного»); от ста — как есть, в именительном. */
export function numGenitive(n) {
  n = Math.trunc(Number(n));
  if (!(n >= 0 && n < 100)) return numWords(n);
  if (n < 20) return GEN[n];
  return [GEN_TENS[Math.floor(n / 10)], n % 10 ? GEN[n % 10] : ''].filter(Boolean).join(' ');
}

/** Дата словами в родительном падеже: dateWords(16, 11) → «шестнадцатого ноября». Не дата — пустая строка. */
export function dateWords(day, month) {
  if (!(day >= 1 && day <= 31 && month >= 1 && month <= 12)) return '';
  const d = day <= 20 ? DAY_GEN[day] : day === 30 ? 'тридцатого' : `${day > 30 ? 'тридцать' : 'двадцать'} ${DAY_ONES_GEN[day % 10]}`;
  return `${d} ${MONTHS_GEN[month - 1]}`;
}

/** Время словами: «04:00» → «четыре ноль ноль», «09:05» → «девять ноль пять», «19:30» → «девятнадцать тридцать». */
export function timeWords(h, m) {
  const mm = m === 0 ? 'ноль ноль' : m < 10 ? `ноль ${numWords(m)}` : numWords(m);
  return `${numWords(h)} ${mm}`;
}

// Частые слова из сводок mcfly; «+» перед гласной — подсказка ударения синтезатору. Проект дополняет словарь в video.pronounce.
export const PRONOUNCE = {
  mcfly: 'макфл+ай', telegram: 'телегр+ам', claude: 'клод', 'claude code': 'клод код', mac: 'мак', macos: 'мак ос', vpn: 'ви пи эн', git: 'гит', github: 'гитх+аб',
  api: 'а пэ +и', openspec: 'оупен спек', cli: 'си эл +ай', ok: 'окей', id: 'ай д+и', url: 'ю эр +эл', pr: 'пи +ар', ci: 'си +ай', json: 'джейсон', yaml: 'ямл',
  google: 'гугл', yandex: 'яндекс', android: 'андроид', ios: 'ай о +эс', email: 'имейл', web: 'веб', online: 'онлайн',
  main: 'мэйн', master: 'мастер', doctor: 'доктор', python: 'пайтон', node: 'ноуд', npm: 'эн пи +эм', bot: 'бот', backlog: 'бэклог', readme: 'ридми',
};
const LETTER = { a: 'эй', b: 'би', c: 'си', d: 'ди', e: 'и', f: 'эф', g: 'джи', h: 'эйч', i: 'ай', j: 'джей', k: 'кей', l: 'эл', m: 'эм', n: 'эн', o: 'оу', p: 'пи', q: 'кью', r: 'эр', s: 'эс', t: 'ти', u: 'ю', v: 'ви', w: 'дабл ю', x: 'икс', y: 'уай', z: 'зед' };
const PAIRS = [['sch', 'ш'], ['sh', 'ш'], ['ch', 'ч'], ['th', 'т'], ['ph', 'ф'], ['ck', 'к'], ['oo', 'у'], ['ee', 'и'], ['ya', 'я'], ['yu', 'ю'], ['zh', 'ж'], ['kh', 'х'], ['ts', 'ц']];
const SINGLE = { a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', j: 'дж', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс', y: 'и', z: 'з' };

/** Иностранное слово русскими буквами, грубо: лучше неточно, чем молчание. Одна буква — по названию («Q» → «кью»). */
export function translit(word) {
  let w = String(word).toLowerCase();
  if (w.length === 1) return LETTER[w] || '';
  let out = '';
  while (w) {
    const pair = PAIRS.find(([from]) => w.startsWith(from));
    if (pair) { out += pair[1]; w = w.slice(pair[0].length); continue; }
    out += SINGLE[w[0]] ?? ''; w = w.slice(1);
  }
  return out;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Текст, который диктор прочитает целиком: без разметки и значков, числа, время и даты — словами, иностранные слова — по словарю
 * (pronounce проекта важнее общего), а чего в словаре нет — русскими буквами. Пути, адреса и имена файлов выбрасываются.
 */
export function speakable(text, pronounce = {}) {
  let t = String(text ?? '').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, ' и ');
  t = t.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, ' ').replace(/`/g, '');
  t = t.replace(/\bhttps?:\/\/\S+/gi, ' ').replace(/(?<![\p{L}\p{N}])[~.]?\/?(?:[\w.-]+\/)+[\w.-]*/gu, ' ') // адреса и пути
    .replace(/(?<![\p{L}\p{N}])[\w-]+\.(?:md|js|ts|tsx|jsx|json|ya?ml|py|sh|txt|html|css|env|log|toml)\b/gi, ' '); // имена файлов
  t = t.replace(/\+/g, ' плюс ');
  // Словарь: длинные выражения раньше коротких; «+» в замене — ударение, его дальше не трогаем
  const dict = { ...PRONOUNCE, ...Object.fromEntries(Object.entries(pronounce || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)])) };
  for (const key of Object.keys(dict).sort((a, b) => b.length - a.length)) {
    t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escRe(key)}(?![\\p{L}\\p{N}])`, 'giu'), ` ${dict[key]} `);
  }
  t = t.replace(/(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/g, (_, h, m) => ` ${timeWords(Number(h), Number(m))} `);
  t = t.replace(/(?<![\d.])(\d{1,2})\.(\d{2})(?:\.(?:\d{4}|\d{2}))?(?![\d.])/g, (all, d, m) => { const w = dateWords(Number(d), Number(m)); return w ? ` ${w} ` : all; });
  t = t.replace(/(\d+)\s*%/g, (_, n) => ` ${numWords(n)} ${plural(Number(n), ['процент', 'процента', 'процентов'])} `);
  t = t.replace(/(\d)[.,](?=\d)/g, '$1 точка ');
  t = t.replace(/(?<![\p{L}\p{N}])(из|от|до|около|после|без)\s+(\d{1,2})(?!\d|[.:]\d)/giu, (_, prep, n) => `${prep} ${numGenitive(n)}`);
  t = t.replace(/\d+/g, (n) => ` ${numWords(n)} `);
  t = t.replace(/[A-Za-z]+/g, (w) => ` ${translit(w)} `);
  t = t.replace(/[_/\\|*#=<>[\]{}~^@$]/g, ' ').replace(/\s*·\s*/g, ', ').replace(/[()]/g, ', ').replace(/\s+-\s+/g, ' — ').replace(/(?<=\S)-(?=\S)/g, ' ');
  return t.replace(/\s+/g, ' ').replace(/\s+([,.!?:;])/g, '$1').replace(/[,.!?:;](?:\s*[,.!?:;])+/g, (run) => (run.match(/[.!?]/) || [run[0]])[0]).replace(/^[\s,.:;—]+/, '').trim();
}

/** Обрезать по границе предложения, а если первое же длиннее max — по границе слова с многоточием. */
export function clipSentences(text, max) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (end >= max * 0.4) return cut.slice(0, end + 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1)).replace(/[\s,;:—-]+$/, '')}…`;
}
