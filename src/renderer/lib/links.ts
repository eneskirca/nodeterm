/** nodeterm mobile on the App Store (live since 1.0). Render it through `mobileStoreLinks()` —
 *  `mobileStore.guard.test.ts` refuses a direct import anywhere else. */
export const IOS_APP_STORE_URL = 'https://apps.apple.com/app/nodeterm/id6790581233'

/**
 * nodeterm mobile for Android on Google Play — the package id the Android app ships under
 * (1.0.0, published 2026-11). Render it through `mobileStoreLinks()`, which gates it on
 * `ANDROID_APP_PUBLISHED`.
 */
export const ANDROID_PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.nodeterm.android'

/** The ONE switch for every surface: `true` since the Play listing went public. Turning it off
 *  again (listing pulled) removes the Play link everywhere at once. */
export const ANDROID_APP_PUBLISHED: boolean = true

export interface MobileStoreLink {
  id: 'app-store' | 'google-play'
  /** Button / link text. */
  label: string
  /** How prose names the store ("Grab it from the App Store"). */
  prose: string
  url: string
}

/**
 * Where to get nodeterm mobile, in display order. One home so the welcome flow, Settings → Phone,
 * the quick-pair popover and the launch card can never drift apart — and so the Play link appears
 * everywhere on the same day.
 */
export function mobileStoreLinks(
  androidPublished: boolean = ANDROID_APP_PUBLISHED
): MobileStoreLink[] {
  const links: MobileStoreLink[] = [
    {
      id: 'app-store',
      label: 'Get it on the App Store',
      prose: 'the App Store',
      url: IOS_APP_STORE_URL
    }
  ]
  if (androidPublished) {
    links.push({
      id: 'google-play',
      label: 'Get it on Google Play',
      prose: 'Google Play',
      url: ANDROID_PLAY_STORE_URL
    })
  }
  return links
}

/** "the App Store or Google Play" (just "the App Store" while Android is unpublished). */
export function mobileStoreNames(androidPublished: boolean = ANDROID_APP_PUBLISHED): string {
  return mobileStoreLinks(androidPublished)
    .map((l) => l.prose)
    .join(' or ')
}

/**
 * Stripe's hosted billing page for desktop (Stripe checkout) Pro buyers: the buyer signs in with
 * their checkout email and gets their invoices, payment method and cancellation. App Store / Play
 * purchases are billed by the store and have nothing here.
 */
export const STRIPE_BILLING_PORTAL_URL = 'https://billing.stripe.com/p/login/9B65kFeraflH9ora4A7EQ00'
