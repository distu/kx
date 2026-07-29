import Foundation

// Contratos espelhando o JSON do daemon kxd (docs/cockpit/04-daemon-http-api.md).

struct Counts: Decodable, Hashable {
    var active: Int
    var blocked: Int
    var pending: Int
    var done: Int
    var total: Int
}

struct ProjectSummary: Decodable, Identifiable, Hashable {
    var id: String
    var name: String
    var color: String
    var order: Int
    var counts: Counts?
    var runningSessions: Int?
    var degraded: String?
}

struct Activity: Decodable, Identifiable, Hashable {
    var id: Int
    var slug: String
    var titulo: String
    var status: String
    var squad: String
    var updated: String
    var lastLog: String
}

struct ActivitiesResponse: Decodable {
    var project: String
    var total: Int
    var count: Int
    var activities: [Activity]
}

struct LinkedActivity: Decodable, Hashable {
    var slug: String
    var id: Int
    var titulo: String
    var status: String
}

struct SessionItem: Decodable, Identifiable, Hashable {
    var sessionId: String
    var title: String
    var firstPrompt: String
    var startedAt: Double
    var lastActivityAt: Double
    var state: String
    var resumeCommand: String
    var inMegabrain: Bool
    var highlight: Bool
    var linkedActivity: LinkedActivity?

    var id: String { sessionId }
}

struct SessionsResponse: Decodable {
    var project: String
    var total: Int
    var count: Int
    var running: Int
    var idle: Int
    var orphans: Int
    var highlighted: Int
    var sessions: [SessionItem]
}
