import { kernelChromiumVersion } from '../shared/kernel-id'
import { DEEP_SITES, parseDeepSite, type DeepSiteResult } from '../shared/deep-check'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { effectiveGpu } from '../shared/hardware-profiles'
import { effectiveNetworkIdentity } from '../shared/network-identity'
import { effectiveScreen } from '../shared/screen'
import type {
  BrowserProfile,
  EngineStatus,
  FingerprintCheckItem,
  FingerprintCheckReport,
  FingerprintConfig,
  FingerprintObserved,
  ProxyTestResult
} from '../shared/types'
import type { Logger } from './app-logger'
import { CdpClient, stopChild, waitForPage } from './devtools-session'
import { buildLaunchArgs } from './launch-args'
import { closeProxyBridge, openProxyBridge } from './proxy-bridge'
import { windowWebRtcRelay, type WebRtcRelay } from './webrtc-relay'

/** Runs inside the checked page and reports what a website would see. */
const PROBE = String.raw`(async () => {
  const digest = async (text) => {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(bytes)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  const canvasHash = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 280; canvas.height = 60;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 280, 0);
    gradient.addColorStop(0, '#f60'); gradient.addColorStop(1, '#069');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 280, 60);
    ctx.font = '18px Arial'; ctx.fillStyle = '#fff';
    ctx.fillText('Fingerprint 指纹 \u{1F600} 0123', 8, 36);
    ctx.beginPath(); ctx.arc(240, 30, 18, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.stroke();
    return digest(canvas.toDataURL());
  };
  const audioSum = async () => {
    const context = new OfflineAudioContext(1, 5000, 44100);
    const oscillator = context.createOscillator();
    oscillator.type = 'triangle'; oscillator.frequency.value = 10000;
    const compressor = context.createDynamicsCompressor();
    oscillator.connect(compressor); compressor.connect(context.destination); oscillator.start(0);
    const buffer = await context.startRendering();
    const data = buffer.getChannelData(0);
    let sum = 0; for (let i = 4500; i < 5000; i++) sum += Math.abs(data[i]);
    return sum.toString();
  };
  const rectsHash = async () => {
    const span = document.createElement('span');
    span.style.cssText = 'position:absolute;left:-9999px;font:15px serif';
    span.textContent = 'Rect 指纹 measurement';
    document.body.appendChild(span);
    const range = document.createRange(); range.selectNodeContents(span);
    const values = [...range.getClientRects()].map((r) => [r.x, r.y, r.width, r.height].join(',')).join('|') + '|' + JSON.stringify(span.getBoundingClientRect());
    span.remove();
    return digest(values);
  };
  const fonts = ['Arial', 'Calibri', 'Segoe UI', 'Helvetica Neue', 'Menlo', 'Microsoft YaHei', 'SimSun', 'PingFang SC',
    'Times New Roman', 'Courier New', 'Georgia', 'Verdana', 'Tahoma', 'Consolas', 'Monaco', 'Comic Sans MS', 'Impact',
    'Trebuchet MS', 'Cambria', 'Malgun Gothic', 'Meiryo', 'Arial Unicode MS', 'Roboto', 'Noto Sans'];
  const fontHash = async () => {
    const ctx = document.createElement('canvas').getContext('2d');
    const width = (font) => { ctx.font = '40px ' + font; return ctx.measureText('mmmmmmmmmmlli 字体').width; };
    const base = ['monospace', 'serif', 'sans-serif'].map(width);
    const found = fonts.map((font) => ['monospace', 'serif', 'sans-serif'].map((fallback, i) => width('"' + font + '",' + fallback) - base[i]).join(','));
    return digest(found.join('|'));
  };
  const out = {};
  out.userAgent = navigator.userAgent;
  try {
    const high = navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(['platformVersion']) : null;
    out.uaPlatform = navigator.userAgentData ? navigator.userAgentData.platform : undefined;
    out.uaPlatformVersion = high ? high.platformVersion : undefined;
  } catch {}
  out.cores = navigator.hardwareConcurrency;
  out.memory = navigator.deviceMemory;
  out.screen = [screen.width, screen.height];
  out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  out.language = navigator.language;
  out.webdriver = navigator.webdriver === true;
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) { out.webglVendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL); out.webglRenderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL); }
  } catch {}
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter && adapter.info) out.webgpuVendor = adapter.info.vendor || undefined;
    }
  } catch {}
  out.canvas = [await canvasHash(), await canvasHash()];
  out.audio = [await audioSum(), await audioSum()];
  out.clientrects = [await rectsHash(), await rectsHash()];
  out.font = [await fontHash(), await fontHash()];
  try {
    const source = 'postMessage({ userAgent: navigator.userAgent, cores: navigator.hardwareConcurrency, language: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })';
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    out.worker = await new Promise((resolve) => { worker.onmessage = (e) => resolve(e.data); setTimeout(() => resolve(undefined), 3000); });
    worker.terminate();
  } catch {}
  out.webrtcIps = await new Promise((resolve) => {
    const ips = new Set();
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      pc.createDataChannel('probe');
      pc.onicecandidate = (event) => {
        const text = event.candidate && event.candidate.candidate;
        const match = text && text.match(/candidate:\S+ \d+ \S+ \d+ (\S+) /);
        if (match) ips.add(match[1]);
      };
      pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => undefined);
      setTimeout(() => { pc.close(); resolve([...ips]); }, 3000);
    } catch { resolve([]); }
  });
  return out;
})()`

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>check</title></head><body></body></html>'

