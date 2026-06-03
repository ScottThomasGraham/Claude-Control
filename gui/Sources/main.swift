// gui/Sources/main.swift — Claude-Control panel (Layout A: session list + detail).
import AppKit

let SERVICE = "claude-control-rdp"

func stateRoot() -> String {
    if let e = ProcessInfo.processInfo.environment["CLAUDE_CONTROL_STATE_DIR"] { return e }
    return NSString(string: "~/Library/Application Support/claude-control").expandingTildeInPath
}
func sessionsDir() -> String { (stateRoot() as NSString).appendingPathComponent("sessions") }

struct Session: Decodable {
    var sessionId: String; var host: String; var user: String
    var label: String?; var state: String
    var since: Double; var lastActivityAt: Double; var lastFrameAt: Double
    var lastHeartbeatAt: Double; var currentTool: String?; var lastError: String?
    var dir: String = ""
    enum CodingKeys: String, CodingKey {
        case sessionId, host, user, label, state, since, lastActivityAt
        case lastFrameAt, lastHeartbeatAt, currentTool, lastError
    }
}

func loadSessions() -> [Session] {
    let fm = FileManager.default
    guard let ids = try? fm.contentsOfDirectory(atPath: sessionsDir()) else { return [] }
    var out: [Session] = []
    for id in ids.sorted() {
        let dir = (sessionsDir() as NSString).appendingPathComponent(id)
        let sj = (dir as NSString).appendingPathComponent("status.json")
        guard let data = fm.contents(atPath: sj),
              var s = try? JSONDecoder().decode(Session.self, from: data) else { continue }
        s.dir = dir; out.append(s)
    }
    return out
}

func setKeychain(host: String, user: String, password: String) {
    let p = Process(); p.launchPath = "/usr/bin/security"
    p.arguments = ["add-generic-password", "-U", "-A", "-s", SERVICE,
                   "-a", "\(user)@\(host)", "-w", password]
    try? p.run(); p.waitUntilExit()
}

func dotColor(_ state: String, stale: Bool) -> NSColor {
    if stale { return .systemGray }
    switch state {
    case "working", "connecting": return .systemGreen
    case "idle": return .systemYellow
    case "error": return .systemRed
    default: return .systemGray
    }
}

final class Controller: NSObject, NSApplicationDelegate, NSTableViewDataSource, NSTableViewDelegate {
    var window: NSWindow!
    var table: NSTableView!
    var sessions: [Session] = []
    var selected: Int = -1
    let titleLabel = NSTextField(labelWithString: "")
    let stateLabel = NSTextField(labelWithString: "")
    let image = NSImageView()
    let pwField = NSSecureTextField()

    func applicationDidFinishLaunching(_ n: Notification) {
        let rect = NSRect(x: 0, y: 0, width: 880, height: 560)
        window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Claude-Control"
        window.center()

        let split = NSSplitView(frame: rect)
        split.isVertical = true; split.dividerStyle = .thin
        split.autoresizingMask = [.width, .height]

        // left: sessions table
        let leftScroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 240, height: 560))
        table = NSTableView(); table.headerView = nil
        let col = NSTableColumn(identifier: .init("s")); col.width = 220
        table.addTableColumn(col); table.dataSource = self; table.delegate = self
        table.rowHeight = 44
        leftScroll.documentView = table; leftScroll.hasVerticalScroller = true

        // right: detail
        let right = NSView(frame: NSRect(x: 0, y: 0, width: 620, height: 560))
        titleLabel.font = .boldSystemFont(ofSize: 15)
        let stack = NSStackView(views: [titleLabel, stateLabel])
        stack.orientation = .vertical; stack.alignment = .leading
        stack.frame = NSRect(x: 16, y: 510, width: 580, height: 40)
        stack.autoresizingMask = [.width, .minYMargin]
        image.frame = NSRect(x: 16, y: 120, width: 588, height: 360)
        image.imageScaling = .scaleProportionallyUpOrDown
        image.wantsLayer = true; image.layer?.backgroundColor = NSColor.black.cgColor
        image.autoresizingMask = [.width, .height]
        let pwLabel = NSTextField(labelWithString: "RDP password:")
        pwLabel.frame = NSRect(x: 16, y: 70, width: 110, height: 24)
        pwField.frame = NSRect(x: 130, y: 68, width: 320, height: 26)
        let save = NSButton(title: "Save", target: self, action: #selector(savePassword))
        save.frame = NSRect(x: 458, y: 66, width: 80, height: 30)
        right.addSubview(stack); right.addSubview(image)
        right.addSubview(pwLabel); right.addSubview(pwField); right.addSubview(save)

        split.addSubview(leftScroll); split.addSubview(right)
        window.contentView = split
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        refresh()
        Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in self.refresh() }
    }

    func refresh() {
        sessions = loadSessions()
        table.reloadData()
        if selected >= 0 && selected < sessions.count { showDetail(sessions[selected]) }
        else { titleLabel.stringValue = sessions.isEmpty ? "No active sessions" : "Select a session"
               stateLabel.stringValue = "" }
    }

    func showDetail(_ s: Session) {
        let stale = Date().timeIntervalSince1970 - s.lastHeartbeatAt > 10
        titleLabel.stringValue = "\(s.label ?? s.host)  ·  \(s.user)@\(s.host)"
        var line = stale ? "stopped (no response)" : s.state
        if let t = s.currentTool, s.state == "working" { line += " · \(t)" }
        if let e = s.lastError, s.state == "error" { line += " — \(e)" }
        stateLabel.stringValue = line
        let fp = (s.dir as NSString).appendingPathComponent("frame.png")
        if let img = NSImage(contentsOfFile: fp) { image.image = img }
    }

    @objc func savePassword() {
        guard selected >= 0 && selected < sessions.count else { return }
        let s = sessions[selected]
        setKeychain(host: s.host, user: s.user, password: pwField.stringValue)
        pwField.stringValue = ""
        let a = NSAlert(); a.messageText = "Saved password for \(s.user)@\(s.host)"; a.runModal()
    }

    func numberOfRows(in t: NSTableView) -> Int { sessions.count }

    func tableView(_ t: NSTableView, viewFor col: NSTableColumn?, row: Int) -> NSView? {
        let s = sessions[row]
        let stale = Date().timeIntervalSince1970 - s.lastHeartbeatAt > 10
        let v = NSView(frame: NSRect(x: 0, y: 0, width: 220, height: 44))
        let dot = NSView(frame: NSRect(x: 10, y: 16, width: 12, height: 12))
        dot.wantsLayer = true; dot.layer?.cornerRadius = 6
        dot.layer?.backgroundColor = dotColor(s.state, stale: stale).cgColor
        let lbl = NSTextField(labelWithString: "\(s.label ?? s.host)\n\(stale ? "stopped" : s.state)")
        lbl.frame = NSRect(x: 30, y: 4, width: 185, height: 36)
        lbl.font = .systemFont(ofSize: 12); lbl.maximumNumberOfLines = 2
        v.addSubview(dot); v.addSubview(lbl)
        return v
    }

    func tableViewSelectionDidChange(_ n: Notification) {
        selected = table.selectedRow
        if selected >= 0 && selected < sessions.count { showDetail(sessions[selected]) }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let c = Controller()
app.delegate = c
app.run()
