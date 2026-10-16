/** pnpm forwards a literal `--` before script args. Drop it so README syntax works. */
export function stripArgvSeparators(argv: readonly string[]): string[] {
  return argv.filter((item) => item !== '--');
}
