// SkipRevenue's page service for SwiftUIWeb (Sources/SkipRevenueWeb): RevenueCat Web Billing through RevenueCat's
// purchases-js SDK, whose checkout takes the payment through Stripe. purchases-js (its UMD bundle, about 1 MB) is
// loaded the first time RevenueCat is configured, from `SkipRevenueWeb.sdkURL` (default ./purchases.js, next to the
// page), unless the page already loaded it (`globalThis.Purchases`); see Web/README.md.
//
// Every method answers a JSON string, never a rejection: `{...}` on success, `{"error": kind, "message": …}` on
// failure, where kind is userCancelled, notConfigured, noProductsAvailable, packageNotFound, unavailable or unknown.
// Calls run one after another, in the order Swift sent them: `configure` is sent without waiting, a purchase uses the
// identity configured before it, and a change of user waits until an open checkout closes.
(() => {
  const sdk = () => globalThis.Purchases;
  globalThis.SkipRevenueWeb ??= { sdkURL: "./purchases.js" };

  let loading = null;
  const loadSDK = () => {
    if (sdk()?.Purchases) return Promise.resolve(sdk());
    const document = globalThis.document;
    if (!document?.createElement) return Promise.resolve(undefined);
    loading ??= new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = globalThis.SkipRevenueWeb.sdkURL ?? "./purchases.js";
      const done = () => {
        script.onload = script.onerror = null;
        resolve(sdk());
      };
      script.onload = done;
      script.onerror = done;
      document.head.appendChild(script);
    }).then((loaded) => {
      // A script that failed, or ran without defining purchases-js, is loaded again by the next configure.
      if (!loaded?.Purchases) loading = null;
      return loaded;
    });
    return loading;
  };
  const parse = (payload) => (payload ? JSON.parse(payload) : {});
  const fail = (kind, message) => Object.assign(new Error(message), { kind });

  const failure = (error) => {
    const cancelled = error?.errorCode !== undefined && error.errorCode === sdk()?.ErrorCode?.UserCancelledError;
    const kind = error?.kind ?? (cancelled ? "userCancelled" : "unknown");
    const answer = { error: kind, message: String(error?.message ?? error).slice(0, 300) };
    // A change of user can fail after purchases-js already switched identities: Swift learns which one is in use.
    if (typeof error?.appUserId === "string") answer.appUserId = error.appUserId;
    return JSON.stringify(answer);
  };

  const customer = (info) => ({
    originalAppUserId: info.originalAppUserId,
    activeEntitlements: Object.keys(info.entitlements?.active ?? {}),
    activeSubscriptions: [...(info.activeSubscriptions ?? [])],
    allPurchasedProductIdentifiers: Object.keys(info.allPurchaseDatesByProduct ?? {}),
  });

  const describe = (offering, rcPackage) => {
    const product = rcPackage.webBillingProduct ?? rcPackage.rcBillingProduct ?? rcPackage.product;
    return {
      identifier: rcPackage.identifier,
      offeringIdentifier: offering.identifier,
      packageType: rcPackage.packageType,
      product: {
        identifier: product.identifier,
        title: product.title ?? product.displayName ?? "",
        description: product.description ?? "",
        priceString: product.currentPrice?.formattedPrice ?? "",
        // amountMicros is the price in millionths of the currency (amount, deprecated, is in cents).
        price: (product.currentPrice?.amountMicros ?? 0) / 1_000_000,
        currency: product.currentPrice?.currency ?? null,
      },
    };
  };

  // The checkout's language is the browser's, as an application's own strings are (SwiftUIWeb's page says lang="en"
  // whatever the reader's language); purchases-js reads the language part (pt-BR → pt), but names its Chinese
  // dictionaries by script, so a Chinese tag is mapped to zh_Hans or zh_Hant.
  const locale = () => {
    const tag = globalThis.navigator?.language || globalThis.document?.documentElement?.lang || "en";
    if (!/^zh\b/i.test(tag)) return tag;
    return /hant|-(tw|hk|mo)\b/i.test(tag) ? "zh_Hant" : "zh_Hans";
  };

  (globalThis.SwiftUIWebServices ??= { queue: [], define(name, factory) { this.queue.push([name, factory]); } })
    .define("skip-revenue", () => {
      let purchases = null;
      let chain = Promise.resolve();
      const packages = new Map();

      const serial = (work) => {
        const answer = chain.then(work);
        chain = answer.catch(() => {});
        return answer.then((value) => JSON.stringify(value ?? {}), failure);
      };
      const configured = () => purchases ?? (() => { throw fail("notConfigured", "RevenueCat is not configured"); })();
      const anonymousID = () => sdk().Purchases.generateRevenueCatAnonymousAppUserId();
      // purchases-js switches the identity before it reads the new user's customer, so a failure can leave it on the new
      // user: the loaded packages go whenever the identity changed, and the failure names the identity in use.
      const switchUser = async (appUserId) => {
        const instance = configured();
        const before = instance.getAppUserId();
        try {
          const info = await instance.changeUser(appUserId);
          packages.clear();
          return info;
        } catch (error) {
          const now = instance.getAppUserId();
          if (now !== before) packages.clear();
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), { appUserId: now });
        }
      };

      return {
        configure: (payload) => serial(async () => {
          const { apiKey, appUserId } = parse(payload);
          const Purchases = (await loadSDK())?.Purchases;
          if (!Purchases) throw fail("unavailable", "purchases-js could not be loaded");
          // purchases-js checks the key and the user before it replaces its instance (and closes the previous one's
          // checkout itself): a refused configuration leaves the session in use as it was.
          const next = Purchases.configure({ apiKey, appUserId: appUserId ?? anonymousID() });
          purchases = next;
          packages.clear();
          return { appUserId: purchases.getAppUserId() };
        }),

        changeUser: (payload) => serial(async () => {
          const { appUserId } = parse(payload);
          const info = await switchUser(appUserId);
          return { appUserId, customerInfo: customer(info) };
        }),

        logout: () => serial(async () => {
          const appUserId = anonymousID();
          await switchUser(appUserId);
          return { appUserId };
        }),

        products: (payload) => serial(async () => {
          const { offeringIdentifier } = parse(payload);
          const offerings = await configured().getOfferings();
          const offering = offeringIdentifier ? offerings.all?.[offeringIdentifier] : offerings.current;
          if (!offering) throw fail("noProductsAvailable", "no such offering");
          for (const rcPackage of offering.availablePackages) packages.set(`${offering.identifier}/${rcPackage.identifier}`, rcPackage);
          return { packages: offering.availablePackages.map((rcPackage) => describe(offering, rcPackage)) };
        }),

        purchase: (payload) => serial(async () => {
          const { offeringIdentifier, packageIdentifier } = parse(payload);
          const rcPackage = packages.get(`${offeringIdentifier}/${packageIdentifier}`);
          if (!rcPackage) throw fail("packageNotFound", "load the products of the current user first");
          const result = await configured().purchase({ rcPackage, selectedLocale: locale() });
          return { customerInfo: customer(result.customerInfo) };
        }),

        customerInfo: () => serial(async () => ({ customerInfo: customer(await configured().getCustomerInfo()) })),

        setAttributes: (payload) => serial(async () => {
          await configured().setAttributes(parse(payload));
        }),
      };
    });
})();