const SURFACE_NAMES = { canvas: 'Canvas', audio: 'AudioContext', clientrects: 'ClientRects', font: '字体' } as const
type Surface = keyof typeof SURFACE_NAMES
/**
 * Prism kernels leave these as the real machine computes them (patches 006, 008): Windows Chrome
 * has only a few audio sums and whole-1/64-px rects, shared by many real computers.
 */
const ALWAYS_REAL: ReadonlySet<Surface> = new Set(['audio', 'clientrects'])

export interface ExpectedIdentity {
  cores: number
  screen: [number, number]
  timezone: string
  language: string
}

export interface OtherWindowCheck {
  label: string
  observed: FingerprintObserved
  disabledSpoofing: FingerprintConfig['disabledSpoofing']
}

const OS_NAME = { windows: 'Windows', macos: 'macOS' } as const

/** Turns what the page saw into green / yellow / red results, one or more per editor row. */
export function evaluateFingerprint(input: {
  fingerprint: FingerprintConfig
  engine: Pick<EngineStatus, 'version' | 'fingerprintKernel' | 'webrtcRelay'>
  observed: FingerprintObserved
  expected: ExpectedIdentity
  proxy?: ProxyTestResult
  usesProxy: boolean
  others: OtherWindowCheck[]
}): FingerprintCheckItem[] {
  const { fingerprint: fp, engine, observed, expected, proxy, usesProxy, others } = input
  const items: FingerprintCheckItem[] = []
  const add = (item: FingerprintCheckItem) => items.push(item)

  if (!engine.fingerprintKernel) {
    add({ row: 'general', status: 'bad', message: '当前不是指纹内核，指纹设置不会生效；请在内核管理里下载或导入指纹内核' })
  }

  // System, browser brand and version: what the UA and UA-CH say.
  const os = OS_NAME[fp.platform]
  const uaOs = /Windows NT/.test(observed.userAgent) ? 'windows' : /Macintosh/.test(observed.userAgent) ? 'macos' : 'other'
  const uaMajor = observed.userAgent.match(/Chrome\/(\d+)/)?.[1]
  const kernelMajor = kernelChromiumVersion(engine.version)?.split('.')[0]
  const edge = /Edg\//.test(observed.userAgent)
  if (uaOs !== fp.platform || (observed.uaPlatform && observed.uaPlatform !== os)) {
    add({ row: 'system', status: 'bad', message: `页面报告的系统是 ${observed.uaPlatform ?? uaOs}，与设置的 ${os} 不一致` })
  } else if ((fp.brand === 'Edge') !== edge) {
    add({ row: 'system', status: 'bad', message: `页面报告的浏览器品牌与设置的 ${fp.brand} 不一致` })
  } else if (uaMajor && kernelMajor && uaMajor !== kernelMajor) {
    add({ row: 'system', status: 'bad', message: `页面报告 Chrome ${uaMajor}，与内核 ${kernelMajor} 不一致` })
  } else {
    add({ row: 'system', status: 'ok', message: `${os} · ${fp.brand}${uaMajor ? ` ${uaMajor}` : ''}，与内核一致` })
  }
  if (fp.platform === 'windows' && observed.uaPlatformVersion) {
    const expectedMajor = fp.platformVersion.split('.')[0]
    const seenMajor = observed.uaPlatformVersion.split('.')[0]
    add(seenMajor === expectedMajor
      ? { row: 'platformVersion', status: 'ok', message: `系统版本 ${observed.uaPlatformVersion}` }
      : { row: 'platformVersion', status: 'bad', message: `页面报告的系统版本 ${observed.uaPlatformVersion} 与设置的 ${fp.platformVersion} 不一致` })
  }

  // Time zone and language against the settings and the proxy's location.
  if (observed.timezone !== expected.timezone) {
    add({ row: 'timezone', status: 'bad', message: `页面时区 ${observed.timezone} 与设置的 ${expected.timezone} 不一致` })
  } else if (proxy?.ok && proxy.timezone && observed.timezone !== proxy.timezone) {
    add({ row: 'timezone', status: 'bad', message: `时区 ${observed.timezone} 与代理 IP 所在地时区 ${proxy.timezone} 不一致`, fix: 'follow-ip' })
  } else if (proxy?.ok && proxy.timezone) {
    add({ row: 'timezone', status: 'ok', message: `时区 ${observed.timezone}，与代理 IP 所在地一致` })
  } else {
    add({ row: 'timezone', status: usesProxy ? 'warn' : 'ok', message: usesProxy ? `时区 ${observed.timezone}；代理检测未拿到所在地时区，无法核对` : `时区 ${observed.timezone}` })
  }
  add(observed.language === expected.language
    ? { row: 'language', status: 'ok', message: `语言 ${observed.language}` }
    : { row: 'language', status: 'bad', message: `页面语言 ${observed.language} 与设置的 ${expected.language} 不一致`, fix: fp.networkIdentityMode === 'proxy' ? undefined : 'follow-ip' })

  // WebRTC: any address other than the proxy's exit gives the real network away.
  const exposed = observed.webrtcIps.filter((ip) => !ip.endsWith('.local') && ip !== proxy?.ip)
  if (!usesProxy) {
    add({ row: 'webrtc', status: 'warn', message: '没有使用代理，网站看到的就是本机真实 IP' })
  } else if (exposed.length) {
    add({ row: 'webrtc', status: 'bad', message: `WebRTC 暴露了 ${exposed.join('、')}，与代理 IP 不同`, fix: 'webrtc-replace' })
  } else {
    add({ row: 'webrtc', status: 'ok', message: 'WebRTC 没有暴露真实 IP' })
  }

  add(observed.screen[0] === expected.screen[0] && observed.screen[1] === expected.screen[1]
    ? { row: 'screen', status: 'ok', message: `分辨率 ${observed.screen[0]} × ${observed.screen[1]}` }
    : { row: 'screen', status: 'bad', message: `页面分辨率 ${observed.screen[0]} × ${observed.screen[1]} 与设置的 ${expected.screen[0]} × ${expected.screen[1]} 不一致：当前内核不支持伪装分辨率，建议改为本机真实`, fix: 'use-real' })

  // GPU: the card asked for, a card that fits the system, and WebGPU agreeing with WebGL.
  const renderer = observed.webglRenderer ?? ''
  const gpuReal = fp.disabledSpoofing.includes('gpu')
  const wanted = gpuReal ? undefined : effectiveGpu(fp, engine.version)
  if (!renderer) {
    add({ row: 'gpu', status: 'warn', message: '页面读不到显卡信息（WebGL 不可用），真实电脑很少这样' })
  } else if (wanted && renderer !== wanted.renderer) {
    add({ row: 'gpu', status: 'bad', message: `页面显示的显卡 ${renderer} 与选择的 ${wanted.model} 不一致`, fix: 'shuffle-gpu' })
  } else if (fp.platform === 'windows' && /Apple|Metal/.test(renderer)) {
    add({ row: 'gpu', status: 'bad', message: '系统是 Windows，显卡却是苹果芯片', fix: 'shuffle-gpu' })
  } else if (fp.platform === 'macos' && /Direct3D|D3D11/.test(renderer)) {
    add({ row: 'gpu', status: 'bad', message: '系统是 macOS，显卡却是 Windows 的 Direct3D', fix: 'shuffle-gpu' })
  } else if (/SwiftShader|llvmpipe/i.test(renderer)) {
    add({ row: 'gpu', status: 'warn', message: '显卡是软件渲染，真实电脑很少见' })
  } else if (observed.webgpuVendor && !renderer.toLowerCase().includes(observed.webgpuVendor.toLowerCase())) {
    add({ row: 'gpu', status: 'warn', message: `WebGPU 报告的厂商 ${observed.webgpuVendor} 与 WebGL 不一致` })
  } else {
    add({ row: 'gpu', status: 'ok', message: gpuReal ? `使用真实显卡：${renderer}` : `显卡 ${wanted?.model ?? renderer}，WebGL 与 WebGPU 一致` })
  }

  add(observed.cores === expected.cores
    ? { row: 'cores', status: 'ok', message: `${observed.cores} 核` }
    : { row: 'cores', status: 'bad', message: `页面报告 ${observed.cores} 核，与设置的 ${expected.cores} 核不一致` })
  const wantedMemory = fp.deviceMemory ?? 8
  if (observed.memory !== undefined) {
    add(observed.memory === wantedMemory
      ? { row: 'memory', status: 'ok', message: `内存 ${observed.memory} GB` }
      : { row: 'memory', status: 'warn', message: `页面报告内存 ${observed.memory} GB，与设置的 ${wantedMemory} GB 不同：当前内核不支持设置内存` })
  }

  // Noise surfaces: stable across reads, and different from every other window.
  for (const surface of Object.keys(SURFACE_NAMES) as Surface[]) {
    const name = SURFACE_NAMES[surface]
    const [first, second] = observed[surface]
    const real = fp.disabledSpoofing.includes(surface)
    const twin = others.find((other) => other.observed[surface][0] === first)
    // Before prism7 these stay real; prism7 gives each window its own unless set to real.
    const alwaysReal = ALWAYS_REAL.has(surface) && !engine.webrtcRelay
    if (surface === 'font' && engine.webrtcRelay && first === second) {
      // prism7+: the fonts of a Windows in that language (or this computer's), never noise.
      add({ row: surface, status: 'ok', message: fp.fontSource === 'host'
        ? `${name} 本机真实字体 · ${first}（用本机字体的窗口都相同）`
        : `${name} 跟随系统语言 · ${first}（同一语言的真实 Windows 相同，属正常）` })
    } else if (first === second && (alwaysReal || (real && ALWAYS_REAL.has(surface)))) {
      add({ row: surface, status: 'ok', message: `${name} 本机真实值 · ${first}（与真实 Chrome 一致，各窗口相同属正常）` })
    } else if (first !== second) {
      add({ row: surface, status: 'bad', message: `${name} 两次读取结果不同，容易被识别为伪装`, fix: 'use-real' })
    } else if (twin && !real) {
      add({ row: surface, status: 'bad', message: `${name} 与窗口 ${twin.label} 相同，两个窗口会被关联`, fix: 'reseed' })
    } else if (twin) {
      add({ row: surface, status: 'warn', message: `${name} 与窗口 ${twin.label} 相同：都用本机真实值，同一台电脑上会一样` })
    } else {
      add({ row: surface, status: 'ok', message: real ? `${name} 使用本机真实值 · ${first}` : `${name} 指纹 ${first}，与其他窗口都不同` })
    }
  }

  // Automation traces and pages vs. background threads.
  if (observed.webdriver) add({ row: 'general', status: 'bad', message: 'navigator.webdriver 为 true，会被识别为自动化浏览器' })
  const worker = observed.worker
  if (!worker) {
    add({ row: 'general', status: 'warn', message: '后台线程（Worker）没有响应，无法核对' })
  } else {
    const mismatch = ([
      ['User-Agent', worker.userAgent === observed.userAgent],
      ['CPU 核数', worker.cores === observed.cores],
      ['语言', worker.language === observed.language],
      ['时区', worker.timezone === observed.timezone]
    ] as const).filter(([, same]) => !same).map(([field]) => field)
    add(mismatch.length
      ? { row: 'general', status: 'bad', message: `后台线程（Worker）报告的 ${mismatch.join('、')} 与页面不一致` }
      : { row: 'general', status: 'ok', message: '页面与后台线程（Worker）信息一致，没有自动化痕迹' })
  }
  return items
}

