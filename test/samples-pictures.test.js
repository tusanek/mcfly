// 0.19.0 «Образцы картинками»: строки «Картинка:» в образцах плана, отправка альбомом, шаблон чата.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { listChanges, proposalSamples, planHash, sampleImage } from '../src/approvals.js';
import { paths } from '../src/state.js';
import { bareProject, addChange } from './helpers.js';

const BASE = `# Proposal

## Простыми словами
Экран повторов.

## Как это будет выглядеть
### Экран «Повторы»
\`\`\`
Повторы
Картинка: это текст экрана, не путь
[Убрать]
\`\`\`
`;
const PICS = 'Картинка: design/samples/x/01-light.png\nКартинка:   design/samples/x/01-dark.png\n';
const change = (dir, name, proposal) => { addChange(dir, name, { proposal }); return listChanges(paths(dir).openspecChanges).find((c) => c.name === name); };

test('образцы: строки «Картинка:» под подзаголовком — images; внутри блока — текст; отпечаток плана их не учитывает', () => {
  const dir = bareProject();
  const plain = change(dir, 'plain', BASE); const pics = change(dir, 'pics', BASE + PICS);
  const [s] = proposalSamples(pics);
  assert.deepEqual(s.images, ['design/samples/x/01-light.png', 'design/samples/x/01-dark.png']);
  assert.match(s.text, /Картинка: это текст экрана, не путь/);
  assert.doesNotMatch(s.text, /01-light/);
  assert.deepEqual(s.buttons, [['Убрать']]);
  assert.deepEqual(proposalSamples(plain)[0].images, []);
  assert.equal(planHash(pics), planHash(plain), 'картинки, добавленные после одобрения, не меняют отпечаток плана');
  // картинка у подзаголовка без блока
  const bare = change(dir, 'bare', '## Как это будет выглядеть\n### Только картинка\nКартинка: a.png\n');
  assert.deepEqual(proposalSamples(bare).map((x) => [x.title, x.images]), [['Только картинка', ['a.png']]]);
});

test('sampleImage: только существующие PNG/JPG внутри проекта', () => {
  const dir = bareProject();
  fs.mkdirSync(path.join(dir, 'design', 'samples', 'x'), { recursive: true });
  for (const f of ['01-light.png', 'b.jpg', 'c.gif']) fs.writeFileSync(path.join(dir, 'design', 'samples', 'x', f), 'x');
  assert.equal(sampleImage(dir, 'design/samples/x/01-light.png'), path.join(dir, 'design', 'samples', 'x', '01-light.png'));
  assert.ok(sampleImage(dir, 'design/samples/x/b.jpg'));
  assert.equal(sampleImage(dir, 'design/samples/x/c.gif'), null);
  assert.equal(sampleImage(dir, 'design/samples/x/nope.png'), null);
  assert.equal(sampleImage(dir, '../x.png'), null);
  assert.equal(sampleImage(dir, '/etc/hosts.png'), null);
  assert.equal(sampleImage(dir, 'design/../../x.png'), null);
});

// --- задача 2: отправка картинок альбомом ---
import { sendSamples } from '../src/overview.js';
import { createTelegram } from '../src/telegram.js';
import { cfg } from './helpers.js';

