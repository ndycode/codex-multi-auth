import SwiftUI

// MARK: - Data model

struct QuotaWindow {
    var remaining: Int      // percent remaining
    var resetAtMs: Double?
}

struct AccountQuota: Identifiable {
    let id: String          // accountId
    let name: String        // email local-part
    var isActive: Bool
    var fiveHour: QuotaWindow?
    var sevenDay: QuotaWindow?
}

final class QuotaModel: ObservableObject {
    @Published var accounts: [AccountQuota] = []
    @Published var updating = false
    @Published var lastUpdated: Date?

    private let dataDir: String = {
        if let override = ProcessInfo.processInfo.environment["CODEX_MULTI_AUTH_DIR"] {
            return override
        }
        return NSHomeDirectory() + "/.codex/multi-auth"
    }()

    private func json(_ name: String) -> [String: Any]? {
        let path = dataDir + "/" + name
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return obj
    }

    /// Read the three local files and rebuild `accounts`. No network, no probe.
    func loadCache() {
        guard let store = json("openai-codex-accounts.json") else { return }
        let cache = json("quota-cache.json") ?? [:]
        let observ = json("runtime-observability.json") ?? [:]
        let byId = cache["byAccountId"] as? [String: Any] ?? [:]

        let storeAccounts = store["accounts"] as? [[String: Any]] ?? []
        let order = storeAccounts.compactMap { $0["accountId"] as? String }

        var activeId = observ["lastAccountId"] as? String
        if activeId == nil || !order.contains(activeId!) {
            if let idx = store["activeIndex"] as? Int, idx >= 0, idx < order.count {
                activeId = order[idx]
            }
        }

        func window(_ entry: [String: Any]?, _ key: String) -> QuotaWindow? {
            guard let w = entry?[key] as? [String: Any] else { return nil }
            let used = (w["usedPercent"] as? NSNumber)?.intValue ?? 0
            let reset = (w["resetAtMs"] as? NSNumber)?.doubleValue
            return QuotaWindow(remaining: 100 - used, resetAtMs: reset)
        }

        var newest: Double = 0
        var result: [AccountQuota] = []
        for acc in storeAccounts {
            guard let id = acc["accountId"] as? String else { continue }
            let email = acc["email"] as? String ?? id
            let name = email.split(separator: "@").first.map(String.init) ?? email
            let entry = byId[id] as? [String: Any]
            if let u = (entry?["updatedAt"] as? NSNumber)?.doubleValue { newest = max(newest, u) }
            result.append(AccountQuota(
                id: id,
                name: name,
                isActive: id == activeId,
                fiveHour: window(entry, "primary"),
                sevenDay: window(entry, "secondary")
            ))
        }
        DispatchQueue.main.async {
            self.accounts = result
            if newest > 0 { self.lastUpdated = Date(timeIntervalSince1970: newest / 1000) }
        }
    }

    /// Run `codex-multi-auth check` (a live probe), then reload the cache.
    func refresh() {
        if updating { return }
        updating = true
        DispatchQueue.global(qos: .userInitiated).async {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/bin/zsh")
            task.arguments = ["-lc", "codex-multi-auth check"]
            var env = ProcessInfo.processInfo.environment
            let home = NSHomeDirectory()
            env["PATH"] = "/usr/local/bin:/opt/homebrew/bin:\(home)/.npm-global/bin:" + (env["PATH"] ?? "")
            task.environment = env
            task.standardOutput = FileHandle.nullDevice
            task.standardError = FileHandle.nullDevice
            try? task.run()
            task.waitUntilExit()
            self.loadCache()
            DispatchQueue.main.async { self.updating = false }
        }
    }

    /// Probe only if the cache looks stale; otherwise just repaint.
    func refreshIfStale(maxAge: TimeInterval = 60) {
        loadCache()
        if let last = lastUpdated, Date().timeIntervalSince(last) < maxAge { return }
        refresh()
    }

