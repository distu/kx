import SwiftUI
import AppKit

@main
struct EntryPoint {
    static func main() {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--render"), i + 1 < args.count {
            MainActor.assumeIsolated {
                AppConfig.renderMode = true
                RenderMode.run(path: args[i + 1])
            }
        } else {
            CockpitApp.main()
        }
    }
}

// App de menu bar (uso normal).
struct CockpitApp: App {
    @StateObject private var store = CockpitStore()
    var body: some Scene {
        MenuBarExtra {
            CockpitPanel()
                .environmentObject(store)
                .frame(height: 640)
                .task {
                    await store.loadProjects()
                    await store.refresh()
                }
        } label: {
            Image(systemName: "square.stack.3d.up.fill")
        }
        .menuBarExtraStyle(.window)
    }
}

// Modo de captura: busca dados reais do daemon e rende o painel para um PNG (prova visual).
@MainActor
enum RenderMode {
    static var done = false
    static func run(path: String) {
        let store = CockpitStore()
        Task {
            await store.loadProjects()
            await store.refresh()
            RenderMode.done = true
        }
        let deadline = Date().addingTimeInterval(20)
        while !RenderMode.done && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        let view = CockpitPanel().environmentObject(store).frame(width: 404).fixedSize(horizontal: false, vertical: true)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        if let img = renderer.nsImage,
           let tiff = img.tiffRepresentation,
           let rep = NSBitmapImageRep(data: tiff),
           let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: path))
            FileHandle.standardError.write(Data("[render] PNG salvo: \(path)\n".utf8))
        } else {
            FileHandle.standardError.write(Data("[render] falhou\n".utf8))
        }
        exit(0)
    }
}
