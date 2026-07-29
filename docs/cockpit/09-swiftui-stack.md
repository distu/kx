# 09 - Stack Tecnico do Cliente (SwiftUI + AppKit)

Decisao D2: nativo. A pesquisa tecnica comparou SwiftUI vs Tauri para exatamente este caso (menu bar, vibrancy configuravel, hotkeys globais, integracao com terminal, monitorar `.jsonl`) e o nativo venceu em qualidade visual, robustez de atalhos, tamanho de bundle e esforco. Cross-platform foi descartado (produto so macOS).

## Requisitos de plataforma

- **macOS 14 (Sonoma)+** como alvo. `MenuBarExtra` existe desde o 13, mas o estilo `.window` amadureceu no 14/15.
- **Xcode 16+**, Swift 6.
- Distribuicao pessoal fora da App Store (assinado + notarizado; ver "Distribuicao").

## Bibliotecas

| Lib | Uso | Origem |
|-----|-----|--------|
| `sindresorhus/KeyboardShortcuts` | Hotkeys globais + UI de captura + persistencia | SPM |
| (nativo) `MenuBarExtra` | App de menu bar em SwiftUI | Framework |
| (nativo) `NSVisualEffectView` | Vibrancy/transparencia | AppKit (via `NSViewRepresentable`) |
| (nativo) `UserNotifications` | Notificacoes/alarme | Framework |
| (nativo) `DispatchSource` / FSEvents | Observar `.jsonl` (complementa o SSE do daemon) | Framework |
| (nativo) `URLSession` | HTTP + consumo de SSE (bytes stream) | Framework |
| (nativo) `NSPasteboard`, `NSAppleScript`, `NSWorkspace` | Clipboard e automacao de terminal | AppKit |

Filosofia: minimo de dependencias externas. So `KeyboardShortcuts` justifica-se (reescrever captura de atalho global e caro e cheio de armadilhas).

---

## Esqueleto do app

```swift
@main
struct CockpitApp: App {
    @StateObject private var store = CockpitStore()   // estado + cliente do daemon

    var body: some Scene {
        MenuBarExtra {
            CockpitPanel()
                .environmentObject(store)
                .frame(width: 400)
        } label: {
            MenuBarLabel(counts: store.globalCounts)   // icone + badge (ativas/bloqueadas)
        }
        .menuBarExtraStyle(.window)                    // janela custom, nao menu nativo

        Settings {                                     // painel de Settings (Cmd+,)
            SettingsView().environmentObject(store)
        }
    }
}
```

### Camadas do cliente

| Camada | Responsabilidade |
|--------|------------------|
| `CockpitStore` (`ObservableObject`) | Estado observavel: projetos, atividades por aba, sessoes, saude; orquestra o `DaemonClient` |
| `DaemonClient` | HTTP (`URLSession async/await`) + SSE (stream de bytes parseando `event:`/`data:`) contra `127.0.0.1:7717` |
| `TerminalLauncher` | Abre/foca Warp/iTerm/Terminal (doc 07); clipboard |
| `HotkeyManager` | Registra atalhos globais e por-projeto (KeyboardShortcuts) |
| `NotificationManager` | Permissao + banners + som (UserNotifications) |
| `SessionWatcher` (opcional) | FSEvents locais para reacao instantanea, redundante ao SSE |
| `Preferences` | `UserDefaults` (transparencia, terminal, atalhos, densidade) |

O cliente e **stateless quanto a dados de dominio**: fonte e sempre o daemon. So preferencias de UI persistem local.

---

## Vibrancy / transparencia configuravel

```swift
struct VisualEffectBackground: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .hudWindow
    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = material
        v.blendingMode = .behindWindow
        v.state = .active
        return v
    }
    func updateNSView(_ v: NSVisualEffectView, context: Context) { v.material = material }
}
```

- Fundo do painel = `VisualEffectBackground()` + uma camada `Color` com opacidade vinda do slider (0-60-100%).
- Materiais expostos no Settings: `.hudWindow`, `.popover`, `.underWindowBackground`.
- Respeitar `NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency` -> cai para fundo solido.
- Garantir contraste minimo do texto: quando opacidade < limiar, subir peso/opacidade de foreground e divisorias.

---

## Consumo de SSE em Swift (essencial)

```swift
func streamEvents(project: String) async throws {
    var req = URLRequest(url: URL(string: "http://127.0.0.1:7717/events?project=\(project)")!)
    req.setValue(token, forHTTPHeaderField: "X-Cockpit-Token")
    let (bytes, _) = try await URLSession.shared.bytes(for: req)
    var currentEvent = ""
    for try await line in bytes.lines {
        if line.hasPrefix("event:") { currentEvent = line.dropFirst(6).trimmed }
        else if line.hasPrefix("data:") {
            let json = line.dropFirst(5).trimmed
            await MainActor.run { store.apply(event: currentEvent, data: json) }
        }
    }
}
```

Reconexao automatica com backoff se o stream cair (daemon reiniciou). Enquanto offline, UI mostra "reconectando".

---

## Notificacoes / alarme

- Pedir autorizacao `UNUserNotificationCenter` na 1a vez (banner + som).
- Disparadas por eventos SSE `alarm` (sessao terminou, MR mudou) ou por lembretes locais agendados (`UNTimeIntervalNotificationTrigger`).
- Clicar na notificacao abre o painel na aba/atividade certa (deep-link interno).

---

## Observacao local de `.jsonl` (complementar)

Mesmo com o SSE do daemon, um `DispatchSourceFileSystemObject` local em `~/.claude/projects/` da reacao instantanea (badge do icone atualiza sem round-trip). E redundancia barata; o daemon continua a fonte canonica.

---

## Distribuicao (app pessoal, sem App Store)

1. Assinar com Developer ID Application.
2. Notarizar (`notarytool`) + staple - evita o bloqueio do Gatekeeper.
3. `LSUIElement = true` no Info.plist (app so na menu bar, sem icone no Dock).
4. LaunchAgent opcional para subir no login (ou usar "abrir no login" do sistema).
5. O daemon `kxd` tem seu proprio LaunchAgent (`dev.example.kxd.plist`), independente do app.

---

## Limitacoes conhecidas do MenuBarExtra (e workarounds)

| Limitacao | Workaround |
|-----------|-----------|
| Controle fino de tamanho/dismiss da janela `.window` | Fixar `.frame(width:)`; para casos dificeis, cair para `NSStatusItem` + `NSPopover`/`NSPanel` custom em AppKit |
| Foco de teclado ao abrir | Forcar first responder no campo de busca via `NSApp`/representable |
| Nao fechar ao abrir sub-janelas (Settings) | Settings como `Scene` separada / `NSPanel` |
| Animacoes/transparencia limitadas no modo menu nativo | Usar `.menuBarExtraStyle(.window)` (ja adotado) |

Plano B arquitetural: se o `MenuBarExtra` apertar, a camada de UI (SwiftUI Views) e reaproveitada sob um host AppKit (`NSStatusItem` + `NSPopover`) sem reescrever a logica - `CockpitStore`/`DaemonClient` nao mudam.