/** Last check of every window, kept next to the profiles so collisions between windows can be found. */
export class FingerprintCheckStore {
  private cache?: Record<string, FingerprintCheckReport>

  constructor(private readonly path: string) {}

  private async load(): Promise<Record<string, FingerprintCheckReport>> {
    if (!this.cache) {
      this.cache = await readFile(this.path, 'utf8').then((text) => JSON.parse(text) as Record<string, FingerprintCheckReport>).catch(() => ({}))
    }
    return this.cache
  }

  async get(id: string): Promise<FingerprintCheckReport | null> {
    return (await this.load())[id] ?? null
  }

  async all(): Promise<Record<string, FingerprintCheckReport>> {
    return { ...(await this.load()) }
  }

  async set(id: string, report: FingerprintCheckReport): Promise<void> {
    const all = await this.load()
    all[id] = report
    await writeFile(this.path, JSON.stringify(all), { mode: 0o600 })
  }
}

export interface FingerprintRunOptions {
  profile: BrowserProfile
  engine: EngineStatus
  proxy?: ProxyTestResult
  hostHardwareConcurrency: number
  hostPlatformVersion?: string
  hostScreen?: { width: number; height: number }
  /** Tests run without a display; real checks use a real (off-screen) window so the real GPU is used. */
  headless?: boolean
  /** Extra switches, e.g. --no-sandbox when tests run as root. */
  extraArgs?: string[]
  logger?: Logger
}

