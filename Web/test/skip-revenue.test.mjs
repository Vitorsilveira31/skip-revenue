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
      // As purchases-js gives it: amount in cents (deprecated), amountMicros in millionths.
      currentPrice: { amount: 1990, amountMicros: 19900000, currency: "BRL", formattedPrice: "R$ 19,90" },
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

test("a first script that ran without defining purchases-js is loaded again on the next configure", async () => {
  const appendChild = document.head.appendChild;
  document.head.appendChild = (script) => { added.push(script.src); script.onload(); };
  expect((await answer("configure", { apiKey: "rcb_public", appUserId: "user-1" })).error).toBe("unavailable");
  document.head.appendChild = appendChild;
  added.length = 0;
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

test("a refused configuration keeps the session in use, and a failed change of user keeps its packages", async () => {
  await answer("products", {});
  const configure = StandIn.configure;
  StandIn.configure = () => { throw new Error("Invalid API key"); };
  expect((await answer("configure", { apiKey: "bad", appUserId: "user-2" })).error).toBe("unknown");
  StandIn.configure = configure;
  expect((await answer("customerInfo")).customerInfo.originalAppUserId).toBe("user-1");
  const changeUser = StandIn.prototype.changeUser;
  StandIn.prototype.changeUser = async () => { throw new Error("network"); };
  expect((await answer("changeUser", { appUserId: "user-3" })).error).toBe("unknown");
  StandIn.prototype.changeUser = changeUser;
  const bought = answer("purchase", { offeringIdentifier: "default", packageIdentifier: "$rc_monthly" });
  await Bun.sleep(0);
  checkout.resolve();
  expect((await bought).customerInfo.originalAppUserId).toBe("user-1");
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


test("a Chinese browser gets the checkout's Chinese by script", async () => {
  await answer("configure", { apiKey: "rcb_public", appUserId: "user-5" });
  await answer("products", {});
  for (const [tag, expected] of [["zh-TW", "zh_Hant"], ["zh-CN", "zh_Hans"], ["zh-Hant-HK", "zh_Hant"]]) {
    Object.defineProperty(globalThis, "navigator", { value: { language: tag }, configurable: true });
    const bought = answer("purchase", { offeringIdentifier: "default", packageIdentifier: "$rc_monthly" });
    await Bun.sleep(0);
    checkout.resolve();
    await bought;
    expect(calls.at(-1)).toEqual(["purchase", "user-5", "$rc_monthly", expected]);
  }
  Object.defineProperty(globalThis, "navigator", { value: { language: "pt-BR" }, configurable: true });
});

test("a change of user that fails after the SDK switched names the identity in use and drops the packages", async () => {
  await answer("products", {});
  const changeUser = StandIn.prototype.changeUser;
  StandIn.prototype.changeUser = async function (id) { this.user = id; throw new Error("customer info failed"); };
  const failed = await answer("changeUser", { appUserId: "user-6" });
  StandIn.prototype.changeUser = changeUser;
  expect(failed.error).toBe("unknown");
  expect(failed.appUserId).toBe("user-6");
  expect((await answer("purchase", { offeringIdentifier: "default", packageIdentifier: "$rc_monthly" })).error).toBe("packageNotFound");
});
