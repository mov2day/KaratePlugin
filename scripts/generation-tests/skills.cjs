const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const SKILLS_DIR = path.resolve(__dirname, '..', '..', 'skills');
const MAX_SKILL_CHARS = 5000;

const fsApi = {
    exists: p => fs.existsSync(p),
    read: p => fs.readFileSync(p, 'utf8'),
    list: d => fs.readdirSync(d)
};
const memFs = files => ({
    exists: p => p in files || Object.keys(files).some(k => k.startsWith(p + '/')),
    read: p => { if (!(p in files)) throw new Error('ENOENT ' + p); return files[p]; },
    list: d => Object.keys(files).filter(k => k.startsWith(d + '/')).map(k => k.slice(d.length + 1).split('/')[0])
});

const pack = () => require('../../out/generation/ai/SkillPack');
const rules = () => require('../../out/generation/quality/rules').RULES.map(r => r.id);
const manifest = () => JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, 'manifest.json'), 'utf8'));
const skillText = e => fs.readFileSync(path.join(SKILLS_DIR, e.file), 'utf8');
const fences = text => (text.match(/^\s*```/gm) || []).length;
const ruleMentions = text => [...new Set(text.match(/V2-[A-Z]+-\d{3}/g) || [])];

/** True when every occurrence of `needle` sits on a line (or fenced block) labelled BAD or WRONG. */
function onlyInLabelledBad(text, needle) {
    const lines = text.split('\n');
    let blockStart = -1;
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*```/.test(lines[i])) { blockStart = blockStart < 0 ? i : -1; continue; }
        if (!lines[i].includes(needle)) continue;
        const from = blockStart >= 0 ? blockStart : i;
        let labelled = false;
        // labelled on its own line or by a BAD/WRONG label earlier in the same block, closest wins
        for (let j = i; j >= from; j--) {
            if (/\b(BAD|WRONG)\b/.test(lines[j])) { labelled = true; break; }
            if (/\b(GOOD|RIGHT)\b/.test(lines[j])) break;
        }
        if (!labelled) return false;
    }
    return true;
}

