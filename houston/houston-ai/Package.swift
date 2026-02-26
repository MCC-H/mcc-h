// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "HoustonAI",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/httpswift/swifter.git", .upToNextMajor(from: "1.5.0")),
    ],
    targets: [
        .executableTarget(
            name: "HoustonAI",
            dependencies: [.product(name: "Swifter", package: "swifter")],
            path: "Sources/HoustonAI",
            swiftSettings: [
                .unsafeFlags(["-parse-as-library"]),
            ],
            linkerSettings: [
                .linkedFramework("Foundation"),
                .linkedFramework("Vision"),
                .linkedFramework("CoreML"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("ImageIO"),
                .linkedFramework("UniformTypeIdentifiers"),
            ]
        ),
    ]
)
