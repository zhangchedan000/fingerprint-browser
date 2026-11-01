#!/usr/bin/env node
// Downloads the pinned tunnel core (mihomo) for one target, checks its SHA-256 and leaves the binary
// in build/tunnel-core/current/, which electron-builder ships as resources/tunnel-core/.
//   node tools/tunnel-core/fetch.mjs [win32-x64|darwin-arm64|darwin-x64|linux-x64]
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join, resolve } from 'node:path'

const lock = JSON.parse(readFileSync(new URL('./lock.json', import.meta.url), 'utf8'))
const target = process.argv[2] ?? `${process.platform}-${process.arch}`
const asset = lock.assets[target]
if (!asset) throw new Error(`no tunnel core for ${target}`)
const url = `https://github.com/MetaCubeX/mihomo/releases/download/${lock.version}/${asset.name}`
const response = await fetch(url, { headers: { 'user-agent': 'fingerprint-browser-build' } })
if (!response.ok) throw new Error(`download failed: HTTP ${response.status} ${url}`)
const data = Buffer.from(await response.arrayBuffer())
const sha256 = createHash('sha256').update(data).digest('hex')
if (data.length !== asset.size || sha256 !== asset.sha256) throw new Error(`checksum mismatch for ${asset.name}: ${sha256} (${data.length} bytes)`)

const out = resolve('build/tunnel-core/current')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const binary = join(out, target.startsWith('win32') ? 'mihomo.exe' : 'mihomo')
if (asset.name.endsWith('.zip')) {
  const zip = join(out, asset.name)
  writeFileSync(zip, data)
  execFileSync('tar', ['-xf', zip, '-C', out])
  rmSync(zip)
  const exe = readdirSync(out).find((name) => name.endsWith('.exe') && name !== 'mihomo.exe')
  if (!exe) throw new Error('mihomo.exe not found in the archive')
  renameSync(join(out, exe), binary)
} else {
  writeFileSync(binary, gunzipSync(data))
  chmodSync(binary, 0o755)
}
writeFileSync(join(out, 'LICENSE-mihomo.txt'), `mihomo ${lock.version} (${lock.license}), unmodified build from ${lock.source}\nSource code: ${lock.source}/tree/${lock.version}\n`)
console.log(`tunnel core ${lock.version} for ${target}: ${binary}`)
