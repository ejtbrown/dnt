import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadConfig } from "../infra/config.js";
const config = loadConfig();

const rules = JSON.parse(readFileSync('config/main-ruleset.json', 'utf8'));
const endpoint = `repos/${config.repository}/rulesets`;
// A plan/permission error must remain an error. Do not silently skip protection,
// change repository visibility, or weaken existing rules.
const current: { name: string; id: number }[] = [];
for (let page = 1; ; page++) {
  const batch = JSON.parse(execFileSync('gh', ['api', `${endpoint}?per_page=100&page=${page}`], { encoding: 'utf8' }));
  current.push(...batch);
  if (batch.length < 100) break;
}
const existing = current.find((rule: { name: string; id: number }) => rule.name === rules.name);
execFileSync('gh', ['api', existing ? `${endpoint}/${existing.id}` : endpoint,
  '--method', existing ? 'PUT' : 'POST', '--input', '-'], { input: JSON.stringify(rules), stdio: ['pipe', 'ignore', 'inherit'] });
console.log('PR-only main ruleset installed.');
