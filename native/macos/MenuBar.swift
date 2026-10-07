import AppKit
import Foundation
import Darwin

struct Agent: Decodable { let status: String; let folder: String? }
struct Project: Decodable { let folder: String; let name: String }
struct Desktop: Decodable {
    let `protocol`: Int
    let menuBar: Bool
    let labelLength: Int
    let focused: Bool
    let agentTime: Double
    let projects: [Project]
}
struct Control: Decodable { let enabled: Bool; let time: Double; let labelLength: Int? }
struct WindowEntry: Decodable {
    let id: String
    let pid: Int32
    let time: Double
    let target: String
    let agent: Agent?
    let desktop: Desktop?
}
struct Item {
    let folder: String
    let name: String
    let target: String
    let status: String
    let focused: Bool
}

final class MenuController: NSObject, NSApplicationDelegate {
    let storage: URL
    let cli: String
    let lockFD: Int32
    var standalone: Bool
    var connectedWindows = 0
    var timer: Timer?
    var animationTimer: Timer?
    var animationFrame = 0
    var iconRanges: [(range: NSRange, status: String)] = []
    var items: [Item] = []
    var strip: NSStatusItem?
    var segments: [(folder: String?, start: CGFloat, end: CGFloat)] = []
    var labelLength = 4
    var lastOpen = Date.distantPast
    var launching = false
    var emptyTicks = 0
    // Только последнее действие: диагностика не накапливает историю кликов.
    var lastClick: [String: Any] = [:]
    var lastSwitch: [String: Any] = [:]
    let manager = FileManager.default

