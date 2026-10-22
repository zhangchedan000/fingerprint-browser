// Opens real sites in a downloaded fingerprint-chromium kernel with the app's launch arguments and
// reports renderer crashes ("Aw, Snap!"). Used by .github/workflows/kernel-smoke.yml.
import { spawn, execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
await build({ entryPoints: ['tools/kernel-smoke/args.ts'], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'error',
  // proxy-chain is CommonJS and requires Node built-ins.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } })
const { smokeArgs, openProxyBridge, deepCheck, smokeProfile } = await import(`file://${bundle.replace(/\\/g, '/')}`)

// PROXY (socks5://user:pass@host:port or http://…): every window goes through the app's own proxy
// bridge, and curl first checks the proxy itself, so a proxy fault and a kernel fault are told apart.
const failures = []
const summary = []
let bridge
if (process.env.PROXY) {
  const upstream = new URL(process.env.PROXY)
  const proxy = { protocol: upstream.protocol.replace(':', ''), host: upstream.hostname.replace(/^\[|\]$/g, ''), port: Number(upstream.port), username: decodeURIComponent(upstream.username), password: decodeURIComponent(upstream.password) }
  bridge = await openProxyBridge(proxy, { onFailure: (error) => console.log(`bridge failure: ${error?.message ?? error}`) })
  const curlProxy = process.env.PROXY.replace(/^socks5:/, 'socks5h:')
  for (const url of urls) {
    for (const [label, via] of [['proxy', curlProxy], ['bridge', bridge]]) {
      let out
      try { out = execFileSync('curl', ['-sS', '-o', 'NUL', '-m', '30', '-w', '%{http_code}', '-x', via, url], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch (error) { out = `fail ${String(error.stderr || error.message).trim().split('\n').pop()}` }
      console.log(`curl via ${label} · ${url} · ${out}`)
      summary.push(`curl-${label} ${new URL(url).hostname} ${out}`)
    }
  }
}

const releases = await (await fetch('https://api.github.com/repos/adryfish/fingerprint-chromium/releases?per_page=30', { headers })).json()
const assetSuffix = process.platform === 'win32' ? '_windows_x64.zip' : 'x86_64_linux.tar.xz'
// "clearcote" in KERNELS tests the newest Clearcote release (same --fingerprint switches).
const clearcoteReleases = versions.includes('clearcote')
  ? await (await fetch('https://api.github.com/repos/clearcotelabs/clearcote-browser/releases?per_page=10', { headers })).json()
  : []
const clearcoteSuffix = process.platform === 'win32' ? '-windows-x64.zip' : '-linux-x64.tar.xz'

function findFile(dir, name, depth = 0) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isFile() && entry.name === name) return path
    if (entry.isDirectory() && depth < 3) { const found = findFile(path, name, depth + 1); if (found) return found }
  }
}

for (const major of versions) {
  const release = major === 'clearcote'
    ? clearcoteReleases.find((item) => item.assets.some((asset) => asset.name.startsWith('clearcote-') && asset.name.endsWith(clearcoteSuffix)))
    : releases.find((item) => item.tag_name.startsWith(`${major}.`))
  const asset = major === 'clearcote'
    ? release?.assets.find((item) => item.name.startsWith('clearcote-') && item.name.endsWith(clearcoteSuffix))
    : release?.assets.find((item) => item.name.endsWith(assetSuffix))
  if (asset) console.log(`Kernel ${major}: ${release.tag_name} · ${asset.name}`)
  if (asset) summary.push(`release ${major}: tag=${release.tag_name} prerelease=${release.prerelease} asset=${asset.name} size=${asset.size} digest=${asset.digest} url=${asset.browser_download_url}`)
  if (!asset) { console.log(`::warning::no ${assetSuffix} for kernel ${major}`); continue }
  const archive = join(work, asset.name)
  await pipeline(Readable.fromWeb((await fetch(asset.browser_download_url, { headers: { 'user-agent': 'kernel-smoke' } })).body), createWriteStream(archive))
  const folder = join(work, release.tag_name)
  mkdirSync(folder)
  execFileSync('tar', ['-xf', archive], { cwd: folder })
  const chrome = findFile(folder, process.platform === 'win32' ? 'chrome.exe' : 'chrome')
  if (!chrome) throw new Error(`chrome not found for ${release.tag_name}`)
  if (process.env.BISECT === 'prefs') {
    // The app's Default/Preferences (https-first, Google search): does the kernel keep them?
    const { patchPrefs } = await import(`file://${bundle.replace(/\\/g, '/')}`)
    const userDataDir = mkdtempSync(join(work, 'prefs-'))
    if (process.env.PREFS_EXISTING) {
      // A window that already ran once before the app wrote these preferences.
      const first = spawn(chrome, [...smokeArgs(userDataDir, release.tag_name, 'windows', 'Chrome'), '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' })
      await new Promise((resolve) => setTimeout(resolve, 8000))
      const firstPort = readFileSync(join(userDataDir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]
      const firstBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${firstPort}`)
      await firstBrowser.close().catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 4000))
      first.kill()
      rmSync(join(userDataDir, 'DevToolsActivePort'), { force: true })
      const before = JSON.parse(readFileSync(join(userDataDir, 'Default', 'Preferences'), 'utf8'))
      console.log(`::warning title=prefs before ${major}::engine=${before.default_search_provider_data?.template_url_data?.short_name}`)
      writeFileSync(join(userDataDir, 'Default', 'Preferences'), JSON.stringify(patchPrefs(before)))
    } else {
      mkdirSync(join(userDataDir, 'Default'))
      writeFileSync(join(userDataDir, 'Default', 'Preferences'), JSON.stringify(patchPrefs({})))
    }
    const child = spawn(chrome, [...smokeArgs(userDataDir, release.tag_name, 'windows', 'Chrome'), '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' })
    await new Promise((resolve) => setTimeout(resolve, 8000))
    let port; try { port = readFileSync(join(userDataDir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0] } catch {}
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const settings = await browser.contexts()[0].newPage()
    await settings.goto('chrome://settings/search').catch(() => {})
    await settings.waitForTimeout(3000)
    const shown = await settings.evaluate(() => {
      const texts = []
      const walk = (node) => { if (node.shadowRoot) walk(node.shadowRoot); for (const child of node.children ?? []) walk(child); if (node.tagName === 'SELECT') texts.push('select=' + node.options[node.selectedIndex]?.textContent); }
      walk(document.documentElement)
      return texts.join(' ; ')
    }).catch((error) => 'settings: ' + error.message)
    console.log(`::warning title=search settings ${major}::${shown}`)
    await browser.close().catch(() => {})
    child.kill()
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const prefs = JSON.parse(readFileSync(join(userDataDir, 'Default', 'Preferences'), 'utf8'))
    let secure = {}; try { secure = JSON.parse(readFileSync(join(userDataDir, 'Default', 'Secure Preferences'), 'utf8')) } catch {}
    const engine = prefs.default_search_provider_data?.template_url_data
    console.log(`::warning title=prefs ${major}::https_only=${prefs.https_only_mode_enabled} engine=${engine?.short_name} ${engine?.url} | reset=${JSON.stringify(prefs.prefs?.preference_reset_time ?? prefs.profile?.reset_prompt_memento ?? '')} | secure macs: ${Object.keys(secure.protection?.macs ?? {}).join(',').slice(0, 600)} | secure dsp: ${JSON.stringify(secure.default_search_provider_data ?? '').slice(0, 300)}`)
    continue
  }
  if (process.env.BISECT === 'rects') {
    // Different windows (seeds): ClientRects, SVG and canvas should differ; also with the app's args.
    const probe = `(() => {
      const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16) }
      const d = document.createElement('div'); d.style.cssText = 'position:absolute;left:10.5px;top:20.25px;font:16px Arial;transform:scale(1.1) rotate(3deg)'; d.textContent = 'Cwm fjordbank glyphs vext quiz'; document.body.appendChild(d)
      const r = d.getClientRects()[0]; const b = d.getBoundingClientRect()
      const range = document.createRange(); range.selectNodeContents(d); const rr = range.getBoundingClientRect()
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const t = document.createElementNS('http://www.w3.org/2000/svg', 'text'); t.textContent = 'Cwm fjordbank'; svg.appendChild(t); document.body.appendChild(svg)
      const c = document.createElement('canvas'); const x = c.getContext('2d'); x.font = '16px Arial'; x.fillText('Cwm fjordbank glyphs', 2, 20)
      return 'rects ' + hash([r.x, r.y, r.width, r.height, b.width, rr.width].join(',')) + ' (' + r.width + ') svg ' + t.getComputedTextLength() + ' canvas ' + hash(c.toDataURL()) + ' measure ' + x.measureText('Cwm fjordbank glyphs').width
    })()`
    const rows = []
    const cases = [['plain', null], ['seed only', 1000], ['app 1000', 1000], ['app 2000', 2000], ['app off:canvas', 1000, 'canvas'], ['app off:font', 1000, 'font']]
    for (const [label, seed, off] of cases) {
      const userDataDir = mkdtempSync(join(work, 'rects-'))
      const app = smokeArgs(userDataDir, release.tag_name, 'windows', 'Chrome').map((arg) => arg.startsWith('--fingerprint=') ? `--fingerprint=${seed}` : arg)
      const args = label === 'plain' ? [`--user-data-dir=${userDataDir}`] : label === 'seed only' ? [`--user-data-dir=${userDataDir}`, `--fingerprint=${seed}`] : off ? [...app.filter((arg) => !arg.startsWith('--disable-spoofing=')), `--disable-spoofing=${off}`] : app
      const child = spawn(chrome, [...args, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' })
      let port
      for (let attempt = 0; attempt < 150 && !port; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        try { port = readFileSync(join(userDataDir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0] || undefined } catch {}
      }
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      const page = browser.contexts()[0].pages()[0] ?? await browser.contexts()[0].newPage()
      rows.push(`${label}: ${await page.evaluate(probe)}`)
      await browser.close().catch(() => {})
      child.kill()
    }
    console.log(`::warning title=rects ${major}::${rows.join(' | ')}`)
    continue
  }
  if (process.env.BISECT === 'stable') {
    // Same window (same arguments, same data folder) opened several times: canvas must not change.
    const userDataDir = mkdtempSync(join(work, 'stable-'))
    const args = smokeArgs(userDataDir, release.tag_name, 'windows', 'Chrome')
    const draw = `(() => {
      const c = document.createElement('canvas'); c.width = 280; c.height = 60
      const x = c.getContext('2d'); x.textBaseline = 'top'; x.font = '16px Arial'; x.fillStyle = '#f60'; x.fillRect(100, 1, 62, 20)
      x.fillStyle = '#069'; x.fillText('Cwm fjordbank glyphs vext quiz, \u{1F603}', 2, 15); x.fillStyle = 'rgba(102,204,0,0.7)'; x.fillText('Cwm fjordbank glyphs vext quiz', 4, 17)
      x.beginPath(); x.arc(50, 30, 20, 0, Math.PI * 2); x.stroke()
      const s = c.toDataURL(); let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
      return (h >>> 0).toString(16)
    })()`
    const hashes = []
    for (let run = 0; run < 3; run++) {
      const child = spawn(chrome, [...args, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' })
      let port
      for (let attempt = 0; attempt < 150 && !port; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        try { port = readFileSync(join(userDataDir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0] || undefined } catch {}
      }
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      const page = browser.contexts()[0].pages()[0] ?? await browser.contexts()[0].newPage()
      hashes.push(`${await page.evaluate(draw)}/${await page.evaluate(draw)}`)
      await browser.close().catch(() => {})
      child.kill()
      await new Promise((resolve) => setTimeout(resolve, 2000))
      try { rmSync(join(userDataDir, 'DevToolsActivePort')) } catch {}
    }
    console.log(`::warning title=canvas across launches ${major}::${hashes.join(' | ')}`)
    continue
  }
  if (process.env.BISECT === 'deep') {
    // The app's deep check, as the editor runs it, against the real sites.
    const results = await deepCheck({ profile: smokeProfile('windows', 'Chrome'), engine: { executable: chrome, version: release.tag_name, fingerprintKernel: true }, hostHardwareConcurrency: 4, hostScreen: { width: 1920, height: 1080 } })
    for (const result of results) {
      console.log(`::warning title=deep ${result.site}::${result.status} ${result.score ?? ''} | ${result.findings.join(' ; ')} | ${result.error ?? ''} | screenshot ${result.screenshot ? Math.round(result.screenshot.length / 1024) + 'KB' : 'none'}`)
    }
    continue
  }
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
  } else if (process.env.BISECT === 'seeds') {
    // The app's arguments for a fresh window with many seeds: kernel bugs that hit only some seeds.
    const engineVersion = asset.name.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1] ?? release.tag_name
    for (const platform of ['windows', 'macos']) {
      for (let index = 0; index < Number(process.env.SEEDS || 8); index += 1) {
        const seed = (index * 2654435761 + 12345) >>> 0
        const args = smokeArgs('USERDATA', engineVersion, platform, 'Chrome').map((arg) => arg.startsWith('--fingerprint=') ? `--fingerprint=${seed}` : arg)
        variants.push({ label: `${platform} seed ${seed}`, args })
      }
    }
  } else if (process.env.BISECT === 'sites') {
    // One app-style window; each page's visible text is reported (calibrates the deep check).
    variants.push({ label: 'windows · Chrome', args: [...smokeArgs('USERDATA', release.tag_name, 'windows', 'Chrome').filter((arg) => !(process.env.SITE_LANG && /^--(lang|accept-lang|fingerprint-language)=/.test(arg))), ...(process.env.SITE_LANG ? [`--lang=${process.env.SITE_LANG}`, `--accept-lang=${process.env.SITE_LANG}`, `--fingerprint-language=${process.env.SITE_LANG}`] : [])] })
  } else if (process.env.BISECT === 'surface') {
    const base = (seed) => [`--user-data-dir=USERDATA`, `--fingerprint=${seed}`]
    for (const seed of [1000, 1234567, 3150083396]) variants.push({ label: `seed ${seed}`, args: base(seed) })
    for (const surface of ['font', 'audio', 'canvas', 'clientrects', 'gpu']) variants.push({ label: `seed 1000 off:${surface}`, args: [...base(1000), `--disable-spoofing=${surface}`] })
    variants.push({ label: 'seed 1000 off:all', args: [...base(1000), '--disable-spoofing=font,audio,canvas,clientrects,gpu'] })
  } else if (process.env.BISECT === 'args') {
    // A window's exact launch arguments ('|'-separated, as copied from the crash details),
    // then the same without each one. Paths, logging and start pages are the runner's own.
    const own = /^--(user-data-dir|log-file|enable-logging|v)(=|$)/
    const given = (process.env.ARGS || '').split('|').map((item) => item.trim())
      .filter((item) => item.startsWith('--') && !own.test(item))
    const full = ['--user-data-dir=USERDATA', ...given]
    variants.push({ label: 'no fingerprint args', args: ['--user-data-dir=USERDATA'] })
    variants.push({ label: 'all args', args: full })
    for (const arg of given) variants.push({ label: `without ${arg.split('=')[0]}`, args: full.filter((item) => item !== arg) })
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
      for (const brand of ['Chrome', 'Edge']) variants.push({ label: `${platform} · ${brand}`, args: smokeArgs('USERDATA', release.tag_name, platform, brand, bridge) })
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
      if (!port) { failures.push(`${label}: browser did not start (exit ${child.exitCode})`); summary.push(`NO-START ${label} exit ${child.exitCode}`); console.log(log.slice(-3000)); child.kill(); continue }
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      for (const url of urls) {
        const page = await browser.contexts()[0].newPage()
        let crashed = false
        page.on('crash', () => { crashed = true })
        const result = await page.goto(url, { timeout: 45_000, waitUntil: 'load' }).then((response) => `HTTP ${response?.status()}`, (error) => error.message.split('\n')[0])
        await page.waitForTimeout(6000)
        if (process.env.BISECT === 'sites' && !crashed) {
          await page.waitForTimeout(Number(process.env.SITE_WAIT || 20000))
          const text = await page.evaluate(() => document.body.innerText).catch((error) => `evaluate failed: ${error.message}`)
          for (let part = 0; part < 3; part++) {
            const chunk = text.slice(part * 3000, (part + 1) * 3000)
            if (chunk) console.log(`::warning title=${new URL(url).hostname} text ${part + 1}::${chunk.replace(/%/g, '%25').replace(/\r?\n/g, ' ⏎ ')}`)
          }
        }
        const title = crashed ? '' : await page.title().catch(() => '')
        const failed = !crashed && !/^HTTP [23]/.test(result)
        if (failed) summary.push(`LOAD-FAIL ${label} ${new URL(url).hostname} ${result.slice(0, 80)}`)
        console.log(`${crashed ? '✗ CRASH' : '✓'} ${label} · ${url} · ${result} · ${title}`)
        summary.push(`${crashed ? 'CRASH' : 'ok'} ${label} ${new URL(url).hostname}`)
        if (crashed) failures.push(`${label}: renderer crashed on ${url}`)
        await page.close().catch(() => {})
      }
      // The whole browser can die too (e.g. a CHECK, 0x80000003), not only a tab.
      if (child.exitCode !== null) {
        const code = `0x${(child.exitCode >>> 0).toString(16).toUpperCase()}`
        console.log(`✗ EXIT ${label} · browser exited ${code}`)
        summary.push(`EXIT ${code} ${label}`)
        failures.push(`${label}: browser exited ${code}`)
      }
      await browser.close().catch(() => {})
      child.kill()
      const interesting = log.split(/\r?\n/).filter((line) => /FATAL|Check failed|NOTREACHED|crash|Renderer process/i.test(line)).slice(0, 20)
      if (interesting.length) console.log(`--- ${label} log\n${interesting.join('\n')}`)
  }
}
console.log(`::warning title=Smoke results::${summary.join(' | ')}`)
process.exit(failures.length && !process.env.BISECT ? 1 : 0)
