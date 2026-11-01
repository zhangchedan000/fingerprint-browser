import { createHash, generateKeyPairSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The ID the browser gives an extension, as Chromium works it out (components/crx_file/id_util.cc):
 * the first 16 bytes of a SHA-256, in hex written with a–p. With a "key" in its manifest the hash is
 * of the key, so the ID is the same on every computer; without one it is of the folder's path
 * (UTF-16 on Windows, drive letter in upper case), so each computer gives it another ID.
 */
function idFromBytes(bytes: Buffer): string {
  return [...createHash('sha256').update(bytes).digest('hex').slice(0, 32)].map((ch) => String.fromCharCode(97 + Number.parseInt(ch, 16))).join('')
}

export function extensionIdForKey(key: string): string {
  return idFromBytes(Buffer.from(key.replace(/\s+/g, ''), 'base64'))
}

export function extensionIdForPath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return idFromBytes(Buffer.from(path, 'utf8'))
  const normalized = /^[a-z]:/.test(path) ? path[0].toUpperCase() + path.slice(1) : path
  return idFromBytes(Buffer.from(normalized, 'utf16le'))
}

export function manifestKey(manifest: unknown): string | undefined {
  const key = manifest && typeof manifest === 'object' ? (manifest as { key?: unknown }).key : undefined
  return typeof key === 'string' && key.trim() ? key : undefined
}

/** A new public key for a manifest that has none (the private half is not needed for a loaded folder). */
export function newManifestKey(): string {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
}

/**
 * The extension folder's browser ID, and what makes the same extension recognisable on another
 * computer: its key, or (without one) its manifest's contents.
 */
export async function extensionIdentity(folder: string): Promise<{ chromeId: string; identity: string }> {
  const text = await readFile(join(folder, 'manifest.json'))
  const key = manifestKey(JSON.parse(text.toString('utf8')) as unknown)
  if (key) {
    const chromeId = extensionIdForKey(key)
    return { chromeId, identity: `key:${chromeId}` }
  }
  return { chromeId: extensionIdForPath(folder), identity: `manifest:${createHash('sha256').update(text).digest('hex')}` }
}
