// The page service against a stand-in for purchases-js: `bun test Web/test`.
import { expect, test } from "bun:test";

const calls = [];
let checkout = null;
const offering = {
  identifier: "default",
  availablePackages: [{
    identifier: "$rc_monthly",
    packageType: "$rc_monthly",
    webBillingProduct: {
      identifier: "noveloplus.premium.monthly",
      title: "Premium",
      description: null,
      currentPrice: { amount: 19.9, amountMicros: 19900000, currency: "BRL", formattedPrice: "R$ 19,90" },
    },
  }],
};
const info = (user) => ({
  originalAppUserId: user,
  entitlements: { active: { premium: {} } },
  activeSubscriptions: new Set(["noveloplus.premium.monthly"]),
  allPurchaseDatesByProduct: { "noveloplus.premium.monthly": new Date(0) },
});

class StandIn {
  constructor(user) { this.user = user; }
  static configure({ apiKey, appUserId }) { calls.push(["configure", apiKey, appUserId]); return new StandIn(appUserId); }
  static generateRevenueCatAnonymousAppUserId() { return "$RCAnonymousID:0123"; }
  getAppUserId() { return this.user; }
  close() { calls.push(["close", this.user]); }
  async changeUser(id) { calls.push(["changeUser", id]); this.user = id; return info(id); }
  async getOfferings() { return { current: offering, all: { default: offering } }; }
  purchase(params) {
    calls.push(["purchase", this.user, params.rcPackage.identifier, params.selectedLocale]);
    return new Promise((resolve, reject) => { checkout = { resolve: () => resolve({ customerInfo: info(this.user) }), reject }; });
  }
  async getCustomerInfo() { return info(this.user); }
}
// The page has not loaded purchases-js: the service adds its script on the first configure.
const added = [];
Object.defineProperty(globalThis, "navigator", { value: { language: "pt-BR" }, configurable: true });
globalThis.document = {
  documentElement: { lang: "en" },
  createElement: () => ({}),
  head: { appendChild(script) {
    added.push(script.src);
    globalThis.Purchases = { Purchases: StandIn, ErrorCode: { UserCancelledError: 1 } };
    script.onload();
  } },
};
globalThis.SwiftUIWebServices = { queue: [], define(name, factory) { this.queue.push([name, factory]); } };
await import("../Resources/skip-revenue.js");
const [name, factory] = SwiftUIWebServices.queue[0];
const service = factory({ emit() {} });
const answer = async (method, payload) => JSON.parse(await service[method](payload === undefined ? "" : JSON.stringify(payload)));

test("registers the skip-revenue service, and every call before configure names notConfigured", async () => {
  expect(name).toBe("skip-revenue");
  expect(await answer("customerInfo")).toEqual({ error: "notConfigured", message: "RevenueCat is not configured" });
});

test("configures the account, lists the current offering's packages and buys one in the page's language", async () => {
  expect(await answer("configure", { apiKey: "rcb_public", appUserId: "user-1" })).toEqual({ appUserId: "user-1" });
  expect(added).toEqual(["./purchases.js"]);
  const { packages } = await answer("products", {});
  expect(packages).toEqual([{
    identifier: "$rc_monthly",
    offeringIdentifier: "default",
    packageType: "$rc_monthly",
    product: { identifier: "noveloplus.premium.monthly", title: "Premium", description: "", priceString: "R$ 19,90", price: 19.9, currency: "BRL" },
  }]);
  const bought = answer("purchase", { offeringIdentifier: "default", packageIdentifier: "$rc_monthly" });
  await Bun.sleep(0);
  checkout.resolve();
  expect((await bought).customerInfo).toEqual({
    originalAppUserId: "user-1",
    activeEntitlements: ["premium"],
    activeSubscriptions: ["noveloplus.premium.monthly"],
    allPurchasedProductIdentifiers: ["noveloplus.premium.monthly"],
  });
  expect(calls).toContainEqual(["purchase", "user-1", "$rc_monthly", "pt-BR"]);
});

test("a closed checkout is userCancelled; an unknown package is packageNotFound", async () => {
  const bought = answer("purchase", { offeringIdentifier: "default", packageIdentifier: "$rc_monthly" });
  await Bun.sleep(0);
  checkout.reject(Object.assign(new Error("closed"), { errorCode: 1 }));
  expect((await bought).error).toBe("userCancelled");
  expect((await answer("purchase", { offeringIdentifier: "default", packageIdentifier: "$rc_annual" })).error).toBe("packageNotFound");
});

test("a change of user waits for the open checkout, and drops the packages loaded for the previous user", async () => {
  await answer("products", {});
  const bought = answer("purchase", { offeringIdentifier: "default", packageIdentifier: "$rc_monthly" });
  const loggedOut = answer("logout");
  await Bun.sleep(0);
  expect(calls.at(-1)[0]).toBe("purchase");
  checkout.resolve();
  expect((await bought).customerInfo.originalAppUserId).toBe("user-1");
  expect(await loggedOut).toEqual({ appUserId: "$RCAnonymousID:0123" });
  expect((await answer("purchase", { offeringIdentifier: "default", packageIdentifier: "$rc_monthly" })).error).toBe("packageNotFound");
});
