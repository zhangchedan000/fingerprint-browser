import { spawn } from 'node:child_process'

/**
 * Chrome's answer to "is this Windows user's password blank?", as a profile's Local State keeps it
 * (password_manager_util_win.cc CheckBlankPasswordWithPrefs). A profile without it logs on to
 * Windows once with an empty password at its first start; on an account with a password each one
 * is a failed logon, and ten in a row can lock the account. Chrome skips the logon while the stored
 * time is not before the password's last change.
 */
export interface OsPasswordAnswer {
  os_password_blank: boolean
  os_password_last_changed: string
}

const WINDOWS_EPOCH_MS = 11_644_473_600_000n

/** base::Time::ToInternalValue (microseconds since 1601-01-01 UTC), as Chrome writes it to prefs. */
export function chromeTime(unixMs: number): string {
  return ((BigInt(Math.round(unixMs)) + WINDOWS_EPOCH_MS) * 1000n).toString()
}

/** Reads the check script's "age=<seconds> blank=<0|1>" into Chrome's answer. */
export function answerFrom(output: string, now: number): OsPasswordAnswer | undefined {
  const age = /\bage=(\d+)\b/.exec(output)
  const blank = /\bblank=([01])\b/.exec(output)
  if (!age || !blank) return undefined
  // Chrome stores the change time plus a second; a minute also covers the clock between readings.
  return { os_password_blank: blank[1] === '1', os_password_last_changed: chromeTime(now - Number(age[1]) * 1000 + 60_000) }
}

/**
 * Chrome's own check, once: the password's age (NetUserGetInfo) and a logon with an empty
 * password, where "blank" is success or ERROR_ACCOUNT_RESTRICTION (1327). Fails for a domain user,
 * whose machine Chrome never checks either.
 */
const CHECK_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$user = [ADSI]"WinNT://$env:COMPUTERNAME/$env:USERNAME,user"',
  '$age = [int64]$user.PasswordAge.Value',
  // Logon and its error read in one call: PowerShell overwrites the last error between statements.
  "Add-Type -Namespace Prism -Name Logon -MemberDefinition '[DllImport(\"advapi32.dll\", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool LogonUser(string user, string domain, string password, int type, int provider, out IntPtr token); [DllImport(\"kernel32.dll\")] static extern bool CloseHandle(IntPtr handle); public static int EmptyPassword(string user) { IntPtr token; if (LogonUser(user, \".\", \"\", 2, 0, out token)) { CloseHandle(token); return 0; } return Marshal.GetLastWin32Error(); }'",
  '$code = [Prism.Logon]::EmptyPassword($env:USERNAME)',
  '"age=$age blank=$(if ($code -eq 0 -or $code -eq 1327) { 1 } else { 0 })"'
].join('\n')

function runCheckScript(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve(out) : reject(new Error(`Windows 密码检查失败（${code}）`)))
    child.stdin.end(CHECK_SCRIPT)
  })
}

/**
 * Answers Chrome's check for every new profile from one check per launcher run, so a computer whose
 * account has a password sees one failed logon instead of one per new window or fingerprint check.
 */
export class OsPasswordCheck {
  private pending?: Promise<OsPasswordAnswer | undefined>

  constructor(private readonly run: () => Promise<string>, private readonly now: () => number = Date.now) {}

  /** Undefined when it cannot be read (not Windows, a domain user): Chrome then checks as before. */
  answer(): Promise<OsPasswordAnswer | undefined> {
    this.pending ??= this.run().then((output) => answerFrom(output, this.now()), () => undefined)
    return this.pending
  }
}

export const osPasswordCheck = new OsPasswordCheck(process.platform === 'win32' ? runCheckScript : async () => '')
