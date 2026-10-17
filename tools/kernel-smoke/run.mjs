// Opens real sites in a downloaded fingerprint-chromium kernel with the app's launch arguments and
// reports renderer crashes ("Aw, Snap!"). Used by .github/workflows/kernel-smoke.yml.
import { spawn, execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

process.on('uncaughtException', (error) => { console.log(`::error title=Smoke script failed::${String(error?.stack ?? error).replace(/\r?\n/g, '%0A')}`); process.exit(2) })
process.on('unhandledRejection', (error) => { console.log(`::error title=Smoke script failed::${String(error?.stack ?? error).replace(/\r?\n/g, '%0A')}`); process.exit(2) })

const versions = (process.env.KERNELS || '150').split(',').map((item) => item.trim()).filter(Boolean)
const urls = (process.env.URLS || 'https://www.baidu.com,https://www.google.com').split(',').map((item) => item.trim())
const work = mkdtempSync(join(tmpdir(), 'kernel-smoke-'))
const headers = { 'user-agent': 'kernel-smoke', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) }

const bundle = join(work, 'args.mjs')
await build({ entryPoints: ['tools/kernel-smoke/args.ts'], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'error' })
const { smokeArgs } = await import(`file://${bundle.replace(/\\/g, '/')}`)

const releases = await (await fetch('https://api.github.com/repos/adryfish/fingerprint-chromium/releases?per_page=30', { headers })).json()
const assetSuffix = process.platform === 'win32' ? '_windows_x64.zip' : 'x86_64_linux.tar.xz'

function findFile(dir, name, depth = 0) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isFile() && entry.name === name) return path
    if (entry.isDirectory() && depth < 3) { const found = findFile(path, name, depth + 1); if (found) return found }
  }
}

const failures = []
const summary = []
for (const major of versions) {
  const release = releases.find((item) => item.tag_name.startsWith(`${major}.`))
  const asset = release?.assets.find((item) => item.name.endsWith(assetSuffix))
  if (!asset) { console.log(`::warning::no ${assetSuffix} for kernel ${major}`); continue }
  const archive = join(work, asset.name)
  await pipeline(Readable.fromWeb((await fetch(asset.browser_download_url, { headers: { 'user-agent': 'kernel-smoke' } })).body), createWriteStream(archive))
  const folder = join(work, release.tag_name)
  mkdirSync(folder)
  execFileSync('tar', ['-xf', archive], { cwd: folder })
  const chrome = findFile(folder, process.platform === 'win32' ? 'chrome.exe' : 'chrome')
  if (!chrome) throw new Error(`chrome not found for ${release.tag_name}`)
  const bisect = process.env.BISECT === '1'
  const variants = []
  if (process.env.BISECT === 'gpu') {
    // Every position of the kernel's GPU list, twice with unrelated seeds, per emulated system.
    for (const [platform, size] of [['windows', Number(process.env.GPU_WINDOWS || 13)], ['macos', Number(process.env.GPU_MACOS || 6)]]) {
      for (let index = 0; index < size; index += 1) {
        for (const seed of [index, index + size * 7919]) {
          variants.push({ label: `${platform} gpu#${index} seed ${seed}`, args: ['--user-data-dir=USERDATA', `--fingerprint=${seed}`, `--fingerprint-platform=${platform}`] })
        }
      }
    }
  } else if (process.env.BISECT === 'surface') {
    const base = (seed) => [`--user-data-dir=USERDATA`, `--fingerprint=${seed}`]
    for (const seed of [1000, 1234567, 3150083396]) variants.push({ label: `seed ${seed}`, args: base(seed) })
    for (const surface of ['font', 'audio', 'canvas', 'clientrects', 'gpu']) variants.push({ label: `seed 1000 off:${surface}`, args: [...base(1000), `--disable-spoofing=${surface}`] })
    variants.push({ label: 'seed 1000 off:all', args: [...base(1000), '--disable-spoofing=font,audio,canvas,clientrects,gpu'] })
  } else if (bisect) {
    const full = smokeArgs('USERDATA', release.tag_name, 'windows', 'Chrome')
    variants.push({ label: 'no fingerprint args', args: full.filter((arg) => arg.startsWith('--user-data-dir=')) })
    variants.push({ label: 'all args', args: full })
    for (const arg of full) {
      if (arg.startsWith('--user-data-dir=')) continue
      variants.push({ label: `without ${arg.split('=')[0]}`, args: full.filter((item) => item !== arg) })
    }
  } else {
    for (const platform of ['windows', 'macos']) {
      for (const brand of ['Chrome', 'Edge']) variants.push({ label: `${platform} · ${brand}`, args: smokeArgs('USERDATA', release.tag_name, platform, brand) })
    }
  }
  for (const variant of variants) {
      const userDataDir = mkdtempSync(join(work, 'profile-'))
      const args = variant.args.map((arg) => arg.replace('USERDATA', userDataDir))
      const child = spawn(chrome, [...args, '--remote-debugging-port=0', '--enable-logging=stderr', '--v=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
      let log = ''
      child.stderr.on('data', (data) => { log += data })
      let port
      for (let attempt = 0; attempt < 150 && !port; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        const file = join(userDataDir, 'DevToolsActivePort')
        // Chromium may still hold the file open while writing it (EBUSY on Windows).
        try { if (existsSync(file)) port = readFileSync(file, 'utf8').split(/\r?\n/)[0] || undefined } catch {}
      }
      const label = `${major} ${variant.label}`
      if (!port) { failures.push(`${label}: browser did not start (exit ${child.exitCode})`); console.log(log.slice(-3000)); child.kill(); continue }
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      for (const url of urls) {
        const page = await browser.contexts()[0].newPage()
        let crashed = false
        page.on('crash', () => { crashed = true })
        const result = await page.goto(url, { timeout: 45_000, waitUntil: 'load' }).then((response) => `HTTP ${response?.status()}`, (error) => error.message.split('\n')[0])
        await page.waitForTimeout(6000)
        const title = crashed ? '' : await page.title().catch(() => '')
        console.log(`${crashed ? '✗ CRASH' : '✓'} ${label} · ${url} · ${result} · ${title}`)
        summary.push(`${crashed ? 'CRASH' : 'ok'} ${label} ${new URL(url).hostname}`)
        if (crashed) failures.push(`${label}: renderer crashed on ${url}`)
        await page.close().catch(() => {})
      }
      await browser.close().catch(() => {})
      child.kill()
      const interesting = log.split(/\r?\n/).filter((line) => /FATAL|Check failed|NOTREACHED|crash|Renderer process/i.test(line)).slice(0, 20)
      if (interesting.length) console.log(`--- ${label} log\n${interesting.join('\n')}`)
  }
}
console.log(`::warning title=Smoke results::${summary.join(' | ')}`)
process.exit(failures.length && !process.env.BISECT ? 1 : 0)
