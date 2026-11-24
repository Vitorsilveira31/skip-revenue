# SkipRevenue in the browser

With SwiftUIWeb's Embedded build (`SWIFTUIWEB_EMBEDDED`), `import SkipRevenue` resolves to `Sources/SkipRevenueWeb`:
`RevenueCatFuse` and its models on [RevenueCat Web Billing](https://www.revenuecat.com/docs/web/web-billing/overview),
whose checkout takes the payment through Stripe. Swift calls the page service in `Resources/skip-revenue.js`, which
drives RevenueCat's purchases-js SDK (`globalThis.Purchases`).

An application:

1. Copies purchases-js' UMD bundle (`dist/Purchases.umd.js` of `@revenuecat/purchases-js`, version pinned) as
   `purchases.js` and `Resources/skip-revenue.js` into its own `Web/Resources`, so `script-src 'self'` allows them.
2. Loads `skip-revenue.js` from `head.html`, deferred, before the app starts:

   ```html
   <script defer src="./skip-revenue.js"></script>
   ```

   purchases-js (about 1 MB) is not loaded with the page: the service adds its script the first time RevenueCat is
   configured. Set `SkipRevenueWeb.sdkURL` before that to load it from another path; a page that loads purchases-js
   itself (`globalThis.Purchases`) is used as it is.

3. Allows Stripe and RevenueCat in its Content-Security-Policy when it restricts them: the checkout loads Stripe.js
   (`script-src https://js.stripe.com`, `frame-src https://js.stripe.com https://hooks.stripe.com`) and calls
   `https://api.revenuecat.com` and `https://api.stripe.com` (`connect-src`).
4. Configures with the Web Billing app's public API key (`rcb_…`, from RevenueCat's dashboard) and the app user id:
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
