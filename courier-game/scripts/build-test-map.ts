// Builds public/data/test-town.json from the synthetic «Тестоград» fixture (no network needed).
// Open the game with ?map=test-town to play on it.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertOsm } from '../src/osm/convert';
import { buildTestTown } from '../tests/fixtures/testTown';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { elements, bbox } = buildTestTown();
const { map, stats, warnings } = convertOsm(elements, { name: 'Тестоград', bbox });
const out = resolve(root, 'public/data/test-town.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(map));
console.table(stats);
for (const w of warnings) console.warn(`warning: ${w}`);
console.log(`wrote ${out}`);
