// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "HoustonVM",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/httpswift/swifter.git", .upToNextMajor(from: "1.5.0")),
    ],
    targets: [
        .executableTarget(
            name: "HoustonVM",
            dependencies: [.product(name: "Swifter", package: "swifter")],
            path: "Sources/HoustonVM",
            resources: [.copy("Resources")],
            swiftSettings: [
                .unsafeFlags(["-parse-as-library"]),
            ],
            linkerSettings: [
                .linkedFramework("Virtualization"),
                .linkedFramework("AppKit"),
                .linkedFramework("Foundation"),
                .linkedFramework("Network"),
                .linkedFramework("IOSurface"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("ImageIO"),
            ]
        ),
    ]
)