    var titleRemaining: Int? {
        if let active = accounts.first(where: { $0.isActive }), let w = active.fiveHour {
            return w.remaining
        }
        return accounts.first?.fiveHour?.remaining
    }
}

// MARK: - Formatting helpers

func formatReset(_ ms: Double?) -> String {
    guard let ms else { return "-" }
    let left = Int(ms / 1000 - Date().timeIntervalSince1970)
    if left <= 0 { return "now" }
    let d = left / 86400, h = (left % 86400) / 3600, m = (left % 3600) / 60
    if d > 0 { return "\(d)d \(h)h" }
    if h > 0 { return "\(h)h \(m)m" }
    return "\(m)m"
}

func quotaColor(_ remaining: Int) -> Color {
    if remaining < 10 { return .red }
    if remaining < 30 { return .orange }
    return .green
}

func ageString(_ date: Date?) -> String {
    guard let date else { return "—" }
    let mins = Int(Date().timeIntervalSince(date) / 60)
    if mins < 1 { return "just now" }
    if mins < 60 { return "\(mins)m ago" }
    return "\(mins / 60)h ago"
}

// MARK: - Views

struct WindowRow: View {
    let label: String
    let window: QuotaWindow?

    var body: some View {
        HStack(spacing: 8) {
            Text(label).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary).frame(width: 20, alignment: .leading)
            if let w = window {
                ProgressView(value: Double(w.remaining), total: 100)
                    .tint(quotaColor(w.remaining))
                    .frame(width: 120)
                Text("\(w.remaining)%").font(.system(.caption, design: .monospaced).weight(.medium)).foregroundStyle(quotaColor(w.remaining)).frame(width: 38, alignment: .trailing)
                Spacer(minLength: 4)
                Text(formatReset(w.resetAtMs)).font(.caption).foregroundStyle(.secondary)
            } else {
                Text("no data").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct AccountCard: View {
    let account: AccountQuota

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Circle().fill(account.isActive ? Color.green : Color.secondary).frame(width: 7, height: 7)
                Text(account.name).font(.system(.body, design: .rounded).weight(.medium))
                Spacer()
                Text(account.isActive ? "ACTIVE" : "IDLE")
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(account.isActive ? .green : .secondary)
            }
            WindowRow(label: "5h", window: account.fiveHour)
            WindowRow(label: "7d", window: account.sevenDay)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(account.isActive ? Color.green.opacity(0.7) : Color.secondary.opacity(0.25), lineWidth: 1))
    }
}

struct QuotaView: View {
    @ObservedObject var model: QuotaModel
    @State private var ticker = Date()
    private let tick = Timer.publish(every: 30, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(model.accounts) { AccountCard(account: $0) }
            Divider()
            HStack {
                if model.updating {
                    ProgressView().controlSize(.small)
                    Text("updating…").font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("Updated \(ageString(model.lastUpdated))").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Refresh") { model.refresh() }.disabled(model.updating)
                Button { NSApp.terminate(nil) } label: { Image(systemName: "power") }.buttonStyle(.borderless)
            }
        }
        .padding(12)
        .frame(width: 300)
        .onAppear { model.refreshIfStale() }
        .onReceive(tick) { now in ticker = now; model.loadCache() }
    }
}

@main
struct CodexQuotaApp: App {
    @StateObject private var model = QuotaModel()
    @State private var titleTick = Date()
    private let tick = Timer.publish(every: 60, on: .main, in: .common).autoconnect()

    init() {
        let m = QuotaModel()
        m.loadCache()
        _model = StateObject(wrappedValue: m)
    }

    var body: some Scene {
        MenuBarExtra {
            QuotaView(model: model)
        } label: {
            if let r = model.titleRemaining {
                Text("⚡\(r)%")
            } else {
                Text("⚡?")
            }
        }
        .menuBarExtraStyle(.window)
    }
}