/** Starts the window's exact browser setup in a throwaway profile and reads what a page sees. */
/**
 * A throwaway browser with the window's launch arguments (and proxy), off-screen or headless,
 * driven over the DevTools protocol. Nothing of the window's own data is touched.
 */
async function withCheckBrowser<T>(options: FingerprintRunOptions, startUrl: string, run: (client: CdpClient) => Promise<T>): Promise<T> {
  const { profile, engine } = options
  if (!engine.executable) throw new Error('没有找到浏览器内核，请先在内核管理里下载或导入')
  const userDataDir = await mkdtemp(join(tmpdir(), 'fb-fingerprint-check-'))
  let proxyUrl: string | undefined
  let child: ReturnType<typeof spawn> | undefined
  let client: CdpClient | undefined
  let webrtcRelay: WebRtcRelay | undefined
  try {
    proxyUrl = await openProxyBridge(profile.proxy)
    webrtcRelay = await windowWebRtcRelay(profile, engine)
    // Same window size as a real launch, just placed off-screen.
    const size = expectedIdentity(profile, options).screen
    const args = buildLaunchArgs({ ...profile, startupMode: 'urls', startUrls: [], window: { ...profile.window, mode: 'custom', x: -32000, y: -32000, width: size[0], height: size[1] } }, {
      userDataDir,
      proxyUrl,
      engineVersion: engine.version,
      fingerprintKernel: engine.fingerprintKernel,
      hostHardwareConcurrency: options.hostHardwareConcurrency,
      hostPlatformVersion: options.hostPlatformVersion,
      proxyIdentity: options.proxy?.ok ? { ...options.proxy, checkedAt: new Date().toISOString() } : undefined,
      allowGeoConflict: true,
      hostScreen: options.hostScreen,
      // As a real launch of this window (browser-launcher.ts).
      windowScreen: engine.windowScreen,
      webrtcRelaySupported: engine.webrtcRelay,
      languageFonts: engine.webrtcRelay,
      seededAudioRects: engine.webrtcRelay,
      webrtcRelayPort: webrtcRelay?.port
    }).filter((arg) => !arg.startsWith('--window-name='))
    args.push('--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--disable-extensions')
    // The window sits off-screen: keep its timers and painting at full speed, as for a visible one.
    args.push('--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling')
    if (options.headless) args.push('--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader')
    if (options.extraArgs) args.push(...options.extraArgs)
    args.push(startUrl)
    child = spawn(engine.executable, args, { stdio: 'ignore', windowsHide: true, env: { ...process.env } })
    // A cold first start (antivirus scanning a fresh kernel) can take well over ten seconds.
    const { websocket } = await waitForPage(userDataDir, 30_000)
    client = await CdpClient.connect(websocket)
    await client.send('Page.enable')
    return await run(client)
  } finally {
    if (client) {
      await Promise.race([client.send('Browser.close').catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 1000))])
      client.close()
    }
    if (child) await stopChild(child)
    await closeProxyBridge(proxyUrl)
    webrtcRelay?.close()
    // Windows can hold files of a just-exited browser for a moment.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(userDataDir, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt === 4) options.logger?.error('清理指纹检测临时目录失败', error)
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
      }
    }
  }
}