    init(storage: URL, cli: String, lockFD: Int32, standalone: Bool) {
        self.storage = storage
        self.cli = cli
        self.lockFD = lockFD
        self.standalone = standalone
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        tick()
        let timer = Timer(timeInterval: 2, target: self, selector: #selector(tick), userInfo: nil, repeats: true)
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        let animation = Timer(timeInterval: 0.125, target: self, selector: #selector(animateIcons), userInfo: nil, repeats: true)
        RunLoop.main.add(animation, forMode: .common)
        animation.tolerance = 0.03
        animationTimer = animation
    }

    func readWindows() -> [WindowEntry] {
        let now = Date().timeIntervalSince1970 * 1000
        guard let urls = try? manager.contentsOfDirectory(at: storage, includingPropertiesForKeys: nil) else { return [] }
        return urls.compactMap { url in
            guard !url.lastPathComponent.hasPrefix("."), url.pathExtension == "json",
                  let data = try? Data(contentsOf: url),
                  let window = try? JSONDecoder().decode(WindowEntry.self, from: data),
                  window.pid > 0, now - window.time >= 0, now - window.time < 30000,
                  kill(window.pid, 0) == 0 || errno == EPERM else { return nil }
            return window
        }
    }

    @objc func tick() {
        let control = (try? Data(contentsOf: storage.appendingPathComponent(".menubar-control.json")))
            .flatMap { try? JSONDecoder().decode(Control.self, from: $0) }
        if let control = control {
            // Постоянный выбор общий для приложения и плагина, включая первый запуск.
            if !control.enabled { NSApp.terminate(nil); return }
            standalone = false
        }
        let windows = readWindows()
        let enabled = windows.filter { $0.desktop?.protocol == 1 && $0.desktop?.menuBar == true }
        connectedWindows = windows.filter { $0.desktop?.protocol == 1 }.count
        if !enabled.isEmpty { standalone = false }
        let noClients = control == nil ? enabled.isEmpty : connectedWindows == 0
        if noClients && !standalone {
            emptyTicks += 1
            // Небольшой запас на перезапуск последнего Extension Host.
            if emptyTicks >= 3 { NSApp.terminate(nil) }
            return
        }
        emptyTicks = 0
        if let length = control?.labelLength {
            labelLength = min(12, max(2, length))
        } else if let configuration = (enabled.isEmpty ? windows : enabled)
            .filter({ $0.desktop?.protocol == 1 }).sorted(by: { $0.time > $1.time }).first?.desktop {
            labelLength = min(12, max(2, configuration.labelLength))
        }
        let now = Date().timeIntervalSince1970 * 1000
        let rank = ["running": 8, "waiting": 7, "unknown": 6, "stopped": 5, "completed": 4, "idle": 3, "none": 2, "inactive": 1, "": 0]
        var grouped: [String: Item] = [:]
        // Все окна нового протокола, не только инициатор запуска помощника.
        for window in windows.sorted(by: { $0.id < $1.id }) {
            guard let desktop = window.desktop, desktop.protocol == 1 else { continue }
            for project in desktop.projects where project.folder.hasPrefix("/") {
                var status = window.agent?.status ?? ""
                if let agentFolder = window.agent?.folder, !agentFolder.isEmpty, agentFolder != project.folder {
                    status = "none"
                }
                if !status.isEmpty && (now - desktop.agentTime > 10000 || now - desktop.agentTime < 0) {
                    status = "unknown"
                }
                if rank[status] == nil { status = "unknown" }
                let item = Item(folder: project.folder, name: project.name, target: window.target,
                                status: status, focused: desktop.focused)
                if let previous = grouped[project.folder] {
                    let chosen = desktop.focused ? item : previous
                    let agentStatus = (rank[status] ?? 0) > (rank[previous.status] ?? 0) ? status : previous.status
                    grouped[project.folder] = Item(folder: chosen.folder, name: chosen.name, target: chosen.target,
                                                   status: agentStatus, focused: previous.focused || desktop.focused)
                } else { grouped[project.folder] = item }
            }
        }
        items = grouped.values.sorted {
            let order = $0.name.localizedStandardCompare($1.name)
            return order == .orderedSame ? $0.folder < $1.folder : order == .orderedAscending
        }
        render()
        writeHeartbeat()
    }

    func writeHeartbeat() {
        let buttonWindow = strip?.button?.window
        let heartbeat: [String: Any] = [
            "protocol": 1, "pid": getpid(), "time": Date().timeIntervalSince1970 * 1000,
            "standalone": standalone, "connectedWindows": connectedWindows,
            "projects": items.count, "statusItemVisible": strip?.isVisible ?? false,
            "buttonWindowVisible": buttonWindow?.isVisible ?? false,
            "buttonTitle": strip?.button?.attributedTitle.string ?? "",
            "buttonTitles": strip.map { [$0.button?.attributedTitle.string ?? ""] } ?? [],
            "statusItemCount": strip == nil ? 0 : 1,
            "buttonFrame": buttonWindow.map { NSStringFromRect($0.frame) } ?? "",
            "screen": buttonWindow?.screen?.localizedName ?? "",
            "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
            "launching": launching, "lastClick": lastClick, "lastSwitch": lastSwitch
        ]
        if let data = try? JSONSerialization.data(withJSONObject: heartbeat) {
            try? data.write(to: storage.appendingPathComponent(".menubar-heartbeat.json"), options: .atomic)
        }
    }

    func shortLabels() -> [String: String] {
        func start(_ item: Item) -> String { String(item.name.prefix(labelLength)).uppercased() }
        let groups = Dictionary(grouping: items, by: start)
        var result: [String: String] = [:]
        for item in items {
            var text = start(item)
            if (groups[text]?.count ?? 0) > 1 {
                text = String(item.name.prefix(labelLength)).uppercased() + "…" + String(item.name.suffix(3)).uppercased()
            }
            result[item.folder] = text
        }
        let duplicates = Dictionary(grouping: items, by: { result[$0.folder]! })
        for group in duplicates.values where group.count > 1 {
            for (index, item) in group.enumerated() {
                let parent = URL(fileURLWithPath: item.folder).deletingLastPathComponent().lastPathComponent
                // Номер гарантирует различимость даже одинаковых родительских имён.
                result[item.folder]! += "·" + String(parent.prefix(2)).uppercased() + "\(index + 1)"
            }
        }
        return result
    }

    func state(_ status: String) -> (String, NSColor, String) {
        switch status {
        case "running": return ("↻", .systemGreen, "Агент работает")
        case "waiting": return ("◷", .systemOrange, "Агент ждёт ответа")
        case "stopped": return ("Ⅱ", .secondaryLabelColor, "Агент остановлен")
        case "completed": return ("●", .systemGreen, "Выбранная задача завершена")
        case "idle": return ("·", .secondaryLabelColor, "Задача открыта · агент не работает, завершение не подтверждено")
        case "none": return ("○", .secondaryLabelColor, "Задача не выбрана")
        case "inactive": return ("○", .secondaryLabelColor, "Агент не активирован")
        case "unknown": return ("?", .systemOrange, "Статус агента недоступен или устарел")
        default: return ("·", .secondaryLabelColor, "Агент не установлен")
        }
    }

    func menuForProjects() -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        let connection = NSMenuItem(title: connectedWindows > 0
            ? "Подключено окон VS Code: \(connectedWindows)"
            : "Приложение работает · ожидание VS Code", action: nil, keyEquivalent: "")
        connection.isEnabled = false
        menu.addItem(connection)
        menu.addItem(.separator())
        if items.isEmpty {
            let item = NSMenuItem(title: "Нет открытых проектов каталога", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }
        for project in items {
            let info = state(project.status)
            let item = NSMenuItem(title: "\(info.0) \(project.name) — \(info.2)", action: #selector(menuClicked(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = project.folder
            item.toolTip = project.folder
            if project.focused { item.state = .on }
            menu.addItem(item)
        }
        menu.addItem(.separator())
        let note = NSMenuItem(title: "Настройки: VS Code → Проекты → ⚙", action: nil, keyEquivalent: "")
        note.isEnabled = false
        menu.addItem(note)
        let quit = NSMenuItem(title: "Завершить IVOL Cataloger", action: #selector(quitApp), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)
        return menu
    }

    @objc func quitApp() {
        // Иначе включённый плагин автоматически запустит приложение снова.
        let control: [String: Any] = ["enabled": false, "labelLength": labelLength,
                                      "time": Date().timeIntervalSince1970 * 1000]
        do {
            let data = try JSONSerialization.data(withJSONObject: control)
            try data.write(to: storage.appendingPathComponent(".menubar-control.json"), options: .atomic)
            NSApp.terminate(nil)
        } catch {
            notify("Не удалось сохранить выключение: \(error.localizedDescription)")
        }
    }

    func makeStatusItem(name: String, position: Double) -> NSStatusItem {
        // Новые элементы macOS добавляет слева — за разделителем Hidden Bar.
        // Задаём только начальную позицию наших кнопок, ручную перестановку сохраняем.
        let positionKey = "NSStatusItem Preferred Position " + name
        if UserDefaults.standard.object(forKey: positionKey) == nil {
            UserDefaults.standard.set(position, forKey: positionKey)
        }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.autosaveName = name
        return item
    }

    func icon(_ status: String) -> NSAttributedString {
        let frame = animationFrame
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let image = NSImage(size: NSSize(width: 12, height: 12), flipped: false) { _ in
            let color: NSColor = (status == "running" || status == "completed") ? .systemGreen
                : (status == "waiting" || status == "unknown" ? .systemOrange
                    : (status == "none" || status == "inactive" ? NSColor(calibratedWhite: 0.7, alpha: 1)
                        : (status == "idle" ? .secondaryLabelColor : .labelColor)))
            color.setStroke()
            color.setFill()
            if status == "running" {
                for index in 0..<8 {
                    let phase = reduceMotion ? index : (index - frame + 8) % 8
                    color.withAlphaComponent(0.25 + CGFloat(phase) / 7 * 0.75).setStroke()
                    let angle = CGFloat(index) * .pi / 4
                    let ray = NSBezierPath()
                    ray.lineWidth = 1.6
                    ray.lineCapStyle = .round
                    ray.move(to: NSPoint(x: 6 + cos(angle) * 3, y: 6 + sin(angle) * 3))
                    ray.line(to: NSPoint(x: 6 + cos(angle) * 5, y: 6 + sin(angle) * 5))
                    ray.stroke()
                }
            } else if status == "waiting" {
                let circle = NSBezierPath(ovalIn: NSRect(x: 1.5, y: 1.5, width: 9, height: 9))
                circle.lineWidth = 1.3; circle.stroke()
                let hands = NSBezierPath(); hands.lineWidth = 1.3; hands.lineCapStyle = .round
                hands.move(to: NSPoint(x: 6, y: 9)); hands.line(to: NSPoint(x: 6, y: 6)); hands.line(to: NSPoint(x: 8, y: 5)); hands.stroke()
            } else if status == "stopped" {
                NSBezierPath(roundedRect: NSRect(x: 3, y: 2, width: 2, height: 8), xRadius: 0.5, yRadius: 0.5).fill()
                NSBezierPath(roundedRect: NSRect(x: 7, y: 2, width: 2, height: 8), xRadius: 0.5, yRadius: 0.5).fill()
            } else if status == "unknown" {
                ("?" as NSString).draw(at: NSPoint(x: 2.5, y: -1), withAttributes: [.font: NSFont.boldSystemFont(ofSize: 12), .foregroundColor: color])
            } else if status == "inactive" || status == "none" {
                let circle = NSBezierPath(ovalIn: NSRect(x: 1.5, y: 1.5, width: 9, height: 9)); circle.lineWidth = 1.6; circle.stroke()
            } else if status == "completed" {
                NSBezierPath(ovalIn: NSRect(x: 1.5, y: 1.5, width: 9, height: 9)).fill()
            } else {
                NSBezierPath(ovalIn: NSRect(x: 4, y: 4, width: 4, height: 4)).fill()
            }
            return true
        }
        let attachment = NSTextAttachment()
        attachment.image = image
        attachment.bounds = NSRect(x: 0, y: -2, width: 12, height: 12)
        return NSAttributedString(attachment: attachment)
    }

    @objc func animateIcons() {
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion,
              let button = strip?.button, strip?.isVisible == true,
              iconRanges.contains(where: { $0.status == "running" }) else { return }
        animationFrame = (animationFrame + 1) % 8
        let title = NSMutableAttributedString(attributedString: button.attributedTitle)
        // Меняем только картинки одинакового размера: подписи и зоны кликов не прыгают.
        for entry in iconRanges where entry.status == "running" {
            title.replaceCharacters(in: entry.range, with: icon(entry.status))
        }
        button.attributedTitle = title
    }

    func render() {
        // Один штатный элемент: macOS переносит всю полоску через Command-drag.
        if strip == nil && !items.isEmpty {
            strip = makeStatusItem(name: "ivol.catalog.project-strip", position: 60)
        }
        guard let strip = strip, let button = strip.button else { return }
        strip.isVisible = !items.isEmpty
        guard !items.isEmpty else { segments = []; iconRanges = []; return }
        let labels = shortLabels()
        let title = NSMutableAttributedString(string: "")
        segments = []
        iconRanges = []
        // Оставляем место системным значкам; остальные проекты доступны в меню +N.
        let screenWidth = button.window?.screen?.frame.width ?? NSScreen.main?.frame.width ?? 1440
        let limit = max(180, min(1200, screenWidth * 0.55))
        for (index, project) in items.enumerated() {
            let font = NSFont.systemFont(ofSize: 12, weight: project.focused ? .semibold : .regular)
            let part = NSMutableAttributedString(string: index == 0 ? "" : "  ", attributes: [.font: font])
            let iconOffset = part.length
            part.append(icon(project.status))
            part.append(NSAttributedString(string: " " + (labels[project.folder] ?? project.name),
                attributes: [.font: font, .foregroundColor: NSColor.labelColor]))
            let start = title.size().width
            if start + part.size().width > limit - 65 && index > 0 {
                let more = NSAttributedString(string: "  +\(items.count - index)  ",
                    attributes: [.font: NSFont.systemFont(ofSize: 12, weight: .regular), .foregroundColor: NSColor.labelColor])
                title.append(more)
                segments.append((nil, start, title.size().width))
                break
            }
            iconRanges.append((NSRange(location: title.length + iconOffset, length: 1), project.status))
            title.append(part)
            segments.append((project.folder, start, title.size().width))
        }
        strip.length = ceil(title.size().width) + 12
        button.attributedTitle = title
        button.toolTip = items.map { "\($0.name) — \(state($0.status).2)\n\($0.folder)" }.joined(separator: "\n\n")
            + "\n\nКлик по названию — перейти; правый клик — все проекты; ⌘ + перетаскивание — вся полоска"
        button.setAccessibilityLabel(items.map { "\($0.name), \(state($0.status).2)" }.joined(separator: "; "))
        button.target = self
        button.action = #selector(projectClicked(_:))
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
    }

    @objc func projectClicked(_ sender: NSStatusBarButton) {
        lastClick = ["time": Date().timeIntervalSince1970 * 1000, "source": "strip"]
        defer { writeHeartbeat() }
        guard let event = NSApp.currentEvent else { lastClick["result"] = "no-event"; return }
        lastClick["eventType"] = event.type.rawValue
        // Command используется самой системой для перестановки, не открываем проект.
        if event.modifierFlags.contains(.command) { lastClick["result"] = "command-drag"; return }
        if event.type == .rightMouseUp {
            lastClick["result"] = "menu"
            menuForProjects().popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height), in: sender)
            return
        }
        let eventPoint = sender.convert(event.locationInWindow, from: nil)
        guard let buttonWindow = sender.window else { lastClick["result"] = "no-window"; return }
        // Системная строка может передать синтетическое событие с центром кнопки.
        // Для выбора сегмента используем текущий курсор в координатах экрана AppKit.
        let screenPoint = NSEvent.mouseLocation
        let point = sender.convert(buttonWindow.convertPoint(fromScreen: screenPoint), from: nil)
        lastClick["eventPointX"] = Double(eventPoint.x)
        lastClick["eventPointY"] = Double(eventPoint.y)
        lastClick["screenPoint"] = NSStringFromPoint(screenPoint)
        lastClick["coordinateSource"] = "screen-cursor"
        guard sender.bounds.contains(point) else {
            lastClick["result"] = "cursor-outside-show-menu"
            menuForProjects().popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height), in: sender)
            return
        }
        let titleRect = sender.cell?.titleRect(forBounds: sender.bounds) ?? sender.bounds
        let start = titleRect.midX - sender.attributedTitle.size().width / 2
        let x = point.x - start
        lastClick["pointX"] = Double(point.x)
        lastClick["pointY"] = Double(point.y)
        lastClick["bounds"] = NSStringFromRect(sender.bounds)
        lastClick["titleRect"] = NSStringFromRect(titleRect)
        lastClick["titleWidth"] = Double(sender.attributedTitle.size().width)
        lastClick["textX"] = Double(x)
        lastClick["segments"] = segments.map { ["folder": $0.folder ?? "", "start": Double($0.start), "end": Double($0.end)] as [String: Any] }
        guard let segment = segments.first(where: { x >= $0.start && x < $0.end }) else {
            lastClick["result"] = "miss-show-menu"
            menuForProjects().popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height), in: sender)
            return
        }
        lastClick["result"] = segment.folder == nil ? "overflow" : "project"
        lastClick["folder"] = segment.folder ?? ""
        if let folder = segment.folder { openProject(folder) }
        else { menuForProjects().popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height), in: sender) }
    }

    @objc func menuClicked(_ sender: NSMenuItem) {
        lastClick = ["time": Date().timeIntervalSince1970 * 1000, "source": "menu", "folder": sender.representedObject as? String ?? ""]
        if let folder = sender.representedObject as? String { openProject(folder) }
        writeHeartbeat()
    }

    func notify(_ text: String) {
        let alert = NSAlert()
        alert.messageText = "IVOL Cataloger"
        alert.informativeText = text
        alert.addButton(withTitle: "Понятно")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    func openProject(_ folder: String) {
        guard !launching else { lastClick["ignored"] = "busy"; return }
        guard Date().timeIntervalSince(lastOpen) > 0.7 else { lastClick["ignored"] = "throttled"; return }
        let requestID = UUID().uuidString
        lastSwitch = ["id": requestID, "time": Date().timeIntervalSince1970 * 1000, "folder": folder, "stage": "resolve-window"]
        defer { writeHeartbeat() }
        // Проверяем живое окно повторно: клик не должен открывать уже закрытый проект.
        let windows = readWindows()
        guard let window = windows.sorted(by: { ($0.desktop?.focused == true ? 1 : 0) > ($1.desktop?.focused == true ? 1 : 0) })
            .first(where: { $0.desktop?.projects.contains(where: { $0.folder == folder }) == true }) else {
            lastSwitch["stage"] = "window-not-found"
            tick()
            return
        }
        lastSwitch["windowID"] = window.id
        lastSwitch["windowPID"] = window.pid
        lastSwitch["target"] = window.target
        lastSwitch["stage"] = "validate-target"
        guard let target = URL(string: window.target), target.isFileURL else {
            notify("Сначала сохраните рабочую область в VS Code. Переключение на несохранённую рабочую область не поддерживается.")
            return
        }
        guard manager.fileExists(atPath: target.path) else {
            notify("Папка или файл рабочей области больше не существует.")
            return
        }
        lastSwitch["stage"] = "resolve-editor"
        var editorURL = URL(fileURLWithPath: cli).resolvingSymlinksInPath()
        while editorURL.path != "/" && editorURL.pathExtension.lowercased() != "app" {
            editorURL.deleteLastPathComponent()
        }
        guard let executable = Bundle(url: editorURL)?.executableURL,
              manager.isExecutableFile(atPath: executable.path) else {
            notify("Не удалось найти приложение VS Code для переключения окна.")
            return
        }
        guard let editor = NSWorkspace.shared.runningApplications.first(where: {
            !$0.isTerminated && $0.bundleURL?.resolvingSymlinksInPath().path == editorURL.path
        }) else {
            tick()
            notify("Приложение VS Code уже закрыто.")
            return
        }
        lastSwitch["editorPID"] = editor.processIdentifier
        lastSwitch["executable"] = executable.path
        let process = Process()
        // Прямой executable передаёт запрос существующему VS Code через single-instance IPC.
        // Оболочка code на macOS запускает open -n -g и завершается раньше обработки запроса.
        process.executableURL = executable
        // VS Code находит открытую папку/workspace и сам восстанавливает свёрнутое окно.
        // new-window защищает другое активное окно при гонке закрытия целевого.
        process.arguments = ["--new-window", target.path]
        var environment = ProcessInfo.processInfo.environment
        environment.removeValue(forKey: "VSCODE_IPC_HOOK_CLI")
        environment.removeValue(forKey: "ELECTRON_RUN_AS_NODE")
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.launching = false
                self.lastSwitch["stage"] = "process-exited"
                self.lastSwitch["exitCode"] = process.terminationStatus
                self.lastSwitch["exitTime"] = Date().timeIntervalSince1970 * 1000
                if process.terminationStatus != 0 {
                    self.writeHeartbeat()
                    self.notify("Не удалось переключить окно VS Code (код \(process.terminationStatus)).")
                } else if !editor.isTerminated {
                    // Результат активации приложения ещё не доказывает фокус выбранного окна.
                    self.lastSwitch["unhideAccepted"] = editor.unhide()
                    self.lastSwitch["activationAccepted"] = editor.activate(options: [.activateIgnoringOtherApps])
                    self.lastSwitch["stage"] = "activation-requested"
                }
                self.writeHeartbeat()
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                    guard let self = self, self.lastSwitch["id"] as? String == requestID else { return }
                    let current = self.readWindows()
                    let selected = current.first(where: { $0.id == window.id })
                    self.lastSwitch["windowStillRegistered"] = selected != nil
                    self.lastSwitch["selectedWindowFocused"] = selected?.desktop?.focused ?? false
                    self.lastSwitch["editorActive"] = editor.isActive
                    self.lastSwitch["editorHidden"] = editor.isHidden
                    self.lastSwitch["checkedAt"] = Date().timeIntervalSince1970 * 1000
                    self.writeHeartbeat()
                }
            }
        }
        do {
            launching = true
            lastOpen = Date()
            lastSwitch["stage"] = "starting-process"
            try process.run()
            lastSwitch["stage"] = "process-running"
            lastSwitch["processPID"] = process.processIdentifier
        } catch {
            launching = false
            lastSwitch["stage"] = "start-error"
            lastSwitch["error"] = error.localizedDescription
            notify("Не удалось запустить VS Code: \(error.localizedDescription)")
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        animationTimer?.invalidate()
        try? manager.removeItem(at: storage.appendingPathComponent(".menubar-heartbeat.json"))
        flock(lockFD, LOCK_UN)
        close(lockFD)
    }
}

let arguments = CommandLine.arguments
func argument(_ key: String) -> String? {
    guard let index = arguments.firstIndex(of: key), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}
let standalone = argument("--storage") == nil || arguments.contains("--standalone")
let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
let directory = argument("--storage") ?? support.appendingPathComponent("Code/User/globalStorage/ivol.ivol-project-catalog/windows").path
let cli = argument("--cli") ?? "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
guard directory.hasPrefix("/"), cli.hasPrefix("/") else { exit(2) }
let storage = URL(fileURLWithPath: directory, isDirectory: true)
try FileManager.default.createDirectory(at: storage, withIntermediateDirectories: true)
// Блокировка ядра не устаревает после аварийного завершения процесса.
let lockFD = open(storage.appendingPathComponent(".menubar.lock").path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
guard lockFD >= 0 else { exit(3) }
guard flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { close(lockFD); exit(0) }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = MenuController(storage: storage, cli: cli, lockFD: lockFD, standalone: standalone)
app.delegate = controller
app.run()
