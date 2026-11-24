# Vitorsilveira31/skip-revenue

A maintained fork of [skiptools/skip-revenue](https://github.com/skiptools/skip-revenue) (Apache-2.0, the upstream's
license and attributions are unchanged) used by Novelo+. It follows upstream and keeps its changes small and generic.

| | |
|---|---|
| Upstream | `https://github.com/skiptools/skip-revenue`, remote `upstream` |
| Based on | upstream `main` at `f67b487` (0.3.1) |
| RevenueCat iOS | `from: "5.0.0"` (resolves to the newest 5.x; 5.103.2 on 2026-11-23) |
| RevenueCat Android | `com.revenuecat.purchases:purchases` (and `-ui`, `-debug-view`) `11.4.3` (upstream pins 9.19.0) |

## Changes from upstream

- RevenueCat Android 9.19.0 → 11.4.3: Google Play Billing Library 9.1, Android API 23 minimum, compiled against API 35+
  with Kotlin 2.2. No source change was needed for the wrapped calls.

- A browser target (`SWIFTUIWEB_EMBEDDED`, Sources/SkipRevenueWeb, Web/): the same `SkipRevenue` product on RevenueCat
  Web Billing (Stripe checkout) through purchases-js and a SwiftUIWeb page service. Web/README.md has the setup and the
  differences.

## Testing

`xcodebuild test -scheme skip-revenue-Package -destination 'platform=macOS'` runs the macOS tests and, through
`XCSkipTests`, the same tests transpiled to Kotlin on Android (Robolectric). `swift test` does not build with Xcode 27's
SDK: SwiftPM does not apply StoreKit's SwiftUI cross-import overlay, so purchases-ios' `PaywallExtensions.swift` cannot
find `StoreView` on macOS. That is a toolchain/upstream issue, independent of this fork.

`cd Web && bun test` tests the browser page service against a stand-in for purchases-js. The Swift side builds in an
application's SwiftUIWeb browser build.

## Syncing with upstream

```bash
git fetch upstream --tags
git switch main && git merge upstream/main      # never force-push main
xcodebuild test -scheme skip-revenue-Package -destination 'platform=macOS'
```

## History

- 2026-11-23: forked at upstream `f67b487` (0.3.1); RevenueCat Android 11.4.3. Tests: 7 + 2 on macOS and the same 7 + 2
  transpiled on Android (Robolectric), all passing.
