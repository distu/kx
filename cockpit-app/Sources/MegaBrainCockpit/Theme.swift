import SwiftUI
import AppKit

extension Color {
    init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        let r, g, b: Double
        if s.count == 6 {
            r = Double((v & 0xFF0000) >> 16) / 255
            g = Double((v & 0x00FF00) >> 8) / 255
            b = Double(v & 0x0000FF) / 255
        } else {
            r = 0.4; g = 0.4; b = 0.9
        }
        self.init(.sRGB, red: r, green: g, blue: b, opacity: 1)
    }
}

enum Palette {
    static let base = Color(hex: "#0f1220")
    static let card = Color.white.opacity(0.05)
    static let line = Color.white.opacity(0.10)
    static let txt = Color(hex: "#f1f5f9")
    static let dim = Color(hex: "#94a3b8")
    static let accent = Color(hex: "#6366f1")
}

func statusColor(_ s: String) -> Color {
    switch s {
    case "em-andamento": return Color(hex: "#38bdf8")
    case "bloqueado": return Color(hex: "#f59e0b")
    case "pendente": return Color(hex: "#94a3b8")
    case "concluida": return Color(hex: "#22c55e")
    default: return .gray
    }
}

func sessionStateColor(_ s: String) -> Color {
    switch s {
    case "running": return Color(hex: "#22c55e")
    case "idle": return Color(hex: "#f59e0b")
    default: return Color(hex: "#64748b")
    }
}
