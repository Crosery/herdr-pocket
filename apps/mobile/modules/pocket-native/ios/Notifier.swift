import Foundation
import Network
import UIKit
import UserNotifications

/**
 * Keeps /v1/notify open and turns notices into local notifications, the iOS side
 * of Notifier.kt. It is a separate socket from the app's main one, so the two
 * never replace each other.
 *
 * iOS suspends an app soon after it leaves the screen and has no equivalent of
 * Android's resident service: here alerts arrive while the app is open (or kept
 * running by a voice call). Alerts with the app closed would need push
 * notifications (APNs), which this build does not have. `notifierState` says so
 * with `background: false`.
 */
final class Notifier: NSObject, URLSessionWebSocketDelegate {
  static let shared = Notifier()

  private enum Key {
    static let server = "pocket.notify.server"
    static let lastTs = "pocket.notify.lastTs"
    static let recentIds = "pocket.notify.recentIds"
  }

  /// After a longer gap (the app was suspended), only this much is replayed: the rest is in the app already.
  private static let replayMs: Int64 = 60_000

  private let q = DispatchQueue(label: "dev.crosery.pocket.notify")
  private var defaults: UserDefaults { .standard }
  private lazy var session: URLSession = {
    let ops = OperationQueue()
    ops.maxConcurrentOperationCount = 1
    ops.underlyingQueue = q
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = 7 * 24 * 3600
    config.timeoutIntervalForResource = 7 * 24 * 3600
    return URLSession(configuration: config, delegate: self, delegateQueue: ops)
  }()

  // On `q`. The token lives only in memory: nothing runs without the app here.
  private var server: String?
  private var token: String?
  private var kinds: Set<String> = ["blocked", "done", "reminder"]
  private var running = false
  private var target: String?
  private var backoff: TimeInterval = 2
  private var ws: URLSessionWebSocketTask?
  private var retry: DispatchWorkItem?
  private var pinger: DispatchSourceTimer?
  private var monitor: NWPathMonitor?
  private var leftAt: Date?
  private var observers: [NSObjectProtocol] = []

  // Read synchronously from JS.
  private let lock = NSLock()
  private var _enabled = false
  private var _connected = false
  private var _allowed = true

  private var enabled: Bool {
    get { lock.lock(); defer { lock.unlock() }; return _enabled }
    set { lock.lock(); _enabled = newValue; lock.unlock() }
  }

  private var connected: Bool {
    get { lock.lock(); defer { lock.unlock() }; return _connected }
    set { lock.lock(); _connected = newValue; lock.unlock() }
  }

  private var allowed: Bool {
    get { lock.lock(); defer { lock.unlock() }; return _allowed }
    set { lock.lock(); _allowed = newValue; lock.unlock() }
  }

  private var lastTs: Int64 {
    get { (defaults.object(forKey: Key.lastTs) as? NSNumber)?.int64Value ?? 0 }
    set { defaults.set(NSNumber(value: newValue), forKey: Key.lastTs) }
  }

  func state() -> [String: Any] {
    [
      "enabled": enabled,
      "connected": connected,
      "notificationsAllowed": allowed,
      // Nothing to exempt on iOS; the row asking for it stays hidden.
      "batteryUnrestricted": true,
      "background": false,
    ]
  }

  /// Stores what the alert socket needs and starts or stops it (configureNotifier).
  func configure(server: String?, token: String?, enabled on: Bool, kinds: [String]) {
    q.async {
      if self.defaults.string(forKey: Key.server) != server {
        self.defaults.set(server, forKey: Key.server)
        self.lastTs = 0
        self.defaults.removeObject(forKey: Key.recentIds)
      }
      self.server = server
      self.token = token
      self.kinds = Set(kinds)
      let enabled = on && !(server ?? "").isEmpty && !(token ?? "").isEmpty
      self.enabled = enabled
      if enabled { self.start() } else { self.stop() }
      self.refreshPermission()
    }
  }