export async function observeFingerprint(options: FingerprintRunOptions): Promise<FingerprintObserved> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const pageUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`
  try {
    return await withCheckBrowser(options, pageUrl, async (client) => {
      await client.send('Page.navigate', { url: pageUrl })
      await new Promise((resolve) => setTimeout(resolve, 800))
      const result = await client.send<{ result?: { value?: FingerprintObserved }; exceptionDetails?: { text?: string } }>(
        'Runtime.evaluate',
        { expression: PROBE, awaitPromise: true, returnByValue: true, userGesture: true },
        45_000
      )
      if (!result.result?.value) throw new Error(`读取指纹失败：${result.exceptionDetails?.text ?? '页面没有返回结果'}`)
      return result.result.value
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** Opens each detection site in the check browser and reads its verdict and a screenshot. */
export async function deepCheck(options: FingerprintRunOptions, onSite: (result: DeepSiteResult) => void = () => undefined): Promise<DeepSiteResult[]> {
  return withCheckBrowser(options, 'about:blank', async (client) => {
    const results: DeepSiteResult[] = []
    for (const spec of DEEP_SITES) {
      const result: DeepSiteResult = { site: spec.site, name: spec.name, url: spec.url, status: 'unknown', findings: [] }
      try {
        await client.send('Page.navigate', { url: spec.url }, 30_000)
        const deadline = Date.now() + spec.timeoutMs
        let parsed: ReturnType<typeof parseDeepSite>
        while (!parsed && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1500))
          const page = await client.send<{ result?: { value?: string } }>('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true }).catch(() => undefined)
          parsed = parseDeepSite(spec.site, page?.result?.value ?? '')
        }
        if (parsed) Object.assign(result, parsed)
        else result.error = '没有读到这个网站的结论，请看截图或打开原网页'
        // Let late parts of the page settle before the picture.
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const shot = await client.send<{ data?: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 55 }, 20_000).catch(() => undefined)
        if (shot?.data) result.screenshot = `data:image/jpeg;base64,${shot.data}`
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error)
      }
      results.push(result)
      onSite(result)
    }
    return results
  })
}

/** Everything the page should report for this window, computed the same way the launcher does. */
export function expectedIdentity(profile: BrowserProfile, options: Pick<FingerprintRunOptions, 'proxy' | 'hostHardwareConcurrency' | 'hostScreen'> & { engine?: EngineStatus }): ExpectedIdentity {
  const fp = profile.fingerprint
  const identity = effectiveNetworkIdentity(fp, options.proxy?.ok ? options.proxy : undefined, { allowGeoConflict: true })
  const size = effectiveScreen(fp, options.engine?.fingerprintKernel ? options.engine.version : undefined, options.hostScreen, options.engine?.windowScreen)
  const screen: [number, number] = [size.width, size.height]
  return {
    cores: fp.coresSource === 'host' ? options.hostHardwareConcurrency : fp.hardwareConcurrency,
    screen,
    timezone: identity.timezone,
    language: identity.language
  }
}
