#!/usr/bin/env node
/**
 * The launcher reopens at the size and place it was left at (window-state.json in its user data):
 * a saved 1700 × 1000 window opens at that size and is saved again on quit; a saved maximized
 * one opens maximized; without a saved state it opens at the default 1320 × 820.
 *
 *   npm run build && node tools/app-e2e/window-size.mjs   (Linux: xvfb-run -a -s "-screen 0 2560x1440x24" with a
 *   window manager such as openbox running, or the maximized step cannot maximize)
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { evaluate, launchApp, quitApp, removeTemporaryTree } from './run.mjs'

const app = resolve(process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : process.platform === 'darwin'
  ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
  : 'node_modules/electron/dist/electron')
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
const userData = await mkdtemp(join(tmpdir(), 'prism-window-size-'))
const stateFile = join(userData, 'window-state.json')
process.env.PRISM_E2E_TEAM_OFFLINE = '1'
const failures = []
const size = async (instance) => {
  await delay(1200)
  return evaluate(instance.client, '({ x: screenX, y: screenY, width: outerWidth, height: outerHeight, screenWidth: screen.availWidth })')
}
try {
  let instance = await launchApp({ app }, userData)
  const first = await size(instance)
  console.log('first open', first)
  if (first.width !== 1320 || first.height !== 820) failures.push(`default size ${first.width}×${first.height}`)
  await quitApp(instance)
  console.log('saved on quit', await readFile(stateFile, 'utf8'))

  await writeFile(stateFile, JSON.stringify({ x: 200, y: 100, width: 1700, height: 1000, maximized: false }))
  instance = await launchApp({ app }, userData)
  const second = await size(instance)
  console.log('saved 1700×1000 at 200,100 →', second)
  if (second.width !== 1700 || second.height !== 1000) failures.push(`size not restored: ${second.width}×${second.height}`)
  await quitApp(instance)
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  console.log('saved on quit', saved)
  if (saved.width !== 1700 || saved.height !== 1000) failures.push(`not saved again: ${JSON.stringify(saved)}`)

  await writeFile(stateFile, JSON.stringify({ ...saved, maximized: true }))
  instance = await launchApp({ app }, userData)
  const third = await size(instance)
  console.log('saved maximized →', third)
  if (third.width < third.screenWidth) failures.push(`not maximized: ${third.width} of ${third.screenWidth}`)
  await quitApp(instance)
  const savedMaximized = JSON.parse(await readFile(stateFile, 'utf8'))
  console.log('saved on quit', savedMaximized)
  if (!savedMaximized.maximized || savedMaximized.width !== 1700) failures.push(`maximized state not kept: ${JSON.stringify(savedMaximized)}`)
} finally {
  await removeTemporaryTree(userData)
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1) }
console.log('window size kept')