module.exports = [
    {
        name: 'skills: manifest lists 12 skills whose files exist with name/description frontmatter',
        run() {
            const m = manifest();
            assert.equal(m.skills.length, 12);
            const ids = m.skills.map(s => s.id).sort();
            assert.deepEqual(ids, [
                'karate-assertions-schemas', 'karate-data-driven', 'karate-project-config', 'karate-repair',
                'karate-reuse-isolation', 'karate-review-checklist', 'karate-source-graphql', 'karate-source-har-session',
                'karate-source-openapi', 'karate-source-postman', 'karate-source-requirements', 'karate-v2-core'
            ]);
            for (const e of m.skills) {
                assert.equal(e.verifiedAgainst, '2.1.4', e.id);
                assert.equal(typeof e.priority, 'number', e.id);
                assert.ok(e.budgetChars > 0 && e.budgetChars <= MAX_SKILL_CHARS, e.id);
                assert.ok(e.appliesTo && e.appliesTo.modes && e.appliesTo.tasks, e.id);
                assert.ok(fs.existsSync(path.join(SKILLS_DIR, e.file)), `${e.file} missing`);
                const text = skillText(e);
                const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
                assert.ok(fm, `${e.file}: frontmatter`);
                assert.match(fm[1], new RegExp(`^name:\\s*${e.id}\\s*$`, 'm'), `${e.file}: name`);
                assert.match(fm[1], /^description:\s*\S+/m, `${e.file}: description`);
                assert.match(text, /^## Rules\s*$/m, `${e.file}: Rules section`);
            }
        }
    },
    {
        name: 'skills: every skill is at most 5,000 characters',
        run() {
            for (const e of manifest().skills) {
                const n = skillText(e).length;
                assert.ok(n <= MAX_SKILL_CHARS, `${e.file} is ${n} chars`);
            }
        }
    },
    {
        name: 'skills: rule ids mentioned exist in RULES and every RULES id is mentioned',
        run() {
            const known = new Set(rules());
            const mentioned = new Set();
            for (const e of manifest().skills) {
                const ids = ruleMentions(skillText(e));
                for (const id of ids) {
                    assert.ok(known.has(id), `${e.file} mentions unknown rule ${id}`);
                    mentioned.add(id);
                }
                assert.deepEqual([...e.rules].sort(), ids.sort(), `${e.id}: manifest rules must equal the ids in the file`);
            }
            for (const id of known) assert.ok(mentioned.has(id), `${id} not mentioned in any skill`);
            const checklist = ruleMentions(skillText(manifest().skills.find(s => s.id === 'karate-review-checklist')));
            assert.deepEqual(checklist.sort(), [...known].sort(), 'review checklist lists every gate rule');
        }
    },
    {
        name: 'skills: banned v1 constructs only appear inside labelled BAD/WRONG examples',
        run() {
            for (const e of manifest().skills) {
                const text = skillText(e);
                for (const needle of ['@parallel=false', 'karate.toJava', "karate.properties['", 'karate.stop(']) {
                    assert.ok(onlyInLabelledBad(text, needle), `${e.file}: ${needle} outside a BAD/WRONG example`);
                }
            }
        }
    },
    {
        name: 'skills: no skill file is a stale v1 habit (no markdown prose fences wrapping output, no Karate 1.x)',
        run() {
            for (const e of manifest().skills) {
                const text = skillText(e);
                assert.doesNotMatch(text, /karate-junit5|com\.intuit\.karate|karate-1\./, e.file);
                assert.equal(fences(text) % 2, 0, `${e.file}: unbalanced fences`);
            }
        }
    },
    {
        name: 'skills: select(postman) includes core + postman, excludes graphql',
        run() {
            const p = pack().loadSkillPack(SKILLS_DIR, fsApi);
            const r = p.select({ mode: 'postman', task: 'generate-postman' });
            assert.ok(r.included.includes('karate-v2-core'));
            assert.ok(r.included.includes('karate-source-postman'));
            assert.ok(!r.included.includes('karate-source-graphql'));
            assert.ok(!r.included.includes('karate-source-openapi'));
            assert.ok(r.text.length <= 16000, `len ${r.text.length}`);
        }
    },
    {
        name: 'skills: select maps modes to their source skills',
        run() {
            const p = pack().loadSkillPack(SKILLS_DIR, fsApi);
            const has = (mode, task, id) => p.select({ mode, task }).included.includes(id);
            assert.ok(has('openapi', 'generate-openapi', 'karate-source-openapi'));
            assert.ok(has('graphql', 'generate-graphql', 'karate-source-graphql'));
            assert.ok(has('har', 'generate-har', 'karate-source-har-session'));
            assert.ok(has('session', 'generate-har', 'karate-source-har-session'));
            assert.ok(has('jira', 'generate-jira', 'karate-source-requirements'));
            assert.ok(has('confluence', 'generate-requirements', 'karate-source-requirements'));
            assert.ok(has('openapi', 'repair-scenario', 'karate-repair'));
            assert.ok(!has('openapi', 'generate-openapi', 'karate-repair'));
            assert.ok(has('openapi', 'enhance-feature', 'karate-review-checklist'));
        }
    },
    {
        name: 'skills: select is deterministic, within budget, ordered by priority',
        run() {
            const p = pack().loadSkillPack(SKILLS_DIR, fsApi);
            const q = { mode: 'combined', task: 'generate-requirements' };
            const a = p.select(q);
            const b = p.select(q);
            assert.deepEqual(a, b);
            assert.ok(a.text.length <= 16000);
            assert.equal(a.included[0], 'karate-v2-core');
            const prio = Object.fromEntries(manifest().skills.map(s => [s.id, s.priority]));
            const order = a.included.map(id => prio[id]);
            assert.deepEqual(order, [...order].sort((x, y) => x - y));
        }
    },
    {
        name: 'skills: trimming never splits a fenced block and honours any budget',
        run() {
            const p = pack().loadSkillPack(SKILLS_DIR, fsApi);
            let sawTrim = false;
            for (const mode of ['openapi', 'postman', 'combined']) {
                for (const task of ['generate-openapi', 'generate-postman', 'enhance-feature', 'repair-scenario']) {
                    for (let budget = 400; budget <= 20000; budget += 350) {
                        const r = p.select({ mode, task }, { budgetChars: budget });
                        assert.ok(r.text.length <= budget, `${mode}/${task}@${budget}: ${r.text.length}`);
                        assert.equal(fences(r.text) % 2, 0, `${mode}/${task}@${budget}: fence split`);
                        if (r.trimmed.length) sawTrim = true;
                    }
                }
            }
            assert.ok(sawTrim, 'small budgets must trim');
        }
    },
    {
        name: 'skills: sections are dropped whole and a ## inside a fence is not a boundary',
        run() {
            const files = {
                '/s/manifest.json': JSON.stringify({ skills: [
                    { id: 'a', file: 'a.md', appliesTo: { modes: '*', tasks: '*' }, priority: 1, budgetChars: 5000, verifiedAgainst: '2.1.4', rules: [] },
                    { id: 'b', file: 'b.md', appliesTo: { modes: ['openapi'], tasks: '*' }, priority: 2, budgetChars: 5000, verifiedAgainst: '2.1.4', rules: [] }
                ] }),
                '/s/a.md': '---\nname: a\ndescription: A\n---\nintro\n\n## One\n' + 'x'.repeat(200) + '\n```\n## not a heading\n```\n\n## Rules\nrules-a\n',
                '/s/b.md': '---\nname: b\ndescription: B\n---\n## Extra\n' + 'y'.repeat(300) + '\n\n## Rules\nrules-b\n'
            };
            const p = pack().loadSkillPack('/s', memFs(files));
            const full = p.select({ mode: 'openapi', task: 'general' });
            assert.deepEqual(full.included, ['a', 'b']);
            assert.deepEqual(full.trimmed, []);
            const small = p.select({ mode: 'openapi', task: 'general' }, { budgetChars: full.text.length - 100 });
            assert.ok(small.trimmed.includes('b'), 'lowest priority trimmed first');
            assert.ok(!small.text.includes('yyyy'), 'whole Extra section dropped');
            assert.ok(small.text.includes('rules-b'), 'Rules kept while other sections can go');
            assert.ok(small.text.includes('## not a heading'), 'fenced content kept intact');
            assert.equal(fences(small.text) % 2, 0);
        }
    },
    {
        name: 'skills: ruleIds returns the sorted union of manifest rules',
        run() {
            const p = pack().loadSkillPack(SKILLS_DIR, fsApi);
            assert.deepEqual(p.ruleIds(), [...rules()].sort());
        }
    },
    {
        name: 'skills: missing manifest throws a clear error',
        run() {
            assert.throws(() => pack().loadSkillPack('/nope', memFs({})), /manifest/i);
        }
    },
    {
        name: 'skills: each skill file stays within its own manifest budgetChars',
        run() {
            for (const e of manifest().skills) {
                const n = skillText(e).length;
                assert.ok(n <= e.budgetChars, `${e.file} is ${n} > budgetChars ${e.budgetChars}`);
                assert.ok(e.budgetChars - n < 1000, `${e.file}: budgetChars ${e.budgetChars} is not a real guard for ${n}`);
            }
        }
    },
    {
        name: 'skills: generate sets include every skill untrimmed at the default budget',
        run() {
            const p = pack().loadSkillPack(SKILLS_DIR, fsApi);
            for (const [mode, task, src] of [['openapi', 'generate-openapi', 'karate-source-openapi'], ['postman', 'generate-postman', 'karate-source-postman'], ['graphql', 'generate-graphql', 'karate-source-graphql']]) {
                const r = p.select({ mode, task });
                assert.deepEqual(r.trimmed, [], `${mode}: ${r.trimmed}`);
                for (const id of ['karate-v2-core', src, 'karate-assertions-schemas', 'karate-project-config', 'karate-reuse-isolation', 'karate-data-driven']) {
                    assert.ok(r.included.includes(id), `${mode} missing ${id}`);
                }
                assert.ok(r.text.length <= pack().DEFAULT_TOTAL_BUDGET);
            }
        }
    },
    {
        name: 'skills: enhance sets trim lowest priority first and keep core and checklist rules',
        run() {
            const p = pack().loadSkillPack(SKILLS_DIR, fsApi);
            const r = p.select({ mode: 'openapi', task: 'enhance-feature' }, { budgetChars: 11000 });
            assert.ok(r.included.includes('karate-v2-core') && r.included.includes('karate-review-checklist'));
            assert.ok(!r.trimmed.includes('karate-v2-core') && !r.trimmed.includes('karate-review-checklist'));
            assert.ok(/V2-TAG-001/.test(r.text), 'checklist rules intact');
        }
    },
    {
        name: 'skills: a tiny budget falls back to the highest-priority Rules sections, never empty',
        run() {
            const p = pack().loadSkillPack(SKILLS_DIR, fsApi);
            const r = p.select({ mode: 'openapi', task: 'generate-openapi' }, { budgetChars: 1500 });
            assert.ok(r.text.length > 0 && r.text.length <= 1500, `len ${r.text.length}`);
            assert.ok(r.included.includes('karate-v2-core'));
            assert.match(r.text, /V2-GHERKIN-001/);
            assert.equal(fences(r.text) % 2, 0);
        }
    },
    {
        name: 'skills: appendUserSkills adds at most the allowance and never alters pack text',
        run() {
            const { appendUserSkills, USER_SKILL_ALLOWANCE } = pack();
            assert.equal(USER_SKILL_ALLOWANCE, 2000);
            const packText = 'P'.repeat(16000);
            const user = [{ name: 'mine', content: 'U'.repeat(5000) }, { name: 'second', content: 'V'.repeat(100) }];
            const out = appendUserSkills(packText, user, 2000);
            assert.ok(out.startsWith(packText));
            assert.ok(out.length - packText.length <= 2000, `added ${out.length - packText.length}`);
            assert.ok(out.includes('mine'));
            const small = appendUserSkills('abc', user);
            assert.ok(small.length - 3 <= 2000);
            assert.equal(appendUserSkills('abc', [], 100), 'abc');
            assert.equal(appendUserSkills('abc', user, 0), 'abc');
        }
    },
    {
        name: 'skills: appendUserSkills keeps fences balanced when truncating',
        run() {
            const { appendUserSkills } = pack();
            const content = 'intro\n\n```gherkin\n' + '* def a = 1\n'.repeat(200) + '```\n\nafter\n';
            for (let allowance = 20; allowance < 2600; allowance += 97) {
                const out = appendUserSkills('PACK', [{ name: 'u', content }], allowance);
                assert.ok(out.length - 4 <= allowance, `${allowance}: ${out.length}`);
                assert.equal(fences(out) % 2, 0, `allowance ${allowance}`);
                assert.ok(out.startsWith('PACK'));
            }
        }
    }
];
