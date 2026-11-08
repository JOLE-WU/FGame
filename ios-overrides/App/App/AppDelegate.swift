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
      function report(code) {
        if (reported || !code || code.length < 8) return;
        reported = true;
        window.location.href = 'fgame://oauth-code?platform=' + encodeURIComponent(PLATFORM) +
          '&code=' + encodeURIComponent(code);
      }
      function check() {
        if (reported) return;
        try {
          var href = window.location.href || '';
          var body = (document.body && document.body.innerText) || '';
          // Epic: /id/api/redirect renders {"authorizationCode":"..."} as JSON text.
          if (href.indexOf('epicgames.com/id/api/redirect') !== -1) {
            var m = body.match(/"authorizationCode"\\s*:\\s*"([^"]+)"/) ||
                    body.match(/[?&]code=([^&\\s"]+)/);
            if (m && m[1]) { report(m[1]); return; }
          }
          // GOG: the success page URL carries ?code=...
          if (href.indexOf('on_login_success') !== -1 || href.indexOf('auth.gog.com') !== -1) {
            var g = href.match(/[?&]code=([^&]+)/);
            if (g && g[1]) { report(decodeURIComponent(g[1])); return; }
          }
          // Generic fallback: any page showing an authorizationCode blob.
          var any = body.match(/"authorizationCode"\\s*:\\s*"([^"]+)"/);
          if (any && any[1]) { report(any[1]); return; }
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

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

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
        return true
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
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func applicationWillResignActive(_ application: UIApplication) {}
    func applicationDidEnterBackground(_ application: UIApplication) {}
    func applicationWillEnterForeground(_ application: UIApplication) {}
    func applicationDidBecomeActive(_ application: UIApplication) {}
    func applicationWillTerminate(_ application: UIApplication) {}

    func application(_ application: UIApplication,
                     continue userActivity: NSUserActivity,
                     restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(
            application, continue: userActivity, restorationHandler: restorationHandler
        )
    }
}
