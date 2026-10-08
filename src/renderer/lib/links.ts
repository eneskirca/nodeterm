import { REPO_URL } from './bugReport'

/** nodeterm mobile on the App Store (live since 1.0). Render it through `mobileStoreLinks()` —
 *  `mobileStore.guard.test.ts` refuses a direct import anywhere else. */
export const IOS_APP_STORE_URL = 'https://apps.apple.com/app/nodeterm/id6790581233'

/** nodeterm for Android: SOURCE, not an installable. There is no store listing and no published
 *  APK yet (the only APK is an expiring CI run artifact behind a GitHub login), so the link opens
 *  the repo's `android/` folder, whose README says how to build it. Both call sites label it
 *  "(build from source)" for that reason — it sits beside an App Store link, and without the label
 *  it reads as a download. Once a signed release APK is published, point this at that release
 *  asset and drop the label.
 *
 *  Derived from `REPO_URL` rather than spelled out, so the repository has one home. */
export const ANDROID_APP_URL = `${REPO_URL}/tree/main/android`

/** The visible label of that link, shared by Settings → Phone and the quick-pair popover so the
 *  two can never disagree about what it opens. */
export const ANDROID_APP_LABEL = 'nodeterm for Android (build from source)'

/**
 * nodeterm mobile for Android on Google Play. The listing DOES NOT EXIST YET — this is the package
 * id the Android app ships under. Nothing renders it until `ANDROID_APP_PUBLISHED` is true, so no
 * build ever ships a link to a 404.
 */
export const ANDROID_PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.nodeterm.android'

/** Flip to `true` the day the Play listing is public — the ONE switch for every surface. */
export const ANDROID_APP_PUBLISHED: boolean = false

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

/** "the App Store" today; "the App Store or Google Play" once Android is published. */
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
