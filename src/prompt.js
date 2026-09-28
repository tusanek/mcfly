import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readText, fmtLocal } from './util.js';

export const MCFLY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function renderTemplate(tpl, vars) { return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] === undefined ? '' : String(vars[k]))); }
export function buildLeadPrompt({ cfg, p, runId, mode, deadline, context }) {
  const tpl = readText(path.join(MCFLY_ROOT, 'prompts', 'run.md'));
  return renderTemplate(tpl, {
    RUN_ID: runId, MODE: mode, PROJECT: cfg.project, PROJECT_DIR: p.projectDir, MAX_MINUTES: cfg.run.max_minutes, DEADLINE: fmtLocal(deadline),
    MAX_CHANGES: cfg.limits.max_changes_per_run, MAX_TASKS: cfg.limits.max_tasks_per_change, CONTEXT: context, RUN_DIR: `mcfly/runs/${runId}`,
  });
}
