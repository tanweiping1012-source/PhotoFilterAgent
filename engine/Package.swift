// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "photofilter",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "photofilter"),
        .testTarget(name: "PhotoEngineTests", dependencies: ["photofilter"]),
    ]
)
