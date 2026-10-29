// A terminal also emits cursor, focus, mouse and resize control sequences.
// They redraw the UI but do not mean the agent produced useful output.
export function hasTerminalOutput(data: string): boolean {
  const visible = data
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x1f\x7f]/g, "");
  return visible.trim().length > 0;
}

export function hasTerminalInput(data: string): boolean {
  if (/^\x1b\[</.test(data)) return false; // terminal mouse reporting
  return data === "\r" || data === "\n" || hasTerminalOutput(data);
}
