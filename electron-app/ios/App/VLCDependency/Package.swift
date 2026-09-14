// swift-tools-version: 5.9
import PackageDescription

// The official VideoLAN binary is installed by scripts/setup-ios-vlc.mjs.
// Keep this outside CapApp-SPM, which Capacitor rewrites during sync.
let package = Package(
    name: "TorWatchVLC",
    platforms: [.iOS(.v15)],
    products: [.library(name: "TorWatchVLC", targets: ["MobileVLCKit", "VLCSupport"])],
    targets: [
        .binaryTarget(name: "MobileVLCKit", path: "MobileVLCKit.xcframework"),
        .target(name: "VLCSupport", path: "Sources", linkerSettings: [
            .linkedFramework("QuartzCore"), .linkedFramework("CoreText"),
            .linkedFramework("AVFoundation"), .linkedFramework("Security"),
            .linkedFramework("CFNetwork"), .linkedFramework("AudioToolbox"),
            .linkedFramework("OpenGLES"), .linkedFramework("CoreGraphics"),
            .linkedFramework("VideoToolbox"), .linkedFramework("CoreMedia"),
            .linkedLibrary("c++"), .linkedLibrary("xml2"), .linkedLibrary("z"),
            .linkedLibrary("bz2"), .linkedLibrary("iconv")
        ])
    ]
)
