const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { classifyModel, orderModelCandidates, requiredCapability } = require('../out/services/ai/ModelSelection');
const { KaratePromptComposer } = require('../out/services/ai/KaratePromptComposer');

const candidates = [
  { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', family: 'claude-haiku', maxInputTokens: 64_000 },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', family: 'claude-sonnet', maxInputTokens: 200_000 },
  { id: 'claude-opus-5', name: 'Claude Opus 5', family: 'claude-opus', maxInputTokens: 200_000 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', family: 'gpt-5.6-luna', maxInputTokens: 200_000 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', family: 'gpt-5.6-terra', maxInputTokens: 272_000 },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', family: 'gpt-5.6-sol', maxInputTokens: 272_000 },
  { id: 'future-unknown-premium', name: 'Future Unknown Premium', family: 'future-x', maxInputTokens: 512_000 }
];
const counts = new Map(candidates.map(model => [model.id, 4_000]));

assert.deepStrictEqual(classifyModel(candidates[0]), { capability: 'fast', cost: 'low', family: 'Haiku' });
assert.deepStrictEqual(classifyModel(candidates[1]), { capability: 'balanced', cost: 'medium', family: 'Sonnet' });
assert.deepStrictEqual(classifyModel(candidates[2]), { capability: 'deep', cost: 'high', family: 'Opus' });
assert.deepStrictEqual(classifyModel(candidates[3]), { capability: 'fast', cost: 'low', family: 'Luna' });
assert.deepStrictEqual(classifyModel(candidates[4]), { capability: 'balanced', cost: 'medium', family: 'Terra' });
assert.deepStrictEqual(classifyModel(candidates[5]), { capability: 'deep', cost: 'high', family: 'Sol' });
assert.strictEqual(classifyModel(candidates[6]), undefined, 'unknown families must be manual-only');

assert.strictEqual(requiredCapability('analyze-coverage', 'efficient'), 'fast');
assert.strictEqual(requiredCapability('generate-openapi', 'efficient'), 'balanced');
assert.strictEqual(requiredCapability('analyze-coverage', 'balanced'), 'balanced');
assert.strictEqual(requiredCapability('analyze-coverage', 'highest-quality'), 'deep');

const efficientAnalysis = orderModelCandidates(candidates, counts, 'efficient', undefined, 'analyze-coverage');
assert.ok(efficientAnalysis.length >= 2);
assert.ok(efficientAnalysis.slice(0, 2).every(model => ['claude-haiku-4.5', 'gpt-5.6-luna'].includes(model.id)));
assert.ok(!efficientAnalysis.some(model => ['claude-opus-5', 'gpt-5.6-sol', 'future-unknown-premium'].includes(model.id)));

const efficientGeneration = orderModelCandidates(candidates, counts, 'efficient', undefined, 'generate-openapi');
assert.deepStrictEqual(
  efficientGeneration.slice(0, 2).map(model => model.id),
  ['gpt-5.6-terra', 'claude-sonnet-5'],
  'production generation must prefer balanced families without deep-model escalation'
);
assert.ok(!efficientGeneration.some(model => ['claude-opus-5', 'gpt-5.6-sol'].includes(model.id)));

const highest = orderModelCandidates(candidates, counts, 'highest-quality', undefined, 'generate-openapi');
assert.ok(['claude-opus-5', 'gpt-5.6-sol'].includes(highest[0].id));
assert.deepStrictEqual(orderModelCandidates(candidates, counts, 'efficient', 'future-unknown-premium', 'generate-openapi').map(model => model.id), ['future-unknown-premium']);
assert.deepStrictEqual(orderModelCandidates(candidates, counts, 'efficient', 'missing-model'), []);

const oversized = new Map(candidates.map(model => [model.id, 120_000]));
assert.deepStrictEqual(
  orderModelCandidates([candidates[0]], oversized, 'efficient', undefined, 'analyze-coverage').map(model => model.id),
  [],
  'automatic routing must refuse a model that does not fit with safety reserve'
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
assert.ok(settings['karateDsl.ai.provider'].enum.includes('vscode-lm'));
assert.strictEqual(settings['karateDsl.ai.modelMode'].default, 'efficient');
assert.ok(!settings['karateDsl.copilot.model'].enum, 'legacy Copilot setting must not hardcode model names');

console.log('AI routing contract tests passed.');