const fakeTg = ({ failPhotos = false } = {}) => {
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text, o = {}) { sent.push({ kind: 'text', text, ...o }); return [{ message_id: sent.length }]; },
    async sendPhotos(chatId, files, o = {}) { if (failPhotos) throw new Error('Telegram sendMediaGroup: Bad Request: PHOTO_INVALID_DIMENSIONS'); sent.push({ kind: 'photos', files, ...o }); return []; },
  };
};
function pictured(names, extra = '') {
  const dir = bareProject(); fs.mkdirSync(path.join(dir, 'design', 'samples', 'x'), { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(dir, 'design', 'samples', 'x', n), 'png');
  addChange(dir, 'pics', { proposal: `## Простыми словами\nЭкран повторов.\n\n## Как это будет выглядеть\n### Экран\n\`\`\`\nПовторы\n[Убрать]\n\`\`\`\n${names.map((n) => `Картинка: design/samples/x/${n}`).join('\n')}\n${extra}### Сообщение\n\`\`\`\nЗаписал.\n\`\`\`\n` });
  return { dir, p: paths(dir) };
}

test('«Как будет выглядеть»: образец с картинками — альбом с подписью, без картинок — текстом, как раньше', async () => {
  const { dir, p } = pictured(['01-light.png', '01-dark.png']);
  const tg = fakeTg();
  assert.equal(await sendSamples(tg, '42', p, cfg, 'pics'), 2);
  const photos = tg.sent.filter((m) => m.kind === 'photos');
  assert.equal(photos.length, 1);
  assert.deepEqual(photos[0].files, [path.join(dir, 'design/samples/x/01-light.png'), path.join(dir, 'design/samples/x/01-dark.png')]);
  assert.equal(photos[0].caption, '1. Экран');
  assert.ok(!tg.sent.some((m) => m.kind === 'text' && /Повторы/.test(m.text)), 'образец с картинками текстом не дублируется');
  assert.ok(tg.sent.some((m) => m.kind === 'text' && /2\. Сообщение[\s\S]*Записал\./.test(m.text)), 'образец без картинок — текстом');
});

test('«Как будет выглядеть»: картинка не найдена или Telegram её не принял — образец текстом; больше 10 — первые 10', async () => {
  const miss = pictured([], 'Картинка: design/samples/x/nope.png\n');
  const t1 = fakeTg(); await sendSamples(t1, '42', miss.p, cfg, 'pics');
  assert.ok(!t1.sent.some((m) => m.kind === 'photos'));
  assert.ok(t1.sent.some((m) => m.kind === 'text' && /Повторы/.test(m.text) && /картинка design\/samples\/x\/nope\.png не найдена/.test(m.text)));

  const ok = pictured(['01-light.png']);
  const t2 = fakeTg({ failPhotos: true });
  await assert.doesNotReject(sendSamples(t2, '42', ok.p, cfg, 'pics'));
  assert.ok(t2.sent.some((m) => m.kind === 'text' && /1\. Экран[\s\S]*Повторы/.test(m.text)), 'отказ Telegram — тот же образец текстом');

  const many = pictured(Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(2, '0')}.png`));
  const t3 = fakeTg(); await sendSamples(t3, '42', many.p, cfg, 'pics');
  assert.equal(t3.sent.find((m) => m.kind === 'photos').files.length, 10);
});

test('telegram.sendPhotos: альбом формой с attach://; одна картинка — sendPhoto; отказ — понятная ошибка', async () => {
  const dir = bareProject(); const a = path.join(dir, 'a.png'); const b = path.join(dir, 'b.jpg');
  fs.writeFileSync(a, 'aa'); fs.writeFileSync(b, 'bb');
  const reqs = [];
  const tg = createTelegram({ token: 'T', fetchImpl: async (url, init) => { reqs.push({ url, init }); return { status: 200, json: async () => ({ ok: true, result: [] }) }; } });
  await tg.sendPhotos('7', [a, b], { caption: '1. Экран' });
  assert.match(reqs[0].url, /botT\/sendMediaGroup$/);
  const form = reqs[0].init.body;
  assert.equal(form.get('chat_id'), '7');
  assert.deepEqual(JSON.parse(form.get('media')), [{ type: 'photo', media: 'attach://p0', caption: '1. Экран' }, { type: 'photo', media: 'attach://p1' }]);
  assert.equal(await form.get('p1').text(), 'bb');
  await tg.sendPhotos('7', [a], { caption: 'одна' });
  assert.match(reqs[1].url, /botT\/sendPhoto$/);
  assert.equal(reqs[1].init.body.get('caption'), 'одна'); assert.equal(await reqs[1].init.body.get('photo').text(), 'aa');
  const bad = createTelegram({ token: 'T', fetchImpl: async () => ({ status: 400, json: async () => ({ ok: false, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' }) }) });
  await assert.rejects(bad.sendPhotos('7', [a, b]), /sendMediaGroup: Bad Request: PHOTO_INVALID_DIMENSIONS/);
});

test('безопасность: отпечаток плана не теряет строки «Картинка:» вне раздела образцов, в блоке и с не-картинкой', () => {
  const dir = bareProject();
  const base = change(dir, 'h0', BASE);
  for (const [n, extra] of [
    ['h1', BASE.replace('## Простыми словами\n', '## Простыми словами\nКартинка: удалить все данные владельца\n')],
    ['h2', BASE.replace('Повторы\n', 'Повторы\nКартинка: x.png\n')],
    ['h3', `${BASE}Картинка: ещё одна кнопка «Удалить всё».txt\n`],
    ['h4', `${BASE}Картинка: ../../etc/x.png\n`],
  ]) assert.notEqual(planHash(change(dir, n, extra)), planHash(base), n);
  assert.equal(planHash(change(dir, 'h5', `${BASE}Картинка: design/samples/x/02.jpg\n`)), planHash(base));
});

test('безопасность: ссылка (symlink) внутри проекта на файл вне проекта — не картинка образца', () => {
  const dir = bareProject(); const outside = path.join(bareProject(), 'secret.png'); fs.writeFileSync(outside, 'secret');
  fs.mkdirSync(path.join(dir, 'design'), { recursive: true }); fs.symlinkSync(outside, path.join(dir, 'design', 'leak.png'));
  assert.equal(sampleImage(dir, 'design/leak.png'), null);
});
