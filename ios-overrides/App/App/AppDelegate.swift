import UIKit
import WebKit
import Capacitor

// MARK: - FGame OAuth auto-link
//
// Native apps (Heybox / Heroic / Legendary) can finish an Epic or GOG login
// without making the user copy an authorization code, because an embedded
// WKWebView can observe navigations and page content. A normal web page
// cannot (Epic sends X-Frame-Options: SAMEORIGIN + COOP: same-origin and
// never postMessages the code to its opener) — that is exactly why the
// original web build asked for a paste.
//
// Flow:
//   JS -> fgame://oauth?platform=epic&url=<login URL>       (deep link)
//   AppDelegate presents FGAMEOAuthViewController (WKWebView)
//   injected detector script reads the code on the platform's success page
//   -> fgame://oauth-code?platform=...&code=... (intercepted navigation)
//   -> NotificationCenter -> evaluateJavaScript in the Capacitor WebView
//   -> window 'fgameOAuthCode' event -> auth-bridge.ts calls epicLogin/gogLogin
//
// All native code lives in AppDelegate.swift, which the Capacitor template
// already references in the Xcode project. No .pbxproj editing is needed.

extension Notification.Name {
    static let fgameOAuthCode = Notification.Name("fgameOAuthCode")
    static let fgameClaimResult = Notification.Name("fgameClaimResult")
}

private func fgameFindWebView(_ view: UIView) -> WKWebView? {
    if let w = view as? WKWebView { return w }
    for sub in view.subviews {
        if let w = fgameFindWebView(sub) { return w }
    }
    return nil
}

/// The script injected into the login WebView. It polls the current URL and
/// document, extracts the authorization code, and navigates to the fgame
/// deep-link scheme, which we cancel in decidePolicyForNavigationAction.
private func fgameDetectorScript(platform: String) -> String {
    let p = platform.replacingOccurrences(of: "'", with: "")
    return """
    (function () {
      var PLATFORM = '\(p)';
      var reported = false;
      function report(payload) {
        if (reported || !payload || payload.length < 8) return;
        reported = true;
        window.location.href = 'fgame://oauth-code?platform=' + encodeURIComponent(PLATFORM) +
          '&code=' + encodeURIComponent(payload);
      }
      function check() {
        if (reported) return;
        try {
          var href = window.location.href || '';
          var body = (document.body && document.body.innerText) || '';
          // Prefer the FULL success-page URL. The server parses code= out of
          // it and accepts any code alphabet — GOG codes are base64-ish and
          // may contain + / = (extracting the bare code here used to get it
          // rejected downstream as "没有读到授权码").
          if (/[?&]code=/.test(href)) { report(href); return; }
          // Epic renders {"authorizationCode":"..."} as JSON text.
          var m = body.match(/"authorizationCode"\\s*:\\s*"([^"]+)"/);
          if (m && m[1]) { report(m[1]); return; }
        } catch (e) {}
        setTimeout(check, 400);
      }
      setTimeout(check, 300);
    })();
    """
}

final class FGAMEOAuthViewController: UIViewController, WKNavigationDelegate {
    private let platform: String
    private let startURL: URL
    private var webView: WKWebView!

    init(platform: String, url: URL) {
        self.platform = platform
        self.startURL = url
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.043, green: 0.063, blue: 0.149, alpha: 1)

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        let script = WKUserScript(
            source: fgameDetectorScript(platform: platform),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(script)

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.allowsBackForwardNavigationGestures = true

        let bar = UIView()
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.backgroundColor = UIColor(red: 0.043, green: 0.063, blue: 0.149, alpha: 1)
        let title = UILabel()
        title.translatesAutoresizingMaskIntoConstraints = false
        title.text = platform == "gog" ? "登录 GOG" : "登录 Epic Games"
        title.textColor = .white
        title.font = .boldSystemFont(ofSize: 15)
        let close = UIButton(type: .system)
        close.translatesAutoresizingMaskIntoConstraints = false
        close.setTitle("取消", for: .normal)
        close.setTitleColor(.white, for: .normal)
        close.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
        close.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)

