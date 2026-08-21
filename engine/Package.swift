// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "photocurate",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "photocurate"),
        .testTarget(name: "PhotoEngineTests", dependencies: ["photocurate"]),
    ]
)
