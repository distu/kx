import SwiftUI

// Painel principal do Cockpit: barra de status, abas por projeto, camada KX activity manager (em cima)
// e camada de sessoes do Claude Code (embaixo, com destaque para as vinculadas).
struct CockpitPanel: View {
    @EnvironmentObject var store: CockpitStore

    var body: some View {
        VStack(spacing: 0) {
            statusBar
            Divider().overlay(Palette.line)
            tabs
            Divider().overlay(Palette.line)
            filterRow
            Divider().overlay(Palette.line)
            // ImageRenderer nao rende conteudo dentro de ScrollView; no modo --render usamos VStack.
            if AppConfig.renderMode {
                content.padding(8)
            } else {
                ScrollView { content.padding(8) }
            }
            Divider().overlay(Palette.line)
            footer
        }
        .frame(width: 404)
        .foregroundStyle(Palette.txt)
        .background {
            ZStack {
                Palette.base
                if !AppConfig.renderMode { VisualEffect().opacity(0.55) }
            }
            .ignoresSafeArea()
        }
    }

    // MARK: barra de status
    private var statusBar: some View {
        HStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 6)
                .fill(LinearGradient(colors: [Palette.accent, Color(hex: "#22d3ee"), Color(hex: "#22c55e")],
                                     startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: 20, height: 20)
            Text("KX Cockpit").font(.system(size: 13, weight: .bold))
            Spacer()
            HStack(spacing: 5) {
                Circle().fill(store.daemonOnline ? Color(hex: "#22c55e") : Color(hex: "#ef4444")).frame(width: 7, height: 7)
                Text(store.daemonOnline ? "daemon ok" : "offline").font(.system(size: 11)).foregroundStyle(Palette.dim)
            }
            Image(systemName: "gearshape").foregroundStyle(Palette.dim)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
    }

    // MARK: abas por projeto
    @ViewBuilder private var tabItems: some View {
        HStack(spacing: 6) {
            ForEach(store.projects) { p in
                let active = p.id == store.selected
                HStack(spacing: 6) {
                    Circle().fill(active ? .white : Color(hex: p.color)).frame(width: 8, height: 8)
                    Text(p.name).font(.system(size: 12, weight: active ? .semibold : .regular))
                    if let c = p.counts, c.active > 0 {
                        Text("\(c.active)").font(.system(size: 10))
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Capsule().fill(Color.white.opacity(0.18)))
                    }
                }
                .padding(.horizontal, 11).padding(.vertical, 5)
                .background(Capsule().fill(active ? Color(hex: p.color) : Palette.card))
                .overlay(Capsule().stroke(Palette.line, lineWidth: active ? 0 : 1))
                .onTapGesture { store.select(p.id) }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    @ViewBuilder private var tabs: some View {
        if AppConfig.renderMode {
            tabItems
        } else {
            ScrollView(.horizontal, showsIndicators: false) { tabItems }
        }
    }

    // MARK: filtro de status
    private var filterRow: some View {
        HStack(spacing: 6) {
            ForEach([("active", "Em andamento"), ("blocked", "Bloqueadas"),
                     ("pending", "Pendentes"), ("all", "Todas")], id: \.0) { key, label in
                let on = store.statusFilter == key
                Text(label).font(.system(size: 11, weight: on ? .semibold : .regular))
                    .padding(.horizontal, 9).padding(.vertical, 4)
                    .background(Capsule().fill(on ? Palette.accent.opacity(0.30) : .clear))
                    .overlay(Capsule().stroke(on ? Palette.accent.opacity(0.5) : Palette.line, lineWidth: 1))
                    .foregroundStyle(on ? Palette.txt : Palette.dim)
                    .onTapGesture { store.setFilter(key) }
            }
            Spacer()
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    // MARK: conteudo (2 camadas)
    private var content: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let e = store.error {
                Text(e).font(.system(size: 12)).foregroundStyle(Color(hex: "#fca5a5"))
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 9).fill(Color(hex: "#ef4444").opacity(0.12)))
            }

            sectionHeader("ACTIVITIES", count: store.activities.count)
            if store.activities.isEmpty {
                emptyLine("Nenhuma atividade neste filtro.")
            } else {
                ForEach(AppConfig.renderMode ? Array(store.activities.prefix(6)) : store.activities) { a in ActivityRow(a: a) }
            }

            sectionHeader("SESSOES DO CLAUDE CODE", count: store.sessions.count,
                          extra: store.sessionsInfo.map { "\($0.running) running · \($0.orphans) orfas" })
            if store.sessions.isEmpty {
                emptyLine("Nenhuma sessao aberta.")
            } else {
                ForEach(AppConfig.renderMode ? Array(store.sessions.prefix(7)) : store.sessions) { s in SessionRow(s: s) }
            }
        }
    }

