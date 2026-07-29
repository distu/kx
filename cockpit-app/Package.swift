// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "KxCockpit",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "KxCockpit",
            path: "Sources/KxCockpit"
        )
    ]
)
