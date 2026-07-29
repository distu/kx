import Foundation

// Cliente HTTP do daemon local kxd. Todo dado de dominio vem daqui; o app nao le disco.
struct DaemonClient {
    var base = "http://127.0.0.1:7717"

    private var token: String? {
        ProcessInfo.processInfo.environment["KX_COCKPIT_TOKEN"]
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        guard let url = URL(string: base + path) else { throw URLError(.badURL) }
        var req = URLRequest(url: url)
        req.timeoutInterval = 15
        if let token { req.setValue(token, forHTTPHeaderField: "X-Cockpit-Token") }
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(T.self, from: data)
    }

    func health() async throws -> Bool {
        guard let url = URL(string: base + "/health") else { return false }
        var req = URLRequest(url: url)
        if let token { req.setValue(token, forHTTPHeaderField: "X-Cockpit-Token") }
        let (_, resp) = try await URLSession.shared.data(for: req)
        return (resp as? HTTPURLResponse)?.statusCode == 200
    }

    func projects() async throws -> [ProjectSummary] {
        try await get("/projects")
    }

    func activities(_ project: String, status: String) async throws -> ActivitiesResponse {
        let p = project.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? project
        return try await get("/projects/\(p)/activities?status=\(status)&sort=recent&limit=100")
    }

    func sessions(_ project: String) async throws -> SessionsResponse {
        let p = project.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? project
        return try await get("/projects/\(p)/sessions?limit=50")
    }

    func promote(_ project: String, session: String, titulo: String, squad: String) async throws {
        let p = project.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? project
        let s = session.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? session
        guard let url = URL(string: base + "/projects/\(p)/sessions/\(s)/promote") else { throw URLError(.badURL) }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue(token, forHTTPHeaderField: "X-Cockpit-Token") }
        req.httpBody = try JSONSerialization.data(withJSONObject: ["titulo": titulo, "squad": squad])
        _ = try await URLSession.shared.data(for: req)
    }
}
