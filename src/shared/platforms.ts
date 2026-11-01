/**
 * One marketplace's seller site of a platform that has one per region; `region` is its country
 * code, or EU for Amazon's site shared by the UK, Germany, France, Italy and Spain.
 */
export interface PlatformSite {
  region: string
  url: string
}

/**
 * Amazon Seller Central by store, as Amazon's SP-API documentation lists them
 * (developer-docs.amazon.com/sp-api/docs/seller-central-urls): the UK, Germany, France, Italy and
 * Spain share one Europe site (EU).
 */
const AMAZON_SITES: readonly PlatformSite[] = [
  { region: 'US', url: 'https://sellercentral.amazon.com/' },
  { region: 'CA', url: 'https://sellercentral.amazon.ca/' },
  { region: 'MX', url: 'https://sellercentral.amazon.com.mx/' },
  { region: 'BR', url: 'https://sellercentral.amazon.com.br/' },
  { region: 'EU', url: 'https://sellercentral-europe.amazon.com/' },
  { region: 'IE', url: 'https://sellercentral.amazon.ie/' },
  { region: 'NL', url: 'https://sellercentral.amazon.nl/' },
  { region: 'BE', url: 'https://sellercentral.amazon.com.be/' },
  { region: 'SE', url: 'https://sellercentral.amazon.se/' },
  { region: 'PL', url: 'https://sellercentral.amazon.pl/' },
  { region: 'TR', url: 'https://sellercentral.amazon.com.tr/' },
  { region: 'AE', url: 'https://sellercentral.amazon.ae/' },
  { region: 'SA', url: 'https://sellercentral.amazon.sa/' },
  { region: 'EG', url: 'https://sellercentral.amazon.eg/' },
  { region: 'ZA', url: 'https://sellercentral.amazon.co.za/' },
  { region: 'IN', url: 'https://sellercentral.amazon.in/' },
  { region: 'JP', url: 'https://sellercentral.amazon.co.jp/' },
  { region: 'SG', url: 'https://sellercentral.amazon.sg/' },
  { region: 'AU', url: 'https://sellercentral.amazon.com.au/' }
]

/**
 * TikTok Shop Seller Center by market: the US one (seller-us.tiktok.com, TikTok's own sign-up and
 * help pages are on it) and those TikTok's global selling page (seller.tiktokglobalshop.com) links to.
 */
const TIKTOK_SHOP_SITES: readonly PlatformSite[] = [
  ['US', 'us'], ['GB', 'uk'], ['DE', 'de'], ['FR', 'fr'], ['IT', 'it'], ['ES', 'es'], ['IE', 'ie'], ['NL', 'nl'],
  ['BE', 'be'], ['AT', 'at'], ['PL', 'pl'], ['PT', 'pt'], ['CZ', 'cz'], ['HU', 'hu'], ['GR', 'gr'], ['MX', 'mx'],
  ['BR', 'br'], ['JP', 'jp'], ['ID', 'id'], ['MY', 'my'], ['PH', 'ph'], ['SG', 'sg'], ['TH', 'th'], ['VN', 'vn'], ['SA', 'sa']
].map(([region, host]) => ({ region, url: `https://seller-${host}.tiktok.com/` }))

/** Platforms offered for a window's account; picking one fills the start URL (its first site, when it has several). */
export const PLATFORMS: ReadonlyArray<{ value: string; url: string; sites?: readonly PlatformSite[] }> = [
  { value: 'TikTok Shop', url: 'https://seller-us.tiktok.com/', sites: TIKTOK_SHOP_SITES },
  { value: 'TikTok', url: 'https://www.tiktok.com/login' },
  { value: 'Facebook', url: 'https://www.facebook.com/' },
  { value: 'Meta Business', url: 'https://business.facebook.com/' },
  { value: 'Google Ads', url: 'https://ads.google.com/' },
  { value: 'Shopify', url: 'https://accounts.shopify.com/' },
  { value: 'Amazon Seller', url: 'https://sellercentral.amazon.com/', sites: AMAZON_SITES }
]

/** Start URL for a known platform name (case-insensitive), or undefined. */
export function platformStartUrl(platform: string): string | undefined {
  const name = platform.trim().toLowerCase()
  return name ? PLATFORMS.find((item) => item.value.toLowerCase() === name)?.url : undefined
}

/** Every address a platform fills in by itself: replacing one of these replaces nothing the user typed. */
export const PLATFORM_URLS: ReadonlySet<string> = new Set(PLATFORMS.flatMap((item) => [item.url, ...(item.sites ?? []).map((site) => site.url)]))
