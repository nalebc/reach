import AVFoundation
import Capacitor
import UIKit
import WebKit

/// Registers Reach's local plugins with the Capacitor bridge.
class ReachBridgeViewController: CAPBridgeViewController {
    private var recovery: PageRecovery?

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(QRScannerPlugin())
        bridge?.registerPluginInstance(RemoteKeyboardPlugin())
        bridge?.registerPluginInstance(BackgroundTransferPlugin())
    }

    override open func viewDidLoad() {
        super.viewDidLoad()
        if let webView, let home = bridge?.config.serverURL {
            recovery = PageRecovery(webView: webView, home: home)
        }
    }
}

/// Reach's page, back on its own after it's gone. iOS ends a web page's
/// process to free memory while the app sits idle; Capacitor reloads it then,
/// and a reload that found no network (the phone asleep or still waking) left
/// a blank white page until the app was closed and opened again (Oct 26).
/// While the app is in front, a page with nothing in it is opened again at
/// Reach's own link, "Reconnecting…" showing in place of the blank: soon at
/// first, then every 15 s. A page that loads, or is loading, is left alone.
final class PageRecovery {
    private weak var webView: WKWebView?
    private let home: URL
    private let cover = UIView()
    private var timer: Timer?
    private var loading: NSKeyValueObservation?
    private var tries = 0
    // An unanswered look happens mid-navigation too: only twice in a row
    // counts as no page.
    private var unanswered = 0
    private var asking = false

    init(webView: WKWebView, home: URL) {
        self.webView = webView
        self.home = home
        cover.backgroundColor = UIColor(red: 0x10 / 255, green: 0x15 / 255, blue: 0x12 / 255, alpha: 1)
        cover.isHidden = true
        cover.isUserInteractionEnabled = false
        cover.translatesAutoresizingMaskIntoConstraints = false
        let words = UILabel()
        words.text = "Reconnecting to your computer…"
        words.textColor = UIColor(red: 0xed / 255, green: 0xf2 / 255, blue: 0xee / 255, alpha: 1)
        words.font = .preferredFont(forTextStyle: .headline)
        words.translatesAutoresizingMaskIntoConstraints = false
        cover.addSubview(words)
        webView.addSubview(cover)
        NSLayoutConstraint.activate([
            cover.topAnchor.constraint(equalTo: webView.topAnchor),
            cover.bottomAnchor.constraint(equalTo: webView.bottomAnchor),
            cover.leadingAnchor.constraint(equalTo: webView.leadingAnchor),
            cover.trailingAnchor.constraint(equalTo: webView.trailingAnchor),
            words.centerXAnchor.constraint(equalTo: cover.centerXAnchor),
            words.centerYAnchor.constraint(equalTo: cover.centerYAnchor),
        ])
        NotificationCenter.default.addObserver(self, selector: #selector(inFront), name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(putAway), name: UIApplication.didEnterBackgroundNotification, object: nil)
        // A load just ended: the cover goes as soon as there's a page under
        // it. Only the timer ever opens the page again.
        loading = webView.observe(\.isLoading) { [weak self] view, _ in
            guard !view.isLoading else { return }
            DispatchQueue.main.async { self?.look(opening: false) }
        }
        look(after: 5)
    }

    deinit {
        timer?.invalidate()
        loading?.invalidate()
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func inFront() { look(after: 1) }
    @objc private func putAway() {
        timer?.invalidate()
        timer = nil
    }

    private func look(after seconds: TimeInterval) {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in self?.look() }
    }

    private func look(opening: Bool = true) {
        guard let webView, UIApplication.shared.applicationState == .active else { return }
        if webView.isLoading {
            if opening { look(after: 2) }
            return
        }
        if opening {
            // The last look never came back: a page that doesn't answer.
            if asking { unanswered += 1 }
            if unanswered >= 2 { return open(webView) }
            asking = true
            look(after: 15)
        }
        webView.evaluateJavaScript("document.body ? document.body.childElementCount : 0") { [weak self] result, error in
            guard let self else { return }
            let url = webView.url?.absoluteString ?? ""
            let empty = url.isEmpty || url == "about:blank" || (error == nil && (result as? NSNumber)?.intValue == 0)
            if !opening {
                if !empty && error == nil { self.cover.isHidden = true }
                return
            }
            self.asking = false
            if error != nil { self.unanswered += 1 } else { self.unanswered = 0 }
            if empty || self.unanswered >= 2 { return self.open(webView) }
            self.cover.isHidden = true
            self.tries = 0
            self.look(after: 10)
        }
    }

    // Reach's own link again, the blank covered while it loads.
    private func open(_ webView: WKWebView) {
        cover.isHidden = false
        webView.bringSubviewToFront(cover)
        tries += 1
        unanswered = 0
        asking = false
        webView.load(URLRequest(url: home))
        look(after: min(15, 2 * Double(tries)))
    }
}

/// `QRScanner.scan()` presents a full-screen camera and resolves with the first Reach code it sees.
@objc(QRScannerPlugin)
public class QRScannerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "QRScannerPlugin"
    public let jsName = "QRScanner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise)
    ]

    @objc func scan(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else {
                call.reject("The camera is not available right now.")
                return
            }
            let scanner = ScannerViewController()
            scanner.modalPresentationStyle = .fullScreen
            scanner.onFinish = { value in
                if let value { call.resolve(["value": value]) } else { call.reject("Scan cancelled", "CANCELLED") }
            }
            presenter.present(scanner, animated: true)
        }
    }
}

