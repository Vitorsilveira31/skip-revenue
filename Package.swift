// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "skip-revenue",
    defaultLocalization: "en",
    platforms: [.iOS(.v16), .macOS(.v13), .macCatalyst(.v16)],
    products: [
        .library(name: "SkipRevenueUI", targets: ["SkipRevenueUI"]),
        .library(name: "SkipRevenue", targets: ["SkipRevenue"]),
    ],
    dependencies: [
        .package(url: "https://github.com/skiptools/skip.git", from: "1.6.36"),
        .package(url: "https://github.com/skiptools/skip-ui.git", from: "1.0.0"),
        .package(url: "https://github.com/skiptools/skip-foundation.git", from: "1.0.0"),
        .package(url: "https://github.com/RevenueCat/purchases-ios.git", from: "5.0.0")
    ],
    targets: [
        .target(name: "SkipRevenue", dependencies: [
            .product(name: "SkipFoundation", package: "skip-foundation"),
            .product(name: "RevenueCat", package: "purchases-ios", condition: .when(platforms: [.iOS, .macOS, .macCatalyst]))
        ], resources: [.process("Resources")], plugins: [.plugin(name: "skipstone", package: "skip")]),
        .testTarget(name: "SkipRevenueTests", dependencies: [
            "SkipRevenue",
            .product(name: "SkipTest", package: "skip")
        ], resources: [.process("Resources")], plugins: [.plugin(name: "skipstone", package: "skip")]),
        .target(name: "SkipRevenueUI", dependencies: [
            "SkipRevenue",
            .product(name: "SkipUI", package: "skip-ui"),
            .product(name: "RevenueCatUI", package: "purchases-ios", condition: .when(platforms: [.iOS, .macOS, .macCatalyst]))
        ], plugins: [.plugin(name: "skipstone", package: "skip")]),
        .testTarget(name: "SkipRevenueUITests", dependencies: [
            "SkipRevenueUI",
            .product(name: "SkipTest", package: "skip")
        ], resources: [.process("Resources")], plugins: [.plugin(name: "skipstone", package: "skip")]),
    ]
)

// The browser build of SwiftUIWeb (https://github.com/Vitorsilveira31/SwiftUIWeb) sets SWIFTUIWEB_EMBEDDED. There the
// same `SkipRevenue` product is a web implementation (Sources/SkipRevenueWeb) on RevenueCat Web Billing: it drives
// RevenueCat's purchases-js SDK (Stripe checkout) through a SwiftUIWeb page service (Web/Resources/skip-revenue.js), so
// code that imports SkipRevenue builds for iOS, Android and the web. SkipRevenueUI (the native paywalls) has no web
// counterpart.
let webBuild = Context.environment["SWIFTUIWEB_EMBEDDED"] != nil
if webBuild {
    package.platforms = nil
    package.products = [.library(name: "SkipRevenue", targets: ["SkipRevenue"])]
    package.dependencies = [.package(url: "https://github.com/Vitorsilveira31/SwiftUIWeb.git", from: "0.1.40")]
    package.targets = [
        .target(name: "SkipRevenue", dependencies: [
            .product(name: "SwiftUIWebBrowserIO", package: "swiftuiweb"),
            .product(name: "WebFoundation", package: "swiftuiweb"),
        ], path: "Sources/SkipRevenueWeb"),
    ]
}

// SKIP_DYNAMIC_LIBRARIES and SKIP_BRIDGE both enforce building as dynamic
// libraries; SKIP_BRIDGE additionally puts the skipstone plugin in bridge mode
let bridgeMode = !webBuild && (Context.environment["SKIP_BRIDGE"] ?? "0") != "0"
let forceDylib = bridgeMode || (!webBuild && (Context.environment["SKIP_DYNAMIC_LIBRARIES"] ?? "0") != "0")

if bridgeMode {
    // Match skip-firebase's bridge configuration: depend on skip-fuse (modern
    // bridge generator emits `BridgedFromKotlin` redeclarations for types
    // declared inside `#if !SKIP_BRIDGE`, which lets the entire impl live in
    // the gated branch — the alternative `skip-bridge` package emits
    // `BridgedToKotlin` extensions that need the type visible in the bridge
    // pass, which forces stub `fatalError` bodies that crash at runtime).
    // `SkipFuseUI` is still pulled in for `RCFusePaywallView` (`SkipRevenueUI`).
    package.dependencies += [
        .package(url: "https://github.com/skiptools/skip-fuse.git", "0.0.0"..<"2.0.0"),
        .package(url: "https://github.com/skiptools/skip-fuse-ui.git", from: "1.0.0")
    ]
    package.targets.forEach({ target in
        target.dependencies += [.product(name: "SkipFuse", package: "skip-fuse")]
        if target.name == "SkipRevenueUI" || target.name == "SkipRevenueUITests" {
            target.dependencies += [.product(name: "SkipFuseUI", package: "skip-fuse-ui")]
        }
    })
}

if forceDylib {
    // all library types must be dynamic to support bridging
    package.products = package.products.map({ product in
        guard let libraryProduct = product as? Product.Library else { return product }
        return .library(name: libraryProduct.name, type: .dynamic, targets: libraryProduct.targets)
    })
}
