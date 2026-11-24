// SkipRevenue for the browser (SwiftUIWeb, https://github.com/Vitorsilveira31/SwiftUIWeb): RevenueCat Web Billing.
// The public API is the one of Sources/SkipRevenue, minus what has no browser counterpart (Web/README.md lists it).
// Swift calls `BrowserService("skip-revenue")`; Web/Resources/skip-revenue.js drives RevenueCat's purchases-js SDK
// (`globalThis.Purchases`, which the page loads), whose checkout takes the payment through Stripe.
import SwiftUIWebBrowserIO
import WebFoundation

// MARK: - Enums (the same cases and raw values as the native target)

public enum RCFusePackageType: Int, Comparable {
    case monthly = 0
    case annual = 1
    case lifetime = 2
    case weekly = 3
    case twoMonth = 4
    case threeMonth = 5
    case sixMonth = 6
    case custom = 7
    case unknown = 8

    public static func < (lhs: RCFusePackageType, rhs: RCFusePackageType) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    /// purchases-js names package types by their RevenueCat identifiers (`$rc_monthly`, …).
    init(webIdentifier: String) {
        switch webIdentifier {
        case "$rc_monthly": self = .monthly
        case "$rc_annual": self = .annual
        case "$rc_lifetime": self = .lifetime
        case "$rc_weekly": self = .weekly
        case "$rc_two_month": self = .twoMonth
        case "$rc_three_month": self = .threeMonth
        case "$rc_six_month": self = .sixMonth
        case "custom": self = .custom
        default: self = .unknown
        }
    }
}

public enum RCFuseStore: Int, Sendable {
    case appStore = 0
    case macAppStore = 1
    case playStore = 2
    case stripe = 3
    case promotional = 4
    case unknownStore = 5
    case amazon = 6
    case rcBilling = 7
    case externalStore = 8
}

public enum StoreError: Error {
    case userCancelled
    case unknown
    case noPurchasesFound
    case noProductsAvailable
    case packageNotFound
    case notConfigured

    /// The `error` kinds Web/Resources/skip-revenue.js answers with.
    init(webKind: String) {
        switch webKind {
        case "userCancelled": self = .userCancelled
        case "noProductsAvailable": self = .noProductsAvailable
        case "packageNotFound": self = .packageNotFound
        case "notConfigured": self = .notConfigured
        default: self = .unknown
        }
    }
}

// MARK: - Models (read from the page service's JSON answers)

public final class RCFuseStoreProduct: @unchecked Sendable {
    public let productIdentifier: String
    public let localizedTitle: String
    public let localizedDescription: String
    /// The price as purchases-js formats it for the checkout's locale.
    public let localizedPriceString: String
    public let price: Double
    public let currencyCode: String?

    init(_ json: [String: Any]) {
        productIdentifier = json["identifier"] as? String ?? ""
        localizedTitle = json["title"] as? String ?? ""
        localizedDescription = json["description"] as? String ?? ""
        localizedPriceString = json["priceString"] as? String ?? ""
        price = WebJSON.double(json["price"])
        currencyCode = json["currency"] as? String
    }
}

public final class RCFusePackage: @unchecked Sendable {
    public let identifier: String
    public let offeringIdentifier: String
    public let packageType: RCFusePackageType
    public let storeProduct: RCFuseStoreProduct

    public var localizedPriceString: String { storeProduct.localizedPriceString }

    init(_ json: [String: Any]) {
        identifier = json["identifier"] as? String ?? ""
        offeringIdentifier = json["offeringIdentifier"] as? String ?? ""
        packageType = RCFusePackageType(webIdentifier: json["packageType"] as? String ?? "")
        storeProduct = RCFuseStoreProduct(json["product"] as? [String: Any] ?? [:])
    }
}

public final class RCFuseCustomerInfo: @unchecked Sendable {
    public let originalAppUserId: String
    public let activeEntitlements: Set<String>
    public let allPurchasedProductIdentifiers: Set<String>
    public let activeSubscriptions: Set<String>

    public var hasActiveEntitlements: Bool { !activeEntitlements.isEmpty }

    public func isEntitlementActive(_ identifier: String) -> Bool { activeEntitlements.contains(identifier) }

    init(_ json: [String: Any]) {
        originalAppUserId = json["originalAppUserId"] as? String ?? ""
        activeEntitlements = WebJSON.strings(json["activeEntitlements"])
        allPurchasedProductIdentifiers = WebJSON.strings(json["allPurchasedProductIdentifiers"])
        activeSubscriptions = WebJSON.strings(json["activeSubscriptions"])
    }
}

// MARK: - RevenueCatFuse

/// The facade the native target offers, on RevenueCat Web Billing. Browser specifics: `configure` returns at once and
/// the page service configures purchases-js before any later call runs (calls run in order); `logoutUser` switches to
/// a new anonymous id, as the native SDKs do; there is no store to restore from, so `restorePurchases` and
/// `syncPurchases` re-read the customer (web purchases belong to the app user id); `purchase(package:)` shows
/// RevenueCat's checkout over the page and returns when it closes.
public struct RevenueCatFuse: @unchecked Sendable {
    public static let shared = RevenueCatFuse()

    private static let service = BrowserService("skip-revenue")
    private static let state = WebState()

