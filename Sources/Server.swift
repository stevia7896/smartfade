import Foundation
import Network

/// Loopback-only WebSocket server; the Spicetify extension sends transition schedules through it.
final class Server {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "smartfade.net")
    private var conns: [ObjectIdentifier: NWConnection] = [:]
    private let dsp: DSP
    var statusProvider: () -> [String: Any] = { [:] }

    init(port: UInt16, dsp: DSP) throws {
        self.dsp = dsp
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        ws.setClientRequestHandler(queue) { _, headers in
            // Only accept the Spotify client (or local tools without an Origin header)
            let origin = headers.first { $0.name.lowercased() == "origin" }?.value ?? ""
            let ok = origin.isEmpty || origin.contains("spotify.com") || origin.hasPrefix("https://xpui")
            if !ok { log("Rejected connection from \(origin)") }
            return NWProtocolWebSocket.Response(status: ok ? .accept : .reject, subprotocol: nil, additionalHeaders: nil)
        }
        let params = NWParameters.tcp
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        params.requiredInterfaceType = .loopback
        params.allowLocalEndpointReuse = true
        listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
    }

    func start() {
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready: log("WebSocket listening on 127.0.0.1:\(self.listener.port?.rawValue ?? 0)")
            case .failed(let e): log("✗ WebSocket listener failed: \(e)"); exit(2)
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] c in self?.accept(c) }
        listener.start(queue: queue)
    }

    private func accept(_ c: NWConnection) {
        let id = ObjectIdentifier(c)
        conns[id] = c
        c.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready: log("Extension connected (\(self?.conns.count ?? 0) total)"); self?.send(self?.statusProvider() ?? [:], to: c)
            case .failed, .cancelled: self?.conns.removeValue(forKey: id); log("Extension disconnected")
            default: break
            }
        }
        c.start(queue: queue)
        receive(c)
    }

    private func receive(_ c: NWConnection) {
        c.receiveMessage { [weak self] data, ctx, _, err in
            if let data, !data.isEmpty,
               let meta = ctx?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata,
               meta.opcode == .text {
                self?.handle(data, from: c)
            }
            if err == nil { self?.receive(c) } else { c.cancel() }
        }
    }

    func broadcastStatus() {
        queue.async { let s = self.statusProvider(); for c in self.conns.values { self.send(s, to: c) } }
    }

    private func send(_ obj: [String: Any], to c: NWConnection) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        let meta = NWProtocolWebSocket.Metadata(opcode: .text)
        let ctx = NWConnection.ContentContext(identifier: "msg", metadata: [meta])
        c.send(content: data, contentContext: ctx, isComplete: true, completion: .idempotent)
    }

    private func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }

    private func handle(_ data: Data, from c: NWConnection) {
        guard let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = msg["type"] as? String else { return }
        switch type {
        case "hello", "status":
            send(statusProvider(), to: c)
        case "reset":
            dsp.enqueue(reset: num(msg["dur"]) ?? 250, ramps: [], jumps: [], commitMs: nil, delayMs: nil,
                        feedback: nil, watchdogMs: 0, onsetTimeoutMs: nil)
            log("reset \(msg["reason"] as? String ?? "")")
        case "schedule":
            var ramps: [RampSpec] = []
            for r in (msg["ramps"] as? [[String: Any]]) ?? [] {
                // p looks like "out.gain" / "in.hp" / "send"
                let parts = (r["p"] as? String ?? "").split(separator: ".").map(String.init)
                let role = parts.first == "in" ? 1 : 0
                let kinds: [String: Kind] = ["gain": .gain, "lp": .lp, "hp": .hp, "rate": .rate, "send": .send]
                guard let kind = kinds[parts.last ?? ""], let to = num(r["to"]) else { continue }
                let curve = ["sin": 1, "cos": 2][r["curve"] as? String ?? ""] ?? 0
                ramps.append(RampSpec(kind: kind, role: role, to: to, atMs: num(r["at"]) ?? 0, durMs: num(r["dur"]) ?? 0,
                                      onset: (r["anchor"] as? String) == "onset", curve: curve))
            }
            var jumps: [JumpSpec] = []
            for j in (msg["jumps"] as? [[String: Any]]) ?? [] {
                guard let d = num(j["delayMs"]) else { continue }
                jumps.append(JumpSpec(atMs: num(j["at"]) ?? 0, delayMs: d, role: (j["voice"] as? String) == "in" ? 1 : 0))
            }
            var align: AlignSpec? = nil
            if let al = msg["align"] as? [String: Any], let pa = num(al["periodA"]), let pb = num(al["periodB"]),
               let po = num(al["periodOut"]) {
                align = AlignSpec(periodA: pa, periodB: pb, periodOut: po, bFirst: num(al["bFirst"]) ?? 0)
            }
            dsp.enqueue(reset: (msg["reset"] as? Bool == true) ? 30 : nil, ramps: ramps, jumps: jumps,
                        commitMs: num(msg["commitAt"]), delayMs: num(msg["delayMs"]), feedback: num(msg["feedback"]),
                        watchdogMs: num(msg["watchdogMs"]), onsetTimeoutMs: num(msg["onsetTimeoutMs"]), align: align)
            var info = "schedule \(msg["label"] as? String ?? "") ramps=\(ramps.count) jumps=\(jumps.count)"
            if let a = align { info += String(format: " align(A %.3fs → out %.3fs, B %.3fs, first beat %+.3fs)", a.periodA, a.periodOut, a.periodB, a.bFirst) }
            if let note = msg["note"] as? String { info += " " + note }
            log(info)
        default:
            break
        }
    }
}