        view.addSubview(bar)
        bar.addSubview(title)
        bar.addSubview(close)
        view.addSubview(webView)

        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bar.heightAnchor.constraint(equalToConstant: 48),
            title.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            title.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 18),
            close.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            close.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -18),
            webView.topAnchor.constraint(equalTo: bar.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        webView.load(URLRequest(url: startURL))
    }

    @objc private func closeTapped() {
        dismiss(animated: true)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if let url = navigationAction.request.url,
           url.scheme == "fgame",
           url.host == "oauth-code" {
            let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
            let items = comps?.queryItems ?? []
            let platform = items.first(where: { $0.name == "platform" })?.value ?? "epic"
            let code = items.first(where: { $0.name == "code" })?.value ?? ""
            if !code.isEmpty {
                NotificationCenter.default.post(
                    name: .fgameOAuthCode,
                    object: nil,
                    userInfo: ["platform": platform, "code": code]
                )
            }
            decisionHandler(.cancel)
            dismiss(animated: true)
            return
        }
        decisionHandler(.allow)
    }
}


// MARK: - FGame Epic one-tap claim (Heybox-style)
//
// Epic's 0-cost checkout lives on store.epicgames.com behind a Cloudflare
// gate that rejects datacenter IPs and launcher tokens. The only reliable
// way to claim — the one Heybox/Heroic use — is a real browser session:
// an embedded WKWebView sharing the system cookie jar (so an Epic login in
// the OAuth view counts here too), navigated to the purchase deep link,
// where we click through the 0-order exactly like a human.
//
// Flow:
//   JS -> fgame://claim?payload=<base64 JSON:{offers:[{namespace,offerId,title}]}>
//   AppDelegate presents FGameClaimViewController (WKWebView, .default store)
//   WebView loads store.epicgames.com/purchase?offers=1-ns-id&... for each
//   offer in turn; an injected script clicks GET -> Place Order -> I Accept,
//   handles EULA, and watches for "Thanks for your order!" per offer.
//   -> fgameClaimResult notification -> evaluateJavaScript in Capacitor view
//   -> window 'fgameClaimResult' event -> claim-bridge.ts
//
// WKWebView cannot run JS inside a cross-origin checkout iframe from the
// page context. We get around that at the native layer: decidePolicyFor
// records the checkout frame's WKFrameInfo, and evaluateJavaScript(_:in:)
// injects the click script straight into that frame. Two injections run:
// a document-end script on the top page (purchase CTA / EULA / success text)
// and, once the checkout frame commits, the same helper injected into that
// frame via `in: frame` so `Place Order` is reachable cross-origin.

/// Injected into the top store page. Polls for the purchase CTA, the EULA
/// checkbox and the success banner, reporting each transition back to native
/// with a `fgame://claim-ev?step=...` navigation that decidePolicy cancels.
private func fgameClaimTopScript() -> String {
    return """
    (function () {
      var ACTIVE = true;
      function ev(step) {
        try {
          var q = 'fgame://claim-ev?step=' + encodeURIComponent(step);
          window.location.href = q;
        } catch (e) {}
      }
      function visible(el) {
        if (!el) return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      function clickText(sel, texts) {
        var nodes = document.querySelectorAll(sel);
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i], t = (n.innerText || n.textContent || '').trim().toLowerCase();
          for (var j = 0; j < texts.length; j++) {
            if (t.indexOf(texts[j]) >= 0 && visible(n)) { n.click(); return true; }
          }
        }
        return false;
      }
      function tick() {
        if (!ACTIVE) return;
        try {
          var txt = (document.body && document.body.innerText || '').toLowerCase();
          if (txt.indexOf('thanks for your order') >= 0) { ev('success'); ACTIVE = false; return; }
          if (txt.indexOf('already own') >= 0 || txt.indexOf('in library') >= 0) { ev('owned'); ACTIVE = false; return; }
          var agree = document.querySelector('#agree') || document.querySelector('input[type=checkbox][id*=agree]');
          if (agree && !agree.checked && visible(agree)) { agree.click(); }
          var accepted = clickText('button', ['accept', 'i accept', 'yes, buy now', 'continue']);
          if (accepted) { ev('accepted'); }
          var cta = document.querySelector('button[data-testid="purchase-cta-button"]');
          if (cta && visible(cta)) {
            var ct = (cta.innerText || '').trim().toLowerCase();
            if (ct.indexOf('get') >= 0 || ct.indexOf('buy') >= 0) { cta.click(); ev('cta'); }
            else if (ct.indexOf('in library') >= 0) { ev('owned'); ACTIVE = false; return; }
          }
        } catch (e) {}
        setTimeout(tick, 700);
      }
      setTimeout(tick, 900);
    })();
    """
}