    private func sectionHeader(_ title: String, count: Int, extra: String? = nil) -> some View {
        HStack {
            Text(title).font(.system(size: 11, weight: .bold)).foregroundStyle(Palette.dim).tracking(0.8)
            Text("\(count)").font(.system(size: 10)).foregroundStyle(Palette.dim)
                .padding(.horizontal, 6).background(Capsule().fill(Palette.card))
            Spacer()
            if let extra { Text(extra).font(.system(size: 10)).foregroundStyle(Palette.dim) }
        }
    }

    private func emptyLine(_ t: String) -> some View {
        Text(t).font(.system(size: 12)).foregroundStyle(Palette.dim).padding(.vertical, 6)
    }

    // MARK: rodape
    private var footer: some View {
        HStack {
            if let s = store.sessionsInfo, s.orphans > 0 {
                Text("\(s.orphans) sessoes sem KX activity manager — promova abaixo").font(.system(size: 11)).foregroundStyle(Palette.dim)
            } else {
                Text(store.selected).font(.system(size: 11)).foregroundStyle(Palette.dim)
            }
            Spacer()
            if let t = store.lastToast {
                Text(t).font(.system(size: 10)).foregroundStyle(Palette.accent)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
    }
}

// MARK: - Linha de atividade (KX activity manager)
struct ActivityRow: View {
    let a: Activity
    @EnvironmentObject var store: CockpitStore
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Circle().fill(statusColor(a.status)).frame(width: 9, height: 9)
                Text(a.titulo).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                Spacer()
                Text("#\(a.id)").font(.system(size: 10)).foregroundStyle(Palette.dim)
            }
            Text("\(a.squad) · atualizada \(a.updated)").font(.system(size: 11)).foregroundStyle(Palette.dim)
            if !a.lastLog.isEmpty {
                Text("\"\(a.lastLog)\"").font(.system(size: 11)).italic().foregroundStyle(Palette.txt.opacity(0.8)).lineLimit(1)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 11).fill(Palette.card))
        .overlay(RoundedRectangle(cornerRadius: 11).stroke(Palette.line, lineWidth: 1))
    }
}

// MARK: - Linha de sessao do Claude Code
struct SessionRow: View {
    let s: SessionItem
    @EnvironmentObject var store: CockpitStore
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Circle().fill(sessionStateColor(s.state)).frame(width: 8, height: 8)
                Text(s.title.isEmpty ? "(sessao)" : s.title).font(.system(size: 12.5, weight: s.highlight ? .semibold : .regular)).lineLimit(1)
                Spacer()
                Text(s.state).font(.system(size: 9))
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(Capsule().fill(s.state == "running" ? Color(hex: "#22c55e").opacity(0.25) : Palette.card))
            }
            if let link = s.linkedActivity {
                Text("vinculada a #\(link.id) \(link.titulo)").font(.system(size: 10)).foregroundStyle(Color(hex: "#a5b4fc")).lineLimit(1)
            } else if !s.firstPrompt.isEmpty {
                Text(s.firstPrompt).font(.system(size: 10)).foregroundStyle(Palette.dim).lineLimit(1)
            }
            HStack(spacing: 6) {
                Button("Focar") { store.openInTerminal(s.resumeCommand) }
                Button("Copiar") { store.copyCommand(s.resumeCommand) }
                if !s.inMegabrain {
                    Button("Promover") { Task { await store.promote(s) } }
                }
            }
            .font(.system(size: 10))
            .buttonStyle(.plain)
            .padding(.top, 2)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 11).fill(s.highlight ? Palette.accent.opacity(0.14) : Palette.card))
        .overlay(RoundedRectangle(cornerRadius: 11).stroke(s.highlight ? Palette.accent.opacity(0.45) : Palette.line, lineWidth: 1))
    }
}
