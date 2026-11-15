// Driver: reads every case from /input/cases.json, renders each with parse(),
// writes /output/html.json (a JSON array of the HTML strings, in order).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const rawCases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const cases = (Array.isArray(rawCases) ? rawCases : rawCases.cases) as { id: string; markdown: string }[];
const out: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) out[i] = parse(cases[i].markdown);
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