/// Injected into the checkout frame (via evaluateJavaScript in:frame).
/// Clicks Place Order once the total is 0, handles EU "I Accept" and PIN.
private func fgameClaimFrameScript() -> String {
    return """
    (function () {
      var ACTIVE = true;
      function ev(step) {
        try { window.location.href = 'fgame://claim-ev?step=' + encodeURIComponent(step); } catch (e) {}
      }
      function visible(el) {
        if (!el) return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      function clickText(texts) {
        var nodes = document.querySelectorAll('button');
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i], t = (n.innerText || n.textContent || '').trim().toLowerCase();
          if (t.indexOf('loading') >= 0) continue;
          for (var j = 0; j < texts.length; j++) {
            if (t.indexOf(texts[j]) >= 0 && visible(n)) { n.click(); return true; }
          }
        }
        return false;
      }
      function tick() {
        if (!ACTIVE) return;
        try {
          var txt = (document.body && document.body.innerText || '').toLowerCase();
          if (txt.indexOf('thanks for your order') >= 0) { ev('success'); ACTIVE = false; return; }
          if (txt.indexOf('captcha') >= 0 || txt.indexOf('challenge') >= 0) { ev('captcha'); ACTIVE = false; return; }
          var accepted = clickText(['i accept', 'accept']);
          if (accepted) { ev('accepted'); return; }
          var placed = clickText(['place order', 'complete order', 'buy now']);
          if (placed) { ev('placed'); }
        } catch (e) {}
        setTimeout(tick, 800);
      }
      setTimeout(tick, 900);
    })();
    """
}

struct FGameClaimOffer {
    let namespace: String
    let offerId: String
    let title: String
}

final class FGameClaimViewController: UIViewController, WKNavigationDelegate {
    private let offers: [FGameClaimOffer]
    private var webView: WKWebView!
    private var index = 0
    private var claimed: [String] = []
    // Titles already present in the user's Epic library ("already own" /
    // "in library"). These are NOT new orders but the game IS in the account,
    // so the app must still mark the deal 已领取 — otherwise a game the user
    // already owns stays stuck on 「限免 FREE」 after one-tap claim.
    private var owned: [String] = []
    private var failed: [String] = []
    private var finished = false
    private var checkoutFrame: WKFrameInfo?
    private var frameInjectTimer: Timer?

    init(offers: [FGameClaimOffer]) {
        self.offers = offers
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.043, green: 0.063, blue: 0.149, alpha: 1)

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        let top = WKUserScript(source: fgameClaimTopScript(), injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        config.userContentController.addUserScript(top)

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.allowsBackForwardNavigationGestures = true

        let bar = UIView()
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.backgroundColor = UIColor(red: 0.043, green: 0.063, blue: 0.149, alpha: 1)
        let title = UILabel()
        title.translatesAutoresizingMaskIntoConstraints = false
        title.text = "一键领取 Epic 游戏"
        title.textColor = .white
        title.font = .boldSystemFont(ofSize: 15)
        let progress = UILabel()
        progress.translatesAutoresizingMaskIntoConstraints = false
        progress.text = "准备中…"
        progress.textColor = UIColor(white: 0.75, alpha: 1)
        progress.font = .systemFont(ofSize: 12)
        progress.tag = 9101
        let close = UIButton(type: .system)
        close.translatesAutoresizingMaskIntoConstraints = false
        close.setTitle("结束", for: .normal)
        close.setTitleColor(.white, for: .normal)
        close.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
        close.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)

