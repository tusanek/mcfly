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