  /// Whether notifications may show; cached for notifierState, which JS reads synchronously.
  func refreshPermission() {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      let allowed = settings.authorizationStatus != .denied
      if allowed == self.allowed { return }
      self.allowed = allowed
      PocketBus.emit("onNotifier", ["connected": self.connected, "notificationsAllowed": allowed])
    }
  }

  private func start() {
    guard let server, let token else {
      stop()
      return
    }
    let key = "\(server)|\(token)"
    if running && key == target { return }
    stop()
    running = true
    target = key
    backoff = 2
    watchApp()
    watchNetwork()
    connect()
  }

  private func stop() {
    running = false
    target = nil
    retry?.cancel()
    retry = nil
    pinger?.cancel()
    pinger = nil
    ws?.cancel(with: .normalClosure, reason: nil)
    ws = nil
    connected = false
    monitor?.cancel()
    monitor = nil
  }

  private func watchApp() {
    if !observers.isEmpty { return }
    let nc = NotificationCenter.default
    observers.append(nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { [weak self] _ in
      self?.q.async { self?.leftAt = Date() }
    })
    observers.append(nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil) { [weak self] _ in
      self?.q.async { self?.cameBack() }
    })
  }

  /// Back on screen: a socket of a suspended app is usually dead without having said so, so start afresh.
  private func cameBack() {
    refreshPermission()
    let away = leftAt.map { Date().timeIntervalSince($0) } ?? 0
    leftAt = nil
    guard running, !connected || away > 20 else { return }
    retry?.cancel()
    backoff = 2
    if let old = ws {
      ws = nil
      old.cancel(with: .goingAway, reason: nil)
    }
    connected = false
    connect()
  }

  private func watchNetwork() {
    if monitor != nil { return }
    let m = NWPathMonitor()
    m.pathUpdateHandler = { [weak self] path in
      guard let self, path.status == .satisfied, self.running, self.ws == nil else { return }
      // Waiting to retry and the network is back: now, not after the backoff.
      self.retry?.cancel()
      self.backoff = 2
      self.connect()
    }
    m.start(queue: q)
    monitor = m
  }

  private func connect() {
    guard running, let server, let token, let base = wsUrl(server, "/v1/notify") else { return }
    ws?.cancel(with: .goingAway, reason: nil)
    let now = wallMs()
    let last = lastTs
    let since = last > 0 ? max(last, now - Notifier.replayMs) : now
    guard let url = URL(string: base.absoluteString + "?since=\(since)") else { return }
    var req = URLRequest(url: url)
    // The token rides in a header: a URL ends up in reverse-proxy access logs.
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    let task = session.webSocketTask(with: req)
    ws = task
    task.resume()
    receive(task)
  }

  private func receive(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self else { return }
      self.q.async {
        guard task === self.ws else { return }
        switch result {
        case .success(let message):
          if case .string(let text) = message { self.onText(text) }
          self.receive(task)
        case .failure:
          self.lost(task)
        }
      }
    }
  }

  private func onText(_ text: String) {
    guard let data = text.data(using: .utf8),
          let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          o["type"] as? String == "notice",
          let n = o["notice"] as? [String: Any] else { return }
    handle(n)
  }

  private func handle(_ n: [String: Any]) {
    let id = n["id"] as? String ?? ""
    let ts = (n["ts"] as? NSNumber)?.int64Value ?? 0
    if id.isEmpty { return }
    var recent = defaults.stringArray(forKey: Key.recentIds) ?? []
    if recent.contains(id) { return }
    recent.append(id)
    defaults.set(Array(recent.suffix(60)), forKey: Key.recentIds)
    if ts > lastTs { lastTs = ts }
    if let json = jsonString(n) { PocketBus.emit("onNotice", ["json": json]) }
    guard kinds.contains(n["kind"] as? String ?? "") else { return }
    NoticeCenter.post(id: id, title: n["title"] as? String ?? "", body: n["body"] as? String ?? "")
  }

  private func lost(_ task: URLSessionTask) {
    guard task === ws else { return }
    ws = nil
    pinger?.cancel()
    pinger = nil
    connected = false
    PocketBus.emit("onNotifier", ["connected": false])
    guard running else { return }
    if (task.response as? HTTPURLResponse)?.statusCode == 401 {
      // The phone was removed from the relay: stop instead of retrying forever.
      enabled = false
      stop()
      return
    }
    retry?.cancel()
    let item = DispatchWorkItem { [weak self] in self?.connect() }
    retry = item
    q.asyncAfter(deadline: .now() + backoff, execute: item)
    backoff = min(backoff * 2, 60)
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    q.async {
      guard webSocketTask === self.ws else { return }
      self.connected = true
      self.backoff = 2
      if self.lastTs == 0 { self.lastTs = wallMs() }
      PocketBus.emit("onNotifier", ["connected": true])
      self.pinger?.cancel()
      let t = DispatchSource.makeTimerSource(queue: self.q)
      t.schedule(deadline: .now() + 30, repeating: 30)
      t.setEventHandler { [weak self, weak webSocketTask] in
        webSocketTask?.sendPing { error in
          guard error != nil, let task = webSocketTask else { return }
          self?.q.async { self?.lost(task) }
        }
      }
      t.resume()
      self.pinger = t
    }
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    q.async { self.lost(webSocketTask) }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    q.async { self.lost(task) }
  }
}

/// Local notifications: posting them, showing them while the app is open, and what a tap opens.
final class NoticeCenter: NSObject, UNUserNotificationCenterDelegate {
  static let shared = NoticeCenter()

  /// At launch (PocketAppDelegate), so a tap that starts the app is not missed.
  static func install() {
    UNUserNotificationCenter.current().delegate = shared
  }

  static func post(id: String, title: String, body: String) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    content.userInfo = ["path": "assistant"]
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { _ in
      // Not allowed: nothing to show.
    }
  }

  /// While the app is open, show it anyway: Android shows its alerts in front of the app too.
  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    completionHandler([.banner, .list, .sound])
  }

  /// A tap opens the assistant (deep link handled by expo-router), like openAppIntent on Android.
  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
    let path = response.notification.request.content.userInfo["path"] as? String ?? "assistant"
    if let url = URL(string: "herdrpocket://\(path)") {
      DispatchQueue.main.async { UIApplication.shared.open(url) }
    }
    completionHandler()
  }
}
