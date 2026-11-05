// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "cfc-sandbox",
    platforms: [
        .macOS(.v15),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/containerization.git", from: "0.1.0"),
    ],
    targets: [
        .executableTarget(
            name: "cfc-sandbox",
            dependencies: [
                .product(name: "Containerization", package: "containerization"),
                .product(name: "ContainerizationOCI", package: "containerization"),
            ],
            path: "Sources/CFCSandbox"
        ),
    ]
)
