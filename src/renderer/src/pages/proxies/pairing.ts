export interface PairingOptions {
  /** Start again from the first proxy when there are more windows than proxies. */
  cycle: boolean
  /** Also give a new proxy to windows that already have one. */
  overwrite: boolean
}

/** Gives the chosen proxies to the chosen windows one by one, in list order. */
export function pairProxies(
  proxyIds: string[],
  windows: Array<{ id: string; proxyId: string }>,
  options: PairingOptions
): Array<{ windowId: string; proxyId: string }> {
  if (!proxyIds.length) return []
  const targets = options.overwrite ? windows : windows.filter((window) => !window.proxyId)
  const count = options.cycle ? targets.length : Math.min(targets.length, proxyIds.length)
  return targets.slice(0, count).map((window, index) => ({ windowId: window.id, proxyId: proxyIds[index % proxyIds.length] }))
}

/** Turns pairs into one assignment per proxy, so each goes through the single assign call. */
export function groupPairs(pairs: Array<{ windowId: string; proxyId: string }>): Map<string, string[]> {
  const byProxy = new Map<string, string[]>()
  for (const pair of pairs) byProxy.set(pair.proxyId, [...(byProxy.get(pair.proxyId) ?? []), pair.windowId])
  return byProxy
}
