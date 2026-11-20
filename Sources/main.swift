// SmartFade: taps Spotify's audio and renders transitions scheduled by the Spicetify extension.
import Foundation
import CoreAudio

setvbuf(stdout, nil, _IOLBF, 0)
log("SmartFade \(smartFadeVersion) started")

let dsp = DSP()
let pipeline = Pipeline(dsp: dsp)
let server: Server
do { server = try Server(port: 17890, dsp: dsp) } catch { log("✗ Cannot create WebSocket server: \(error)"); exit(2) }

server.statusProvider = {
    ["type": "status", "version": smartFadeVersion, "tapping": pipeline.running,
     "output": pipeline.outName, "sampleRate": dsp.sr, "features": ["overlap", "beatmatch", "keylock"]]
}
server.start()

/// Every 2 s: re-tap if Spotify restarted or the default output device changed
var waitingLogged = false
func reconcile() {
    let procs = spotifyProcesses()
    let out = defaultOutputDevice() ?? 0
    if procs == pipeline.procs && out == pipeline.outDev && (pipeline.running || procs.isEmpty) { return }
    if procs.isEmpty || out == 0 {
        if pipeline.running { pipeline.stop(); log("Spotify quit — processing paused"); server.broadcastStatus() }
        if !waitingLogged { log("Waiting for Spotify…"); waitingLogged = true }
        return
    }
    waitingLogged = false
    if pipeline.start(procs: procs, output: out) { server.broadcastStatus() }
}
reconcile()
let monitor = DispatchSource.makeTimerSource(queue: .main)
monitor.schedule(deadline: .now() + 2, repeating: 2)
monitor.setEventHandler { reconcile() }
monitor.resume()

// Audio-thread events → log
let eventTimer = DispatchSource.makeTimerSource(queue: .main)
eventTimer.schedule(deadline: .now() + 0.25, repeating: 0.25)
eventTimer.setEventHandler {
    dsp.drainEvents { code, a, b in
        switch code {
        case 1: log(String(format: "↺ Replay: planned %.1f ms, refined to %.1f ms (%+.1f ms)", a, b, b - a))
        case 2: log(b > 0 ? String(format: "▶ Incoming onset, delayed %.0f ms to land on the beat", a) : "▶ Incoming onset (no beat alignment)")
        case 3: log(String(format: "♩ Outgoing beat grid: confidence %.2f, on/off-beat ratio %.2f%@", a, b, (a >= 1.4 && b >= 1.15) ? "" : " → unreliable, tempo match only"))
        case 4: log(String(format: "⟲ Measured beat offset %+.1f ms (confidence %.2f)%@", a, b, abs(a) > 8 ? " — nudging outgoing tempo" : " — no correction needed"))
        case 8:
            let why = ["", "outgoing track almost done", "low confidence", "on/off-beat ambiguous", String(format: "offset %+.0f ms too large, likely an off-beat", a)][min(4, Int(b))]
            log("⟲ Phase correction skipped: \(why)")
        case 10: log(String(format: "↺ Replay refinement unreliable (best %+.0f ms at edge or weak), keeping planned %.1f ms", b, a))
        case 5: log(String(format: "✓ Transition committed, residual delay %.0f ms (draining)", a))
        case 6: log(String(format: "Reset (%.0f ms)", a))
        case 7: log("⚠️ Watchdog fired — back to passthrough")
        default: break
        }
    }
}
eventTimer.resume()

var signalSources: [DispatchSourceSignal] = []
for sig in [SIGINT, SIGTERM, SIGHUP] {
    signal(sig, SIG_IGN)
    let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    s.setEventHandler { pipeline.stop(); log("Exited — Spotify audio restored"); exit(0) }
    s.resume(); signalSources.append(s)
}

dispatchMain()
