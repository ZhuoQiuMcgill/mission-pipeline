// 4.4.1 (Windows): how to call the engine in PowerShell. There `mp` is PowerShell's own read-only
// alias of Move-ItemProperty, which wins over a program on the PATH, and a harness starts PowerShell
// with no profile: `mp.ps1` (the shim npm makes beside `mp`) reaches the engine and passes every
// argument intact; `mp.cmd` called from PowerShell drops the double quotes inside an argument.
// The texts that tell a role how to run `mp` end with POWERSHELL_NOTE on Windows only; elsewhere they
// are 4.4.0's, byte for byte. The platform is a parameter so both forms are tested on every system.

/** The one sentence a role on Windows is told where it first learns to run `mp`. */
export const POWERSHELL_NOTE = "In PowerShell, write `mp.ps1` for `mp` (there `mp` is PowerShell's own alias of Move-ItemProperty); `mp.cmd` called from PowerShell drops double quotes inside an argument.";

export function onWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

/** `text`, then POWERSHELL_NOTE on Windows; `text` unchanged elsewhere. */
export function withPowerShellNote(text: string, platform: NodeJS.Platform = process.platform): string {
  return onWindows(platform) ? `${text} ${POWERSHELL_NOTE}` : text;
}

/** A PowerShell single-quoted string: each single quote (PowerShell also reads the typographic ones as quotes) doubled. */
export function psQuote(text: string): string {
  return `'${text.replace(/['‘’‚‛]/g, (q) => q + q)}'`;
}
