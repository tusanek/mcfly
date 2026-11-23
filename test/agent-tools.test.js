import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
// F41: роль с закрытым списком инструментов не получает Playwright, даже если её работа велит смотреть экраны
const dir = path.join(import.meta.dirname, '..', 'agents');
test('0.23.1: роли, которым нужен Playwright, получают его при закрытом списке инструментов', () => {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const tools = text.match(/^tools: (.+)$/m)?.[1];
    if (!tools || !/Playwright/.test(text)) continue;
    assert.match(tools, /mcp__plugin_playwright_playwright__\*/, f);
    assert.match(tools, /mcp__playwright__\*/, f);
  }
});