        view.addSubview(bar)
        bar.addSubview(title)
        bar.addSubview(progress)
        bar.addSubview(close)
        view.addSubview(webView)

        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bar.heightAnchor.constraint(equalToConstant: 52),
            title.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            title.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 18),
            progress.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 2),
            progress.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 18),
            close.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            close.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -18),
            webView.topAnchor.constraint(equalTo: bar.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        frameInjectTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self = self, let frame = self.checkoutFrame else { return }
            self.webView.evaluateJavaScript(fgameClaimFrameScript(), in: frame, in: .page, completionHandler: nil)
        }
        loadCurrentOffer()
    }

    private func setProgress(_ text: String) {
        if let p = view.viewWithTag(9101) as? UILabel { p.text = text }
    }

    private func loadCurrentOffer() {
        guard index < offers.count else { finish(); return }
        let offer = offers[index]
        setProgress("领取 \(index + 1)/\(offers.count)：\(offer.title)")
        let encoded = "1-\(offer.namespace)-\(offer.offerId)"
            .addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "1-\(offer.namespace)-\(offer.offerId)"
        if let url = URL(string: "https://store.epicgames.com/purchase?offers=\(encoded)") {
            webView.load(URLRequest(url: url))
        } else {
            failed.append(offer.title); index += 1; loadCurrentOffer()
        }
    }

    @objc private func closeTapped() { finish() }

    private func finish() {
        guard !finished else { return }
        finished = true
        frameInjectTimer?.invalidate()
        frameInjectTimer = nil
        NotificationCenter.default.post(
            name: .fgameClaimResult, object: nil,
            userInfo: ["ok": !failed.isEmpty || !claimed.isEmpty || !owned.isEmpty,
                       "claimed": claimed, "owned": owned, "failed": failed,
                       "total": offers.count]
        )
        dismiss(animated: true)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, url.scheme == "fgame", url.host == "claim-ev" {
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let step = items.first(where: { $0.name == "step" })?.value ?? ""
            if step == "success" {
                if index < offers.count { claimed.append(offers[index].title) }
                index += 1
                checkoutFrame = nil
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.loadCurrentOffer() }
            } else if step == "owned" {
                // Already in the user's Epic library — record it as owned so
                // the front end still marks the deal 已领取. Skipping without
                // recording is exactly why owned games never showed the badge.
                if index < offers.count { owned.append(offers[index].title) }
                index += 1
                checkoutFrame = nil
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.loadCurrentOffer() }
            }
            decisionHandler(.cancel)
            return
        }
        if let f = navigationAction.targetFrame, !f.isMainFrame,
           let u = navigationAction.request.url,
           u.absoluteString.contains("epicgames") {
            checkoutFrame = f
        }
        decisionHandler(.allow)
    }
}

// MARK: - Page base colour bridge
//
// The Capacitor web view is inset by the safe area, so the strip above the
// status bar and the strip below the home indicator are painted by the
// native window — they showed as pure white under the cream page. The page
// posts its own base colour (--bg) here and we repaint the window / web view
// with it, so both themes stay seamless. Web builds never call this.

final class FGameThemeHandler: NSObject, WKScriptMessageHandler {
    var onColor: ((UIColor) -> Void)?

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == "fgameTheme",
              let hex = message.body as? String,
              let color = UIColor(fgameHex: hex) else { return }
        onColor?(color)
    }
}

