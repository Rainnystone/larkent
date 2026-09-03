import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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

function isCmd(path: string): boolean {
  return path.toLowerCase().endsWith('.cmd');
}

export interface ScriptedJsonlOptions {
  lines: readonly unknown[];
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
  version?: string;
  help?: string;
}

export interface ScriptedJsonlExecutable {
  path: string;
  recordPath: string;
}

export interface ScriptedJsonlRecord {
  argv: string[];
  stdin: string;
  cwd: string;
  env: Record<string, string | undefined>;
}

export async function writeScriptedJsonlExecutable(
  file: string,
  options: ScriptedJsonlOptions,
): Promise<ScriptedJsonlExecutable> {
  await mkdir(dirname(file), { recursive: true });
  const win = process.platform === 'win32';
  const scriptPath = win ? `${stripCmd(file)}.cjs` : file;
  const execPath = win ? (isCmd(file) ? file : `${file}.CMD`) : file;
  const recordPath = `${stripCmd(file)}.argv.jsonl`;
  const version = options.version ?? 'scripted-jsonl 0.0.0';
  const help = options.help ?? 'Usage: scripted-jsonl --version';
  const lines = JSON.stringify(options.lines);
  const record = JSON.stringify(recordPath);
  const stderr = options.stderr ? `process.stderr.write(${JSON.stringify(options.stderr)});` : '';
  const exitCode = options.exitCode ?? 0;
  const exitDelayMs = options.exitDelayMs ?? 0;
  const source = `${win ? '' : `#!${process.execPath}\n`}const { writeFileSync } = require('node:fs');
const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log(${JSON.stringify(version)});
  process.exit(0);
}
if (argv.includes('--help')) {
  console.log(${JSON.stringify(help)});
  process.exit(0);
}
const recordPath = ${record};
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  writeFileSync(recordPath, JSON.stringify({
    argv,
    stdin,
    cwd: process.cwd(),
    env: {
      LARK_CHANNEL: process.env.LARK_CHANNEL,
      LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,
      LARK_CHANNEL_HOME: process.env.LARK_CHANNEL_HOME,
      LARK_CHANNEL_CONFIG: process.env.LARK_CHANNEL_CONFIG,
      LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR,
      CODEX_HOME: process.env.CODEX_HOME,
      GROK_DISABLE_AUTOUPDATER: process.env.GROK_DISABLE_AUTOUPDATER,
    },
  }) + '\\n', { flag: 'a' });
  const lines = ${lines};
  for (const line of lines) console.log(JSON.stringify(line));
  ${stderr}
  setTimeout(() => process.exit(${exitCode}), ${exitDelayMs});
});
`;
  await writeFile(scriptPath, source, { mode: 0o755 });
  await chmod(scriptPath, 0o755);
  if (win) {
    await writeFile(execPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, { mode: 0o755 });
  }
  return { path: execPath, recordPath };
}

function stripCmd(file: string): string {
  return isCmd(file) ? file.slice(0, -4) : file;
}
