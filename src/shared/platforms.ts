/** Platforms offered for a window's account; picking one fills the start URL. */
export const PLATFORMS: ReadonlyArray<{ value: string; url: string }> = [
  { value: 'TikTok Shop', url: 'https://seller-us.tiktok.com/' },
  { value: 'TikTok', url: 'https://www.tiktok.com/login' },
  { value: 'Facebook', url: 'https://www.facebook.com/' },
  { value: 'Meta Business', url: 'https://business.facebook.com/' },
  { value: 'Google Ads', url: 'https://ads.google.com/' },
  { value: 'Shopify', url: 'https://accounts.shopify.com/' },
  { value: 'Amazon Seller', url: 'https://sellercentral.amazon.com/' }
]

/** Start URL for a known platform name (case-insensitive), or undefined. */
export function platformStartUrl(platform: string): string | undefined {
  const name = platform.trim().toLowerCase()
  return name ? PLATFORMS.find((item) => item.value.toLowerCase() === name)?.url : undefined
}
