import SwiftUI
import AppKit

enum AppConfig {
    // Em modo --render (geracao de PNG) evitamos vibrancy para o offscreen sair legivel.
    @MainActor static var renderMode = false
}

@MainActor
final class CockpitStore: ObservableObject {
    @Published var projects: [ProjectSummary] = []
    @Published var selected: String = ""
    @Published var activities: [Activity] = []
    @Published var sessions: [SessionItem] = []
    @Published var sessionsInfo: SessionsResponse?
    @Published var statusFilter: String = "active"
    @Published var daemonOnline: Bool = true
    @Published var error: String?
    @Published var lastToast: String?

    private let client = DaemonClient()

    var current: ProjectSummary? { projects.first { $0.id == selected } }

    func loadProjects() async {
        do {
            daemonOnline = try await client.health()
            projects = try await client.projects().sorted { $0.order < $1.order }
            if selected.isEmpty, let first = projects.first { selected = first.id }
            error = nil
        } catch {
            daemonOnline = false
            self.error = "Daemon kxd offline (127.0.0.1:7717). Inicie com: kx daemon"
        }
    }

    func select(_ id: String) {
        selected = id
        Task { await refresh() }
    }

    func refresh() async {
        guard !selected.isEmpty else { return }
        do {
            async let acts = client.activities(selected, status: statusFilter)
            async let sess = client.sessions(selected)
            activities = try await acts.activities
            let s = try await sess
            sessionsInfo = s
            sessions = s.sessions
            error = nil
        } catch {
            self.error = "Falha ao carregar '\(selected)': \(error.localizedDescription)"
        }
    }

    func setFilter(_ f: String) {
        statusFilter = f
        Task { await refresh() }
    }

    func promote(_ s: SessionItem) async {
        do {
            try await client.promote(selected, session: s.sessionId,
                                     titulo: s.title.isEmpty ? "Sessao \(s.sessionId.prefix(8))" : s.title,
                                     squad: "transversal")
            toast("Promovida ao KX activity manager: \(s.title)")
            await refresh()
        } catch {
            toast("Falha ao promover: \(error.localizedDescription)")
        }
    }

    func copyCommand(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        toast("Comando copiado")
    }

    // Foca/abre a sessao no Terminal.app (fallback universal; Warp/iTerm entram depois).
    func openInTerminal(_ command: String) {
        let escaped = command.replacingOccurrences(of: "\"", with: "\\\"")
        let src = "tell application \"Terminal\"\n do script \"\(escaped)\"\n activate\nend tell"
        if let script = NSAppleScript(source: src) {
            var err: NSDictionary?
            script.executeAndReturnError(&err)
            toast(err == nil ? "Abrindo no Terminal" : "Permissao de automacao necessaria")
        }
    }

    private func toast(_ msg: String) {
        lastToast = msg
    }
}