final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onFinish: ((String?) -> Void)?
    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?
    private let frameView = UIView()
    private let scanLine = UIView()
    private let hint = UILabel()
    private let dim = CAShapeLayer()
    private var finished = false
    private let lime = UIColor(red: 0.725, green: 0.961, blue: 0.408, alpha: 1)

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        buildOverlay()
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: startCamera()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async { granted ? self.startCamera() : self.showDenied() }
            }
        default: showDenied()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
        let side = min(view.bounds.width - 80, 280)
        let rect = CGRect(x: (view.bounds.width - side) / 2, y: view.bounds.height * 0.42 - side / 2, width: side, height: side)
        frameView.frame = rect
        let path = UIBezierPath(rect: view.bounds)
        path.append(UIBezierPath(roundedRect: rect, cornerRadius: 28).reversing())
        dim.path = path.cgPath
        dim.frame = view.bounds
        drawCorners(in: frameView.bounds)
        scanLine.frame = CGRect(x: 18, y: 18, width: side - 36, height: 2)
        startScanLine(height: side)
    }

    private func buildOverlay() {
        dim.fillColor = UIColor(white: 0, alpha: 0.62).cgColor
        view.layer.addSublayer(dim)
        view.addSubview(frameView)
        scanLine.backgroundColor = lime
        scanLine.layer.shadowColor = lime.cgColor
        scanLine.layer.shadowRadius = 8
        scanLine.layer.shadowOpacity = 1
        scanLine.layer.shadowOffset = .zero
        frameView.addSubview(scanLine)

        let title = UILabel()
        title.text = "Scan to connect"
        title.font = .systemFont(ofSize: 26, weight: .semibold)
        title.textColor = .white
        hint.text = "Point at the code shown by Reach on your computer."
        hint.font = .systemFont(ofSize: 15)
        hint.textColor = UIColor(white: 1, alpha: 0.72)
        hint.numberOfLines = 0
        hint.textAlignment = .center
        let close = UIButton(type: .system)
        close.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold)), for: .normal)
        close.tintColor = .white
        close.backgroundColor = UIColor(white: 1, alpha: 0.16)
        close.layer.cornerRadius = 22
        close.accessibilityLabel = "Cancel"
        close.addTarget(self, action: #selector(cancel), for: .touchUpInside)
        for v in [title, hint, close] as [UIView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(v)
        }
        NSLayoutConstraint.activate([
            close.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            close.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
            close.widthAnchor.constraint(equalToConstant: 44),
            close.heightAnchor.constraint(equalToConstant: 44),
            title.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            title.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 70),
            hint.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            hint.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 40),
            hint.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -60),
        ])
    }

    private func drawCorners(in bounds: CGRect) {
        frameView.layer.sublayers?.filter { $0.name == "corner" }.forEach { $0.removeFromSuperlayer() }
        let length: CGFloat = 38, r: CGFloat = 28
        let path = UIBezierPath()
        let (w, h) = (bounds.width, bounds.height)
        path.move(to: CGPoint(x: 0, y: length)); path.addLine(to: CGPoint(x: 0, y: r))
        path.addArc(withCenter: CGPoint(x: r, y: r), radius: r, startAngle: .pi, endAngle: 1.5 * .pi, clockwise: true)
        path.addLine(to: CGPoint(x: length, y: 0))
        path.move(to: CGPoint(x: w - length, y: 0)); path.addLine(to: CGPoint(x: w - r, y: 0))
        path.addArc(withCenter: CGPoint(x: w - r, y: r), radius: r, startAngle: 1.5 * .pi, endAngle: 0, clockwise: true)
        path.addLine(to: CGPoint(x: w, y: length))
        path.move(to: CGPoint(x: w, y: h - length)); path.addLine(to: CGPoint(x: w, y: h - r))
        path.addArc(withCenter: CGPoint(x: w - r, y: h - r), radius: r, startAngle: 0, endAngle: 0.5 * .pi, clockwise: true)
        path.addLine(to: CGPoint(x: w - length, y: h))
        path.move(to: CGPoint(x: length, y: h)); path.addLine(to: CGPoint(x: r, y: h))
        path.addArc(withCenter: CGPoint(x: r, y: h - r), radius: r, startAngle: 0.5 * .pi, endAngle: .pi, clockwise: true)
        path.addLine(to: CGPoint(x: 0, y: h - length))
        let corners = CAShapeLayer()
        corners.name = "corner"
        corners.path = path.cgPath
        corners.strokeColor = lime.cgColor
        corners.fillColor = UIColor.clear.cgColor
        corners.lineWidth = 5
        corners.lineCap = .round
        corners.shadowColor = lime.cgColor
        corners.shadowRadius = 10
        corners.shadowOpacity = 0.8
        corners.shadowOffset = .zero
        frameView.layer.addSublayer(corners)
    }

    private func startScanLine(height: CGFloat) {
        scanLine.layer.removeAnimation(forKey: "scan")
        guard !UIAccessibility.isReduceMotionEnabled else { return }
        let move = CABasicAnimation(keyPath: "position.y")
        move.fromValue = 20
        move.toValue = height - 20
        move.duration = 1.8
        move.autoreverses = true
        move.repeatCount = .infinity
        move.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        scanLine.layer.add(move, forKey: "scan")
    }

    private func startCamera() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return showDenied() }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return showDenied() }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.insertSublayer(layer, at: 0)
        preview = layer
        DispatchQueue.global(qos: .userInitiated).async { self.session.startRunning() }
    }

    private func showDenied() {
        hint.text = "Reach needs the camera to scan the pairing code. Allow Camera in Settings, or enter the code manually."
        let open = UIButton(type: .system)
        open.setTitle("Open Settings", for: .normal)
        open.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        open.setTitleColor(UIColor(red: 0.1, green: 0.15, blue: 0.06, alpha: 1), for: .normal)
        open.backgroundColor = lime
        open.layer.cornerRadius = 14
        open.translatesAutoresizingMaskIntoConstraints = false
        open.addTarget(self, action: #selector(openSettings), for: .touchUpInside)
        view.addSubview(open)
        NSLayoutConstraint.activate([
            open.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            open.bottomAnchor.constraint(equalTo: hint.topAnchor, constant: -20),
            open.widthAnchor.constraint(equalToConstant: 200),
            open.heightAnchor.constraint(equalToConstant: 50),
        ])
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !finished,
              let code = objects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first
        else { return }
        let url = URLComponents(string: code)
        let isReachLink = url?.scheme == "reach" && ["pair", "connect"].contains(url?.host ?? "")
        let isPrivateAddress = url?.scheme == "https" && (url?.host?.hasSuffix(".ts.net") ?? false)
            && url?.user == nil && url?.password == nil && (url?.path.isEmpty == true || url?.path == "/")
            && url?.query == nil && url?.fragment == nil
        guard isReachLink || isPrivateAddress else {
            hint.text = "That isn’t a Reach code. Scan the code shown by Reach on your computer."
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
            return
        }
        finished = true
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        scanLine.isHidden = true
        UIView.animate(withDuration: 0.18, animations: {
            self.frameView.transform = CGAffineTransform(scaleX: 1.06, y: 1.06)
            self.frameView.backgroundColor = self.lime.withAlphaComponent(0.25)
        }) { _ in
            self.finish(code)
        }
    }

    @objc private func cancel() { finish(nil) }

    @objc private func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }

    private func finish(_ value: String?) {
        session.stopRunning()
        let done = onFinish
        onFinish = nil
        dismiss(animated: true) { done?(value) }
    }
}
