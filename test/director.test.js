import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { MCFLY_ROOT } from '../src/prompt.js';
import { SCENE_KINDS, SCENE_ENTER, SCENE_ACCENTS, SCENE_STYLES, SCENE_ICONS } from '../src/storyboard.js';

const read = (...p) => fs.readFileSync(path.join(MCFLY_ROOT, ...p), 'utf8');

test('памятка режиссёру называет все виды сцен, появления и значения оформления из кода', () => {
  const guide = read('prompts', 'video-guide.md');
  for (const k of [...SCENE_KINDS, ...SCENE_ENTER, ...SCENE_ACCENTS, ...SCENE_STYLES, ...SCENE_ICONS]) assert.match(guide, new RegExp('`' + k + '`'), k);
});
test('шаблоны роликов знают все значки и стили из кода', () => {
  const weekly = read('video', 'src', 'Weekly.jsx'); const daily = read('video', 'src', 'Daily.jsx');
  for (const i of SCENE_ICONS) assert.match(weekly, new RegExp(`\\b${i}:`), i);
  for (const a of SCENE_ACCENTS) { assert.match(weekly, new RegExp(`\\b${a}:`), a); assert.match(daily, new RegExp(`\\b${a}:`), a); }
  for (const s of SCENE_STYLES) assert.ok((weekly + daily).includes(`'${s}'`), s);
});
test('роль режиссёра: без формата сцен (он в памятке) и без данных проектов; зритель умеет смотреть ролик', () => {
  const role = read('agents', 'director.md');
  assert.match(role, /^name: director$/m); assert.match(role, /^tools: Read, Write, Glob$/m); assert.doesNotMatch(role, /"kind"/);
  assert.match(read('agents', 'user.md'), /смотреть ролик-сводку/);
});
