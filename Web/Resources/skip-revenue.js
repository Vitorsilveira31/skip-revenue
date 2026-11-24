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
      script.onload = () => resolve(sdk());
      script.onerror = () => {
        loading = null;
        resolve(undefined);
      };
      document.head.appendChild(script);
    });
    return loading;
  };
  const parse = (payload) => (payload ? JSON.parse(payload) : {});
  const fail = (kind, message) => Object.assign(new Error(message), { kind });

  const failure = (error) => {
    const cancelled = error?.errorCode !== undefined && error.errorCode === sdk()?.ErrorCode?.UserCancelledError;
    const kind = error?.kind ?? (cancelled ? "userCancelled" : "unknown");
    return JSON.stringify({ error: kind, message: String(error?.message ?? error).slice(0, 300) });
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
        price: product.currentPrice?.amount ?? 0,
        currency: product.currentPrice?.currency ?? null,
      },
    };
  };

  // The checkout's language is the browser's, as an application's own strings are (SwiftUIWeb's page says lang="en"
  // whatever the reader's language); purchases-js reads the language part: pt-BR → pt.
  const locale = () => globalThis.navigator?.language || globalThis.document?.documentElement?.lang || "en";

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

      return {
        configure: (payload) => serial(async () => {
          const { apiKey, appUserId } = parse(payload);
          const Purchases = (await loadSDK())?.Purchases;
          if (!Purchases) throw fail("unavailable", "purchases-js could not be loaded");
          purchases?.close();
          purchases = null;
          packages.clear();
          purchases = Purchases.configure({ apiKey, appUserId: appUserId ?? anonymousID() });
          return { appUserId: purchases.getAppUserId() };
        }),

        changeUser: (payload) => serial(async () => {
          const { appUserId } = parse(payload);
          packages.clear();
          return { appUserId, customerInfo: customer(await configured().changeUser(appUserId)) };
        }),

        logout: () => serial(async () => {
          const appUserId = anonymousID();
          packages.clear();
          await configured().changeUser(appUserId);
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
