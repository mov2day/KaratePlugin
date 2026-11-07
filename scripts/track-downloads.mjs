#!/usr/bin/env node
// Appends download/install counts for extensions to a CSV. Node 18+, no dependencies.
// Usage: node scripts/track-downloads.mjs --out metrics.csv <namespace.name> [<namespace.name> ...]
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
let out = 'metrics.csv';
const ids = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') { out = args[++i]; } else { ids.push(args[i]); }
}
if (!ids.length || ids.some(id => !/^[\w-]+\.[\w-]+$/.test(id))) {
    console.error('Usage: track-downloads.mjs --out <file.csv> <namespace.name> [...]');
    process.exit(2);
}

async function openVsx(id) {
    const [ns, name] = id.split('.');
    const res = await fetch(`https://open-vsx.org/api/${ns}/${name}`);
    if (!res.ok) { throw new Error(`Open VSX ${res.status}`); }
    const d = await res.json();
    return { downloads: d.downloadCount ?? '', reviews: d.reviewCount ?? '', version: d.version ?? '' };
}

async function marketplace(id) {
    const res = await fetch('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=3.0-preview.1' },
        body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: id }] }], flags: 256 })
    });
    if (!res.ok) { throw new Error(`Marketplace ${res.status}`); }
    const d = await res.json();
    const stat = d.results?.[0]?.extensions?.[0]?.statistics?.find(s => s.statisticName === 'install');
    return stat ? stat.value : '';
}

const HEADER = 'date,id,openvsx_downloads,openvsx_reviews,openvsx_version,marketplace_installs\n';
mkdirSync(dirname(out) || '.', { recursive: true });
if (!existsSync(out)) { appendFileSync(out, HEADER); }
const date = new Date().toISOString().slice(0, 10);
for (const id of ids) {
    const [o, m] = await Promise.allSettled([openVsx(id), marketplace(id)]);
    const ov = o.status === 'fulfilled' ? o.value : { downloads: '', reviews: '', version: '' };
    const mv = m.status === 'fulfilled' ? m.value : '';
    if (o.status === 'rejected') { console.error(`${id}: ${o.reason.message}`); }
    if (m.status === 'rejected') { console.error(`${id}: ${m.reason.message}`); }
    appendFileSync(out, `${date},${id},${ov.downloads},${ov.reviews},${ov.version},${mv}\n`);
    console.log(`${id}: openvsx ${ov.downloads} (${ov.reviews} reviews, v${ov.version}), marketplace ${mv}`);
}
