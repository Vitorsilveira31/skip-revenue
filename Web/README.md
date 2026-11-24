# SkipRevenue in the browser

With SwiftUIWeb's Embedded build (`SWIFTUIWEB_EMBEDDED`), `import SkipRevenue` resolves to `Sources/SkipRevenueWeb`:
`RevenueCatFuse` and its models on [RevenueCat Web Billing](https://www.revenuecat.com/docs/web/web-billing/overview),
whose checkout takes the payment through Stripe. Swift calls the page service in `Resources/skip-revenue.js`, which
drives RevenueCat's purchases-js SDK (`globalThis.Purchases`).

The browser files ship with this package, in `Web/Resources/`: `skip-revenue.js`, purchases-js' UMD bundle
(`purchases.js`, `@revenuecat/purchases-js` 1.74.0, `dist/Purchases.umd.js` as published on npm, with its MIT license in
`purchases-js.LICENSE`) and `head.html`, which
loads `skip-revenue.js`, deferred. SwiftUIWeb's browser build copies a local package dependency's `Web/Resources/` into
the application's bundle and puts its `head.html` before the application's, so an application keeps no copies.
purchases-js (about 1 MB) is not loaded with the page: the service adds its script the first time RevenueCat is
configured. Set `SkipRevenueWeb.sdkURL` before that to load it from another path; a page that loads purchases-js itself
(`globalThis.Purchases`) is used as it is.

An application:

1. Depends on this package through a local path in its browser manifest (`.package(path: "../skip-revenue")`).
2. Allows Stripe and RevenueCat in its Content-Security-Policy when it declares its own (the page has one policy, the
   application's): the checkout loads Stripe.js
   (`script-src https://js.stripe.com`, `frame-src https://js.stripe.com https://hooks.stripe.com`) and calls
   `https://api.revenuecat.com` and `https://api.stripe.com` (`connect-src`). purchases-js also adds `<style>` elements
   for its checkout overlay, so the policy keeps `style-src 'unsafe-inline'`, as SwiftUIWeb's default policy does.
3. Configures with the Web Billing app's public API key (`rcb_…`, from RevenueCat's dashboard) and the app user id:
   `RevenueCatFuse.shared.configure(apiKey: key, appUserID: accountID)`.

The checkout follows the browser's language (`navigator.language`, then `<html lang>`); purchases-js ships Portuguese
among others.

Browser differences:

- `configure` returns at once; the page service configures purchases-js before any later call runs, and every call
  runs in the order Swift sent it. A change of user (`loginUser`, `logoutUser`) waits until an open checkout closes.
- `purchase(package:)` shows RevenueCat's checkout over the page and returns when it closes; closing it throws
  `StoreError.userCancelled`. The package must come from `loadProducts` for the same user.
- Web purchases belong to the app user id, so there is no store to restore from: `restorePurchases` and
  `syncPurchases` read the customer again.
- Not in the browser build: `SkipRevenueUI` (the native paywalls), offerings as objects (`loadOfferings`,
  `cachedOfferings`), `customerInfoStream`, cached customer info, the Android activity, trial eligibility, the proxy URL,
  expiration and purchase dates, and the price-per-month and period helpers. Code that uses them does not build for the
  web.

`cd Web && bun test` checks the page service against a stand-in for purchases-js (run it from `Web/`: from the package
root Bun also scans `.build`).
