// Writes text to the system clipboard through the platform's own tool: Node has no clipboard, and Orca gives a
// panel none.
// Adapted from felix-lj-ct/orca-agent-inbox (src/worker.ts, CLIPBOARD, pipeTo and copyText), MIT, Copyright (c) 2026 Felix Li
import { spawn as nodeSpawn } from 'node:child_process'
import { join } from 'node:path'

/** The part of a child process the copy uses, so a test can stub it. */
export type ClipboardProcess = {
  stdin: { on(event: 'error', fn: (error: Error) => void): void; end(text: string): void } | null
  on(event: 'exit', fn: (code: number | null) => void): void
  on(event: 'error', fn: (error: Error) => void): void
}

export type ClipboardSpawn = (
  command: string,
  args: string[],
  options: { stdio: ['pipe', 'ignore', 'ignore']; windowsHide: true },
) => ClipboardProcess

/** Windows PowerShell 5.1, in every Windows since 10. */
const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** Each platform's tools, in the order the copy tries them. PowerShell reads the text as UTF-8, whatever the code page. */
export const CLIPBOARD_TOOLS: Record<string, string[][]> = {
  darwin: [['pbcopy']],
  linux: [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']],
  win32: [
    [
      POWERSHELL,
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$in = New-Object IO.MemoryStream; [Console]::OpenStandardInput().CopyTo($in); Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString($in.ToArray()))',
    ],
  ],
}

/** Feeds the text to a tool. Waits for its exit, not its pipes: wl-copy and xclip leave a child holding them. */
function pipeTo(spawn: ClipboardSpawn, file: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    child.on('error', reject)
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${file} exited with ${code}`))))
    child.stdin?.on('error', reject)
    child.stdin?.end(text)
  })
}

/** Writes the text with the first of the platform's tools that works. Throws when none does. */
export async function copyToClipboard(
  text: string,
  { platform = process.platform, spawn = nodeSpawn as unknown as ClipboardSpawn }: { platform?: string; spawn?: ClipboardSpawn } = {},
): Promise<void> {
  const tools = CLIPBOARD_TOOLS[platform] ?? []
  if (tools.length === 0) throw new Error(`no clipboard tool on ${platform}`)
  for (const [file, ...args] of tools) {
    try {
      await pipeTo(spawn, file, args, text)
      return
    } catch {
      // Not installed, or no display to own the clipboard: try the next.
    }
  }
  const names = tools.map(([file]) => file.split(/[\\/]/).pop()).join(', ')
  throw new Error(`no clipboard tool worked (tried ${names})`)
}
