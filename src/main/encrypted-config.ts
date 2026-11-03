import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * A window's fingerprint switches go to the kernel in an encrypted file instead of on the
 * command line, so the process list (Task Manager, Process Explorer) of the browser and of its
 * child processes does not show them (patch 001, chrome/app/chrome_main.cc in the kernel).
 *
 * The file: "PRISM1:" + base64(12-byte nonce, AES-256-GCM ciphertext, 16-byte tag), additional
 * data "prism-config-1", of JSON [[name, value], ...]. The kernel removes it once read; the
 * launcher removes it too when the browser exits (or did not start).
 *
 * The key is not in this (public) source: releases get it from the build (MAIN_VITE_PRISM_CONFIG_KEY,
 * a GitHub Actions secret), test builds from PRISM_CONFIG_KEY. Without it the switches stay plain.
 */

const PREFIX = 'PRISM1:'
const CONTEXT = Buffer.from('prism-config-1')

export function configKey(): Buffer | undefined {
  const fromBuild = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.MAIN_VITE_PRISM_CONFIG_KEY
  const hex = (fromBuild || process.env.PRISM_CONFIG_KEY || '').trim()
  return /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : undefined
}

/** The switches that go into the file (the kernel takes no others from it). */
export function hiddenSwitch(name: string): boolean {
  if (name.startsWith('fingerprint-config')) return false
  return name.startsWith('fingerprint') || ['timezone', 'disable-spoofing', 'lang', 'accept-lang', 'force-device-scale-factor'].includes(name)
}

export function encryptSwitches(pairs: Array<[string, string]>, key: Buffer): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(CONTEXT)
  const body = Buffer.concat([cipher.update(JSON.stringify(pairs), 'utf8'), cipher.final()])
  return PREFIX + Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64')
}

export function decryptSwitches(text: string, key: Buffer): Array<[string, string]> {
  if (!text.startsWith(PREFIX)) throw new Error('not an encrypted fingerprint config')
  const raw = Buffer.from(text.slice(PREFIX.length), 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  decipher.setAAD(CONTEXT)
  decipher.setAuthTag(raw.subarray(raw.length - 16))
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8')) as Array<[string, string]>
}

/**
 * Moves the fingerprint switches of a launch into an encrypted file in `folder`, leaving
 * --fingerprint-config=<file> in their place. Nothing changes without a key or such switches.
 */
export async function hideFingerprintArgs(args: string[], folder: string, key = configKey()): Promise<{ args: string[]; file?: string }> {
  if (!key) return { args }
  const pairs: Array<[string, string]> = []
  const rest: string[] = []
  for (const arg of args) {
    const match = /^--([^=]+)(?:=([\s\S]*))?$/.exec(arg)
    if (match && hiddenSwitch(match[1])) pairs.push([match[1], match[2] ?? ''])
    else rest.push(arg)
  }
  if (!pairs.length) return { args }
  await mkdir(folder, { recursive: true })
  const file = join(folder, `fingerprint-config-${randomBytes(6).toString('hex')}.txt`)
  await writeFile(file, encryptSwitches(pairs, key), { encoding: 'utf8', mode: 0o600 })
  // In front of the start pages (the last arguments).
  const at = rest.findIndex((arg) => !arg.startsWith('-'))
  const hidden = `--fingerprint-config=${file}`
  return { args: at < 0 ? [...rest, hidden] : [...rest.slice(0, at), hidden, ...rest.slice(at)], file }
}

export async function removeConfigFile(file: string | undefined): Promise<void> {
  if (file) await rm(file, { force: true }).catch(() => undefined)
}