extension UIColor {
    /// "#fbf4e9" / "fbf4e9" -> colour. Returns nil for anything else.
    convenience init?(fgameHex: String) {
        var s = fgameHex.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(
            red: CGFloat((v >> 16) & 0xFF) / 255.0,
            green: CGFloat((v >> 8) & 0xFF) / 255.0,
            blue: CGFloat(v & 0xFF) / 255.0,
            alpha: 1.0
        )
    }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?
    private var themeHandler: FGameThemeHandler?
    private var themePoll: Timer?
    /// 贴在 WebView 后面的一块底色，盖住底部安全区。iOS 用 safe area 给
    /// WebView 做 contentInset，最底部那一条属于原生窗口：页面滚到底再
    /// 回弹时会把这条黑边拉出来（窗口默认色是黑）。这块 view 用页面底色
    /// 画在最底层，回弹时露出来的就是页面底色而不是黑边。
    private var bottomScrim: UIView?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        NotificationCenter.default.addObserver(
            forName: .fgameOAuthCode,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self = self else { return }
            let platform = note.userInfo?["platform"] as? String ?? "epic"
            let code = note.userInfo?["code"] as? String ?? ""
            guard !code.isEmpty else { return }
            let obj: [String: String] = ["platform": platform, "code": code]
            guard let data = try? JSONSerialization.data(withJSONObject: obj),
                  let b64 = data.base64EncodedString() as String? else { return }
            let js = "(function(){try{var d=JSON.parse(atob('\(b64)'));" +
                     "window.dispatchEvent(new CustomEvent('fgameOAuthCode',{detail:d}));}catch(e){}})();"
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                guard let root = self.window?.rootViewController?.view,
                      let web = fgameFindWebView(root) else { return }
                web.evaluateJavaScript(js, completionHandler: nil)
            }
        }
        // Forward one-tap claim results back to the page.
        NotificationCenter.default.addObserver(
            forName: .fgameClaimResult,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self = self else { return }
            let obj: [String: Any] = [
                "ok": note.userInfo?["ok"] as? Bool ?? false,
                "claimed": note.userInfo?["claimed"] as? [String] ?? [],
                "owned": note.userInfo?["owned"] as? [String] ?? [],
                "failed": note.userInfo?["failed"] as? [String] ?? [],
                "total": note.userInfo?["total"] as? Int ?? 0,
            ]
            guard let data = try? JSONSerialization.data(withJSONObject: obj),
                  let b64 = data.base64EncodedString() as String? else { return }
            let js = "(function(){try{var d=JSON.parse(atob('\(b64)'));" +
                     "window.dispatchEvent(new CustomEvent('fgameClaimResult',{detail:d}));}catch(e){}})();"
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                guard let root = self.window?.rootViewController?.view,
                      let web = fgameFindWebView(root) else { return }
                web.evaluateJavaScript(js, completionHandler: nil)
            }
        }
        return true
    }

    /// Registers the page-colour bridge on the Capacitor web view. Called on
    /// becoming active (the web view exists by then) with a few delayed
    /// retries, since the bridge must be in place before the page's first
    /// theme post.
    private func installThemeBridge() {
        guard let root = window?.rootViewController?.view,
              let web = fgameFindWebView(root) else { return }
        if themeHandler == nil {
            let handler = FGameThemeHandler()
            handler.onColor = { [weak self] color in
                guard let self = self,
                      let root = self.window?.rootViewController?.view,
                      let live = fgameFindWebView(root) else { return }
                self.paint(color, in: live)
            }
            web.configuration.userContentController.add(handler, name: "fgameTheme")
            web.isOpaque = false
            web.backgroundColor = .clear
            web.scrollView.backgroundColor = .clear
            // 关掉橡皮筋回弹：滚到列表尽头再上拉会把整页顶起来，露出
            // WebView 之外的窗口底色（黑边）。下拉刷新是自己用 touch
            // 事件实现的，不依赖系统 bounce。
            web.scrollView.bounces = false
            web.scrollView.alwaysBounceVertical = false
            web.scrollView.alwaysBounceHorizontal = false
            installBottomScrim(in: root)
            themeHandler = handler
        }
        startThemePoll()
    }

    private func paint(_ color: UIColor, in web: WKWebView) {
        window?.backgroundColor = color
        window?.rootViewController?.view.backgroundColor = color
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        bottomScrim?.backgroundColor = color
    }

    /// 一块铺满窗口底部 140pt 的底色层，插在 WebView 之下。
    private func installBottomScrim(in root: UIView) {
        if let scrim = bottomScrim, scrim.superview != nil {
            scrim.backgroundColor = window?.backgroundColor
            return
        }
        let scrim = UIView(frame: CGRect(x: 0, y: root.bounds.height - 140, width: root.bounds.width, height: 140))
        scrim.autoresizingMask = [.flexibleWidth, .flexibleTopMargin]
        scrim.isUserInteractionEnabled = false
        scrim.backgroundColor = window?.backgroundColor
        root.insertSubview(scrim, at: 0)
        bottomScrim = scrim
    }

    /// Every 1.5s, read the page's own --bg and match the window to it. This
    /// is the reliable path: a message handler added after the web view was
    /// created is not guaranteed to be registered, so the poll guarantees the
    /// strips around the inset web view follow the page in both themes.
    private func startThemePoll() {
        guard themePoll == nil else { return }
        syncWindowColor()
        themePoll = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            self?.syncWindowColor()
        }
    }

    private func syncWindowColor() {
        guard let root = window?.rootViewController?.view,
              let web = fgameFindWebView(root) else { return }
        web.evaluateJavaScript("getComputedStyle(document.documentElement).getPropertyValue('--bg')") { [weak self] value, _ in
            guard let self = self,
                  let hex = value as? String,
                  let color = UIColor(fgameHex: hex) else { return }
            DispatchQueue.main.async { self.paint(color, in: web) }
        }
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        installThemeBridge()
        for delay in [0.4, 1.2, 2.5] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.installThemeBridge()
            }
        }
    }

    func application(_ app: UIApplication, open url: URL,
                     options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // fgame://oauth?platform=epic&url=<percent-encoded official login URL>
        if url.scheme == "fgame", url.host == "oauth" {
            let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
            let items = comps?.queryItems ?? []
            let platform = items.first(where: { $0.name == "platform" })?.value ?? "epic"
            let target = items.first(where: { $0.name == "url" })?.value ?? ""
            if let targetURL = URL(string: target),
               ["https"].contains(targetURL.scheme?.lowercased() ?? "") {
                DispatchQueue.main.async {
                    let vc = FGAMEOAuthViewController(platform: platform, url: targetURL)
                    vc.modalPresentationStyle = .fullScreen
                    self.window?.rootViewController?.present(vc, animated: true)
                }
            }
            return true
        }
        // fgame://claim?payload=<base64 JSON of {offers:[{namespace,offerId,title}]}>
        if url.scheme == "fgame", url.host == "claim" {
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let payload = items.first(where: { $0.name == "payload" })?.value ?? ""
            var offers: [FGameClaimOffer] = []
            if let raw = payload.data(using: .utf8),
               let decoded = Data(base64Encoded: raw),
               let json = (try? JSONSerialization.jsonObject(with: decoded)) as? [String: Any],
               let arr = json["offers"] as? [[String: Any]] {
                for o in arr {
                    let ns = o["namespace"] as? String ?? ""
                    let oid = o["offerId"] as? String ?? ""
                    let t = o["title"] as? String ?? "游戏"
                    if !ns.isEmpty && !oid.isEmpty {
                        offers.append(FGameClaimOffer(namespace: ns, offerId: oid, title: t))
                    }
                }
            }
            if offers.isEmpty {
                NotificationCenter.default.post(
                    name: .fgameClaimResult, object: nil,
                    userInfo: ["ok": false, "claimed": [], "failed": [], "total": 0]
                )
            } else {
                DispatchQueue.main.async {
                    let vc = FGameClaimViewController(offers: offers)
                    vc.modalPresentationStyle = .fullScreen
                    self.window?.rootViewController?.present(vc, animated: true)
                }
            }
            return true
        }
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func applicationWillResignActive(_ application: UIApplication) {}
    func applicationDidEnterBackground(_ application: UIApplication) {}
    func applicationWillEnterForeground(_ application: UIApplication) {}
    func applicationWillTerminate(_ application: UIApplication) {}

    func application(_ application: UIApplication,
                     continue userActivity: NSUserActivity,
                     restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(
            application, continue: userActivity, restorationHandler: restorationHandler
        )
    }
}
