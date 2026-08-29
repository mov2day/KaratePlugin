const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { orderModelCandidates } = require('../out/services/ai/ModelSelection');
const { KaratePromptComposer } = require('../out/services/ai/KaratePromptComposer');

const candidates = [
  { id: 'small-live-model', maxInputTokens: 8_000 },
  { id: 'medium-live-model', maxInputTokens: 32_000 },
  { id: 'large-live-model', maxInputTokens: 128_000 }
];
const counts = new Map(candidates.map(model => [model.id, 4_000]));

assert.deepStrictEqual(
  orderModelCandidates(candidates, counts, 'efficient').map(model => model.id),
  ['small-live-model', 'medium-live-model', 'large-live-model'],
  'efficient mode must start with the smallest context-capable model'
);
assert.strictEqual(orderModelCandidates(candidates, counts, 'balanced')[0].id, 'medium-live-model');
assert.strictEqual(orderModelCandidates(candidates, counts, 'highest-quality')[0].id, 'large-live-model');
assert.deepStrictEqual(orderModelCandidates(candidates, counts, 'efficient', 'medium-live-model').map(model => model.id), ['medium-live-model']);
assert.deepStrictEqual(orderModelCandidates(candidates, counts, 'efficient', 'missing-model'), []);

const oversized = new Map(candidates.map(model => [model.id, 120_000]));
assert.deepStrictEqual(
  orderModelCandidates(candidates, oversized, 'efficient').map(model => model.id),
  [],
  'automatic routing must refuse a request that does not fit with safety reserve'
);

const repair = KaratePromptComposer.compose('failure evidence', 'repair-scenario');
assert.match(repair.systemPrompt, /Repair only the exact failing scenario/);
assert.match(repair.systemPrompt, /Never emit credentials/);

const sourceRoot = path.join(process.cwd(), 'src');
const sourceFiles = [];
function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) sourceFiles.push(full);
  }
}
collect(sourceRoot);
const directModelCalls = sourceFiles.filter(file => {
  if (file.endsWith(path.join('services', 'ai', 'CopilotProvider.ts'))) return false;
  const source = fs.readFileSync(file, 'utf8');
  return source.includes('selectChatModels(') || /\bmodel\.sendRequest\(/.test(source);
});
assert.deepStrictEqual(directModelCalls, [], `AI model API bypasses found: ${directModelCalls.join(', ')}`);

const manifest = require('../package.json');
const settings = manifest.contributes.configuration.properties;
assert.strictEqual(settings['karateDsl.ai.provider'].default, 'copilot');
assert.strictEqual(settings['karateDsl.ai.modelMode'].default, 'efficient');
assert.ok(!settings['karateDsl.copilot.model'].enum, 'legacy Copilot setting must not hardcode model names');

console.log('AI routing contract tests passed.');