    public func configure(apiKey: String) {
        start(apiKey: apiKey, appUserID: nil)
    }

    public func configure(apiKey: String, appUserID: String) {
        start(apiKey: apiKey, appUserID: appUserID)
    }

    public func loginUser(userId: String) async throws {
        _ = try await Self.invoke("changeUser", JSON.object([JSONField("appUserId", userId)]))
        Self.state.appUserID = userId
        Self.state.anonymous = false
    }

    public func logoutUser() async throws {
        let reply = try await Self.invoke("logout")
        Self.state.appUserID = reply["appUserId"] as? String ?? ""
        Self.state.anonymous = true
    }

    public var isConfigured: Bool { Self.state.configured }

    public var appUserID: String { Self.state.appUserID }

    public var isAnonymous: Bool { Self.state.anonymous }

    /// The packages of the offering (the current one when `offeringIdentifier` is nil).
    public func loadProducts(offeringIdentifier: String? = nil) async throws -> [RCFusePackage] {
        var fields: [JSONField] = []
        if let offeringIdentifier { fields.append(JSONField("offeringIdentifier", offeringIdentifier)) }
        let reply = try await Self.invoke("products", JSON.object(fields))
        let packages = WebJSON.objects(reply["packages"]).map(RCFusePackage.init)
        if packages.isEmpty { throw StoreError.noProductsAvailable }
        return packages
    }

    public func purchase(package: RCFusePackage) async throws -> RCFuseCustomerInfo {
        let reply = try await Self.invoke("purchase", JSON.object([
            JSONField("offeringIdentifier", package.offeringIdentifier),
            JSONField("packageIdentifier", package.identifier),
        ]))
        return RCFuseCustomerInfo(reply["customerInfo"] as? [String: Any] ?? [:])
    }

    public func restorePurchases() async throws -> RCFuseCustomerInfo {
        try await getCustomerInfo()
    }

    public func syncPurchases() async throws -> RCFuseCustomerInfo {
        try await getCustomerInfo()
    }

    public func getCustomerInfo() async throws -> RCFuseCustomerInfo {
        let reply = try await Self.invoke("customerInfo")
        return RCFuseCustomerInfo(reply["customerInfo"] as? [String: Any] ?? [:])
    }

    public func setAttributes(_ attributes: [String: String]) {
        guard Self.state.configured else { return }
        Self.service.send("setAttributes", JSON.object(attributes.sorted { $0.key < $1.key }.map { JSONField($0.key, $0.value) }))
    }

    public func setEmail(_ email: String) {
        setAttributes(["$email": email])
    }

    public func setDisplayName(_ displayName: String) {
        setAttributes(["$displayName": displayName])
    }

    private func start(apiKey: String, appUserID: String?) {
        Self.state.configured = true
        Self.state.appUserID = appUserID ?? ""
        Self.state.anonymous = appUserID == nil
        var fields = [JSONField("apiKey", apiKey)]
        if let appUserID { fields.append(JSONField("appUserId", appUserID)) }
        Self.state.failure = nil
        _ = Self.service.call("configure", JSON.object(fields)) { result in
            // An anonymous configuration learns the id purchases-js generated; a failed one is remembered, so later
            // calls report why (purchases-js did not load, the key was refused) rather than a missing configure.
            guard case .success(let text) = result, let reply = WebJSON.object(text) else {
                Self.failConfiguration(.unknown)
                return
            }
            if let kind = reply["error"] as? String {
                Self.failConfiguration(StoreError(webKind: kind))
            } else if let id = reply["appUserId"] as? String {
                Self.state.appUserID = id
            }
        }
    }

    private static func failConfiguration(_ error: StoreError) {
        state.configured = false
        state.appUserID = ""
        state.anonymous = true
        state.failure = error
    }

    /// Calls the page service and returns its answer, or throws the `StoreError` it names.
    private static func invoke(_ method: String, _ payload: String = "{}") async throws -> [String: Any] {
        guard state.configured else { throw state.failure ?? StoreError.notConfigured }
        let text: String
        do {
            text = try await service.call(method, payload)
        } catch {
            throw StoreError.unknown
        }
        guard let reply = WebJSON.object(text) else { throw StoreError.unknown }
        if let kind = reply["error"] as? String { throw StoreError(webKind: kind) }
        return reply
    }
}

/// What the synchronous members answer between calls (the page service answers asynchronously).
private final class WebState: @unchecked Sendable {
    var configured = false
    var appUserID = ""
    var anonymous = true
    /// Why the last configuration failed (nil when none did).
    var failure: StoreError?
}

/// Reading the page service's answers: JSON values as WebFoundation's JSONSerialization returns them.
enum WebJSON {
    static func object(_ text: String) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
    }

    static func objects(_ value: Any?) -> [[String: Any]] {
        (value as? [Any] ?? []).compactMap { $0 as? [String: Any] }
    }

    static func strings(_ value: Any?) -> Set<String> {
        Set((value as? [Any] ?? []).compactMap { $0 as? String })
    }

    /// An integral JSON number reads as `Int` in the browser build, any other as `Double`.
    static func double(_ value: Any?) -> Double {
        if let value = value as? Double { return value }
        if let value = value as? Int { return Double(value) }
        return 0
    }
}
