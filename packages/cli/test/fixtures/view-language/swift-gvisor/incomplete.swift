// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "cfc-sandbox",
    platforms: [
        .macOS(.v15),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/containerization.git", from: "0.1.0"),
        .package(url: "https://github.com/apple/swift-argument-parser.git
    ],
    targets: [
        .executableTarget(
            name: "cfc-sandbox",
            dependencies: [
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ],
            path: "Sources/CFCSandbox"
