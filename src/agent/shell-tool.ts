/** Tool names whose native results describe a shell process exit status. */
export function isShellTool(name: string | undefined): boolean {
  return /^(?:Bash|Shell|command_execution|run_terminal_cmd)$/i.test(name ?? '');
}
