#!/usr/bin/env node
/**
 * Measures the GPU list built into a fingerprint-chromium kernel and saves it to
 * src/shared/gpu-catalogs.json under the kernel's major version.
 *
 * The kernel picks its GPU as list[seed % list.length]; launching it with seeds 0, 1, 2, ...
 * and reading the WebGL renderer reveals the list in order. Needs a kernel that runs on this
 * machine (the Linux release works on Linux; the list is the same on every OS).
 *
 *   node tools/gpu-catalog/probe.mjs --chrome /path/to/chrome --version 150.0.7871.186
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const chrome = option('--chrome')
const version = option('--version')
const maxSeeds = Number(option('--max') ?? 240)
if (!chrome || !/^\d+(\.\d+){3}$/.test(version ?? '')) {
  console.error('Usage: probe.mjs --chrome <path> --version <a.b.c.d> [--max 240]')
  process.exit(1)
}
const CATALOG = resolve('src/shared/gpu-catalogs.json')

const READ_RENDERER = `(() => {
  const gl = document.createElement('canvas').getContext('webgl');
  const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'NO-WEBGL';
})()`

async function renderer(platform, seed, attempt = 1) {
  const profile = await mkdtemp(join(tmpdir(), 'gpu-probe-'))
  try {
    return await rendererOnce(platform, seed, profile)
  } catch (error) {
    if (attempt >= 3) throw error
    return renderer(platform, seed, attempt + 1)
  } finally {
    await rm(profile, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Starts the kernel headless, asks for the WebGL renderer over the DevTools protocol, closes it. */
async function rendererOnce(platform, seed, profile) {
  const child = spawn(chrome, [
    `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    `--fingerprint=${seed}`, `--fingerprint-platform=${platform}`, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  try {
    const browserUrl = await new Promise((resolveUrl, reject) => {
      let text = ''
      const timer = setTimeout(() => reject(new Error('Kernel did not start')), 30_000)
      child.stderr.on('data', (chunk) => {
        text += chunk
        const match = text.match(/DevTools listening on (ws:\/\/\S+)/)
        if (match) { clearTimeout(timer); resolveUrl(match[1]) }
      })
      child.once('exit', () => reject(new Error('Kernel exited early')))
    })
    const port = new URL(browserUrl).port
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = targets.find((target) => target.type === 'page')
    const socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((ok, fail) => { socket.onopen = ok; socket.onerror = fail })
    const reply = await new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error('No reply')), 30_000)
      socket.onmessage = (event) => { clearTimeout(timer); ok(JSON.parse(event.data)) }
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: READ_RENDERER, returnByValue: true } }))
    })
    socket.close()
    const value = reply.result?.result?.value
    if (!value || value === 'NO-WEBGL') throw new Error(`No WebGL renderer for seed ${seed}`)
    return value
  } finally {
    child.kill('SIGKILL')
  }
}

/** "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 (0x00002882) Direct3D11 ...)" -> parts. */
function parse(text, platform) {
  if (platform === 'macos') {
    const model = text.match(/Metal Renderer: (.+?), /)?.[1]
    return { vendor: 'Apple', model, renderer: text }
  }
  const match = text.match(/^ANGLE \(([^,]+), (.+?) \((0x[0-9A-Fa-f]+)\)/)
  if (!match) throw new Error(`Unrecognised renderer: ${text}`)
  return { vendor: match[1], model: match[2], deviceId: match[3], renderer: text }
}

async function measure(platform) {
  const seen = []
  for (let seed = 0; seed < maxSeeds; seed++) {
    const batch = await Promise.all(Array.from({ length: 6 }, (_, i) => renderer(platform, seed + i)))
    seen.push(...batch)
    seed += batch.length - 1
    // Smallest period that explains everything seen, seen in full at least twice, and never on fewer than 24 seeds.
    for (let period = 1; seen.length >= 24 && period * 2 <= seen.length; period++) {
      if (seen.every((value, index) => value === seen[index % period])) {
        return seen.slice(0, period).map((text) => parse(text, platform))
      }
    }
  }
  throw new Error(`${platform}: no repeating list within ${maxSeeds} seeds`)
}

const major = version.split('.')[0]
const result = { kernelVersion: version, measuredAt: new Date().toISOString().slice(0, 10) }
for (const platform of ['windows', 'macos']) {
  result[platform] = await measure(platform)
  console.log(`${platform}: ${result[platform].length} GPUs`)
}
const catalogs = JSON.parse(await readFile(CATALOG, 'utf8').catch(() => '{}'))
catalogs[major] = result
const sorted = Object.fromEntries(Object.entries(catalogs).sort(([a], [b]) => Number(a) - Number(b)))
await writeFile(CATALOG, `${JSON.stringify(sorted, null, 2)}\n`)
console.log(`Saved kernel ${major} to ${CATALOG}`)
