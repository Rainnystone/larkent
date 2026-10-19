import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Synthetic packages only; no external code is installed or executed. */
export async function writeExternalPlugin(root: string, version = '1.0.0', value = 42) {
  await mkdir(join(root, '.codex-plugin'), { recursive: true });
  await mkdir(join(root, 'skills/calculate/scripts'), { recursive: true });
  await writeFile(join(root, '.codex-plugin/plugin.json'), JSON.stringify({
    name: 'fixture-tools', version, description: 'Calculate a synthetic fixture value', skills: './skills',
    larkent: { aliases: ['fixture'], skills: { calculate: { aliases: ['compute'], requires: { commands: ['node'] } } } },
  }));
  await writeFile(join(root, 'skills/calculate/SKILL.md'), 'Read data.json, then use the existing runtime shell to execute scripts/value.mjs with node.');
  await writeFile(join(root, 'skills/calculate/data.json'), JSON.stringify({ value }));
  await writeFile(join(root, 'skills/calculate/scripts/value.mjs'), [
    "import { readFileSync } from 'node:fs';",
    "const data = JSON.parse(readFileSync(new URL('../data.json', import.meta.url), 'utf8'));",
    'console.log(JSON.stringify({ result: data.value, doubled: data.value * 2 }));',
  ].join('\n'));
  return root;
}

export async function writePureSkillPlugin(root: string) {
  await mkdir(join(root, '.codex-plugin'), { recursive: true });
  await mkdir(join(root, 'skills/engineering/tdd'), { recursive: true });
  await writeFile(join(root, '.codex-plugin/plugin.json'), JSON.stringify({
    name: 'engineering-bundle', version: '1.3.1', description: 'Synthetic engineering workflows',
    skills: ['./skills/engineering/tdd'], larkent: { aliases: ['fixture'] },
  }));
  await writeFile(join(root, 'skills/engineering/tdd/SKILL.md'), 'Synthetic engineering workflow: observe RED, then GREEN.');
  return root;
}
