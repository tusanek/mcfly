import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs, parseResult, runProcess, cleanEnv, summarizeEvent, maskSecrets } from '../src/claude.js';
import { cfg } from './helpers.js';

test('buildClaudeArgs', () => {
  const args = buildClaudeArgs({ prompt: 'p', cfg: { ...cfg, run: { ...cfg.run, model: 'opus', max_budget_usd: 5, extra_args: ['--verbose'] } }, pluginDir: '/x' });
  assert.deepEqual(args, ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--plugin-dir', '/x', '--agent', 'mcfly:lead', '--model', 'opus', '--max-budget-usd', '5', '--verbose', 'p']);
});
test('parseResult: ok / error / quota / timeout', () => {
  const ok = parseResult({ exitCode: 0, stdout: 'мусор\n{"result":"готово","total_cost_usd":1.5,"num_turns":3,"session_id":"s","is_error":false}', stderr: '', timedOut: false });
  assert.equal(ok.status, 'ok'); assert.equal(ok.costUsd, 1.5); assert.equal(ok.turns, 3); assert.equal(ok.sessionId, 's');
  assert.equal(parseResult({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false }).status, 'error');
  assert.equal(parseResult({ exitCode: 1, stdout: '{"result":"You have hit your usage limit","is_error":true}', stderr: '', timedOut: false }).status, 'quota');
  assert.equal(parseResult({ exitCode: 1, stdout: '{"result":"You\'ve hit your session limit · resets 10pm (Europe/Moscow)","is_error":true}', stderr: '', timedOut: false }).status, 'quota');
  assert.equal(parseResult({ exitCode: null, stdout: '', stderr: '', timedOut: true }).status, 'timeout');
});
test('parseResult: нет доступа к API (403 Request not allowed без VPN, сетевые ошибки) — статус network', () => {
  const region = parseResult({ exitCode: 1, stdout: '{"type":"result","is_error":true,"result":"Failed to authenticate. API Error: 403 Request not allowed","api_error_status":403}', stderr: '', timedOut: false });
  assert.equal(region.status, 'network');
  assert.equal(parseResult({ exitCode: 1, stdout: '', stderr: 'Error: getaddrinfo ENOTFOUND api.anthropic.com', timedOut: false }).status, 'network');
  assert.equal(parseResult({ exitCode: 1, stdout: '', stderr: 'connect ECONNREFUSED 1.2.3.4:443', timedOut: false }).status, 'network');
  assert.equal(parseResult({ exitCode: 1, stdout: '{"is_error":true,"result":"Failed to authenticate. API Error: 401 Invalid bearer token"}', stderr: '', timedOut: false }).status, 'error', 'протухший токен — не сеть');
});
test('summarizeEvent маскирует токены в журнале событий', () => {
  const command = 'curl -H "k: sk-ant-oat01-AbC_d-123" https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/getMe';
  const s = summarizeEvent(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } }));
  assert.doesNotMatch(s, /AbC_d-123|AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/);
  assert.match(s, /sk-ant-\*\*\*/);
});
test('maskSecrets маскирует OAuth-токены Яндекса и ключи вида sk-… (LiteLLM)', () => {
  const s = maskSecrets('TRACKER y0__xDEADBEEFdeadbeef0123456789abcdefABCDEF LLM sk-1234567890abcdefghijKLMN ok');
  assert.doesNotMatch(s, /DEADBEEF|1234567890abcdefghij/);
  assert.match(s, / ok$/);
});
test('runProcess не рвёт кириллицу на границе кусков вывода', async () => {
  // 'x' сдвигает двухбайтовые символы на нечётные смещения: граница любого куска чётной длины придётся на середину символа
  const r = await runProcess({ bin: process.execPath, args: ['-e', "process.stdout.write('x' + 'я'.repeat(300000))"], cwd: process.cwd(), env: process.env, timeoutMs: 20_000 });
  assert.equal(r.stdout.includes('�'), false);
  assert.equal(r.stdout.length, 300_001);
});
test('runProcess с таймаутом', async () => {
  const r = await runProcess({ bin: 'sleep', args: ['5'], cwd: process.cwd(), env: process.env, timeoutMs: 200 });
  assert.equal(r.timedOut, true);
  const ok = await runProcess({ bin: 'echo', args: ['hi'], cwd: process.cwd(), env: process.env, timeoutMs: 5000 });
  assert.equal(ok.exitCode, 0); assert.equal(ok.stdout.trim(), 'hi');
});
test('cleanEnv убирает служебные переменные вложенной сессии', () => {
  const out = cleanEnv({ PATH: '/x', HOME: '/h', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_PLUGIN_DIRS: '/p', CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'https://proxy', CLAUDE_CONFIG_DIR: '/c' });
  assert.deepEqual(out, { PATH: '/x', HOME: '/h', CLAUDE_CODE_PLUGIN_DIRS: '/p', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CONFIG_DIR: '/c' });
  assert.equal(cleanEnv({ ANTHROPIC_BASE_URL: 'https://litellm' }).ANTHROPIC_BASE_URL, 'https://litellm');
});
test('cleanEnv при собственном токене убирает ANTHROPIC_* даже вне вложенной сессии', () => {
  const out = cleanEnv({ CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'https://proxy', ANTHROPIC_API_KEY: 'k', PATH: '/x' });
  assert.deepEqual(out, { CLAUDE_CODE_OAUTH_TOKEN: 't', PATH: '/x' });
});
test('parseResult читает последний объект потока stream-json', () => {
  const stdout = '{"type":"system","subtype":"init"}\n{"type":"assistant","message":{"content":[{"type":"text","text":"иду"}]}}\n{"type":"result","result":"готово","total_cost_usd":0.5,"num_turns":4,"session_id":"s1","is_error":false}\n';
  const r = parseResult({ exitCode: 0, stdout, stderr: '', timedOut: false });
  assert.equal(r.status, 'ok'); assert.equal(r.turns, 4); assert.equal(r.sessionId, 's1');
});
test('summarizeEvent даёт краткие строки для инструментов, текста и результата', () => {
  assert.equal(summarizeEvent('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"mvn -q test"}}]}}'), '→ Bash: mvn -q test');
  assert.equal(summarizeEvent('{"type":"assistant","message":{"content":[{"type":"text","text":"Начинаю  задачу\\n1.1"}]}}'), '💬 Начинаю задачу 1.1');
  assert.equal(summarizeEvent('{"type":"result","is_error":false,"num_turns":3,"total_cost_usd":1.2}'), '■ результат: ок, ходов 3, ~$1.20');
  assert.equal(summarizeEvent('{"type":"system"}'), null); assert.equal(summarizeEvent('не json'), null);
});

test('summarizeEvent округляет стоимость до центов', () => {
  assert.equal(summarizeEvent(JSON.stringify({ type: 'result', is_error: true, num_turns: 33, total_cost_usd: 8.002524000000001 })), '■ результат: ошибка, ходов 33, ~$8.00');
});

import { permissionDenial } from '../src/claude.js';
const toolResult = (text, isError = true) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', is_error: isError, content: [{ type: 'text', text }] }] } });
test('0.5.2: отказ разрешения распознаётся в результате инструмента и попадает в журнал событий', () => {
  const line = toolResult('Permission to use Bash with command cat <<EOF > x && git add x has been denied.');
  assert.match(permissionDenial(line), /^Permission to use Bash/);
  assert.match(summarizeEvent(line), /^⛔ отказ разрешения: Permission to use Bash/);
  assert.match(permissionDenial(toolResult('Permission for this action was denied by the Claude Code auto mode classifier.')), /classifier/);
  assert.equal(permissionDenial(toolResult('Error: file not found')), null, 'обычная ошибка инструмента — не отказ');
  assert.equal(permissionDenial(toolResult('Permission ... denied', false)), null, 'без is_error — не отказ');
});
