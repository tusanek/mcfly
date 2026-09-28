import path from 'node:path';
import { readJson, writeJson } from './util.js';

export function paths(projectDir) {
  const root = path.join(projectDir, 'mcfly');
  return {
    projectDir, root,
    config: path.join(root, 'config.yaml'),
    env: path.join(root, '.env'),
    progress: path.join(root, 'progress.md'),
    questions: path.join(root, 'questions.yaml'),
    answers: path.join(root, 'answers.md'),
    metrics: path.join(root, 'metrics.jsonl'),
    state: path.join(root, 'state.json'),
    lock: path.join(root, '.lock'),
    runs: path.join(root, 'runs'),
    logs: path.join(root, 'logs'),
    openspecChanges: path.join(projectDir, 'openspec', 'changes'),
  };
}
export function loadState(p) { return readJson(p.state, {}) || {}; }
export function saveState(p, state) { writeJson(p.state, state); }
