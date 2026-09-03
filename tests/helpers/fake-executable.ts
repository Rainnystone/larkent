import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export interface ScriptedJsonlExecutableOptions {
  lines?: readonly unknown[];
  stderr?: string;
  exitCode?: number;
  hang?: boolean;
  version?: string;
  helpText?: string;
}

export interface ScriptedJsonlExecutable {
  path: string;
  recordPath: string;
  scriptPath: string;
}

export async function writeVersionExecutable(
  root: string,
  name: string,
  version: string,
  marker = '',
): Promise<string> {
  await mkdir(root, { recursive: true });
  const file = join(root, process.platform === 'win32' && !isCmd(name) ? `${name}.CMD` : name);
  await writeVersionExecutableFile(file, version, marker);
  return file;
}

export async function writeVersionExecutableFile(
  file: string,
  version: string,
  marker = '',
): Promise<void> {
  if (isCmd(file)) {
    const remark = marker ? `rem ${marker}\r\n` : '';
    await writeFile(file, `@echo off\r\necho ${version}\r\n${remark}`, { mode: 0o755 });
    return;
  }

  const comment = marker ? `// ${marker}\n` : '';
  await writeFile(file, `#!${process.execPath}\nconsole.log(${JSON.stringify(version)});\n${comment}`, {
    mode: 0o755,
  });
  await chmod(file, 0o755);
}

export async function writeScriptedJsonlExecutable(
  root: string,
  name: string,
  options: ScriptedJsonlExecutableOptions = {},
): Promise<ScriptedJsonlExecutable> {
  await mkdir(root, { recursive: true });
  const base = isCmd(name) ? name.replace(/\.cmd$/i, '') : name;
  const file = join(root, process.platform === 'win32' ? `${base}.mjs` : base);
  const recordPath = `${file}.argv.json`;
  const scriptPath = scriptPathFor(file);
  await writeScriptedJsonlExecutableFile(file, recordPath, options);
  if (process.platform === 'win32') {
    await writeFile(
      join(root, `${base}.CMD`),
      `@echo off\r\n${JSON.stringify(process.execPath)} ${JSON.stringify(file)} %*\r\n`,
      { mode: 0o755 },
    );
  }
  return { path: file, recordPath, scriptPath };
}

export async function writeScriptedJsonlExecutableFile(
  file: string,
  recordPath: string,
  options: ScriptedJsonlExecutableOptions = {},
): Promise<void> {
  const scriptPath = scriptPathFor(file);
  if (isCmd(file)) {
    const nodeSource = join(dirname(file), `${basename(file).replace(/\.cmd$/i, '')}.mjs`);
    await writeNodeSource(nodeSource, recordPath, scriptPath, options);
    await writeFile(
      file,
      `@echo off\r\n${JSON.stringify(process.execPath)} ${JSON.stringify(nodeSource)} %*\r\n`,
      { mode: 0o755 },
    );
    return;
  }
  await writeNodeSource(file, recordPath, scriptPath, options);
  await chmod(file, 0o755);
}

export function scriptPathFor(file: string): string {
  return `${file}.script.json`;
}

async function writeNodeSource(
  file: string,
  recordPath: string,
  scriptPath: string,
  options: ScriptedJsonlExecutableOptions,
): Promise<void> {
  const version = options.version ?? '0.0.0-pin';
  const helpText = options.helpText ?? 'Usage: fake-cli';
  const lines = options.lines ?? [];
  const stderr = options.stderr ?? '';
  const exitCode = options.exitCode ?? 0;
  const hang = options.hang === true;
  const shebang = process.platform === 'win32' || file.endsWith('.mjs') ? '#!/usr/bin/env node' : `#!${process.execPath}`;
  await writeFile(
    scriptPath,
    `${JSON.stringify({ lines, stderr, exitCode, hang })}\n`,
  );
  const source = [
    shebang,
    'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
    'const argv = process.argv.slice(2);',
    `const recordPath = ${JSON.stringify(recordPath)};`,
    `const scriptPath = ${JSON.stringify(scriptPath)};`,
    'writeFileSync(recordPath, JSON.stringify({',
    '  argv,',
    '  cwd: process.cwd(),',
    '  env: {',
    '    LARK_CHANNEL: process.env.LARK_CHANNEL,',
    '    LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,',
    '    LARK_CHANNEL_HOME: process.env.LARK_CHANNEL_HOME,',
    '    LARK_CHANNEL_CONFIG: process.env.LARK_CHANNEL_CONFIG,',
    '    LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR,',
    '  },',
    '}));',
    'if (argv.includes("--version")) {',
    `  console.log(${JSON.stringify(version)});`,
    '  process.exit(0);',
    '}',
    'if (argv.includes("--help")) {',
    `  console.log(${JSON.stringify(helpText)});`,
    '  process.exit(0);',
    '}',
    `let lines = ${JSON.stringify(lines)};`,
    `let stderr = ${JSON.stringify(stderr)};`,
    `let exitCode = ${JSON.stringify(exitCode)};`,
    `let hang = ${JSON.stringify(hang)};`,
    'if (existsSync(scriptPath)) {',
    '  const script = JSON.parse(readFileSync(scriptPath, "utf8"));',
    '  if (Array.isArray(script.lines)) lines = script.lines;',
    '  if (typeof script.stderr === "string") stderr = script.stderr;',
    '  if (typeof script.exitCode === "number") exitCode = script.exitCode;',
    '  if (typeof script.hang === "boolean") hang = script.hang;',
    '}',
    'for (const line of lines) console.log(JSON.stringify(line));',
    'if (stderr) process.stderr.write(stderr);',
    'if (hang) {',
    '  setInterval(() => {}, 1000);',
    '} else {',
    '  process.exit(exitCode);',
    '}',
  ].join('\n');
  await writeFile(file, source, { mode: 0o755 });
}

function isCmd(path: string): boolean {
  return path.toLowerCase().endsWith('.cmd');
}
