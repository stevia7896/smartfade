import Foundation
import os
import CoreAudio

// ───────────────────────────────────────────────────────────────────────────
// SmartFade DSP
//
//  input (Spotify) ─► 32 s ring buffer + onset envelope ─┬─► voice 0: read head (WSOLA, variable rate) → LP → HP → gain ─┐
//                                                        └─► voice 1: read head (WSOLA, variable rate) → LP → HP → gain ─┴─► + echo → output
//
//  Transition:
//   1. drift  – the outgoing voice slows slightly (pitch preserved), so it falls behind the live input
//   2. match  – it eases onto the incoming track's tempo
//   3. cut    – the outgoing beat phase is measured from the onset envelope; when the incoming track
//               starts, it is delayed by δ (< 1 beat) so the beats line up
//   4. PLL    – a few beats later the incoming beats are measured and any error is absorbed by nudging the outgoing rate
//   5. commit – voices swap; the incoming voice's residual delay drains slowly
// ───────────────────────────────────────────────────────────────────────────

enum Kind: Int { case gain = 0, lp, hp, rate, send }

struct RampSpec {
    var kind: Kind
    var role: Int        // 0 = out (active voice), 1 = in (the other)
    var to: Double
    var atMs: Double
    var durMs: Double
    var onset: Bool
    var curve: Int       // 0 default, 1 = sin, 2 = 1-cos
}
struct JumpSpec { var atMs: Double; var delayMs: Double; var role: Int }
/// Seconds: outgoing beat, incoming beat, output beat used for alignment, incoming first beat relative to first sound
struct AlignSpec { var periodA: Double; var periodB: Double; var periodOut: Double; var bFirst: Double }

private struct Ramp {
    var param = 0, to = 0.0
    var startFrame: Int64 = 0, durFrames: Int64 = 1
    var onset = false, curve = 0, started = false, from = 0.0, dead = false
}
private struct PendingRamp { var kind = 0, role = 0; var to = 0.0, atMs = 0.0, durMs = 0.0; var onset = false; var curve = 0 }
private struct PendingJump { var atMs = 0.0, delayMs = 0.0; var role = 0 }
private struct Jump { var frame: Int64 = 0; var delay = 0.0; var voice = 0 }
private struct Voice { var pos = 0.0, oldPos = 0.0; var xf = 0; var endFrame = Int64.max }
private struct Event { var code: Int32 = 0; var a = 0.0, b = 0.0 }

private struct Biquad {
    var b0 = 1.0, b1 = 0.0, b2 = 0.0, a1 = 0.0, a2 = 0.0
    static func lowpass(_ fc: Double, _ sr: Double, q: Double) -> Biquad {
        let w = 2 * Double.pi * min(max(fc, 20), sr * 0.45) / sr, c = cos(w), al = sin(w) / (2 * q), a0 = 1 + al
        return Biquad(b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: -2 * c / a0, a2: (1 - al) / a0)
    }
    static func highpass(_ fc: Double, _ sr: Double, q: Double) -> Biquad {
        let w = 2 * Double.pi * min(max(fc, 5), sr * 0.45) / sr, c = cos(w), al = sin(w) / (2 * q), a0 = 1 + al
        return Biquad(b0: (1 + c) / 2 / a0, b1: -(1 + c) / a0, b2: (1 + c) / 2 / a0, a1: -2 * c / a0, a2: (1 - al) / a0)
    }
}

final class DSP {
    private(set) var sr: Double = 48000
    private var now: Int64 = 0

    // Params: 0 = send; voice v gain/lp/hp/rate = 1 + v*4 + {0,1,2,3}
    private static let nParams = 9
    private let vals = UnsafeMutablePointer<Double>.allocate(capacity: DSP.nParams)
    @inline(__always) private func pidx(_ kind: Int, _ voice: Int) -> Int { kind == Kind.send.rawValue ? 0 : 1 + voice * 4 + kind }
    private func neutral(_ p: Int) -> Double {
        if p == 0 { return 0 }
        switch (p - 1) % 4 { case 0: return (p - 1) / 4 == active ? 1 : 0; case 1: return 22000; case 2: return 10; default: return 1 }
    }
    private func isFreq(_ p: Int) -> Bool { p != 0 && ((p - 1) % 4 == 1 || (p - 1) % 4 == 2) }

    private(set) var active = 0

    // Ring buffer
    private var ringLen = 0
    private var ring: UnsafeMutablePointer<Float>
    private let voices = UnsafeMutablePointer<Voice>.allocate(capacity: 2)
    private var xfLen = 960
    private let fz = UnsafeMutablePointer<Double>.allocate(capacity: 16)
    private var lpC: (Biquad, Biquad) = (Biquad(), Biquad())
    private var hpC: (Biquad, Biquad) = (Biquad(), Biquad())

    // Onset envelope (one value per H frames)
    private let H = 256
    private var envCap = 0
    private var env: UnsafeMutablePointer<Float>
    private var hopIdx = 0
    private var hopAcc: Float = 0, hopCount = 0, ePrev: Float = -9, prevMono: Float = 0
    private let scratch = UnsafeMutablePointer<Double>.allocate(capacity: 1024)

    // Scheduling
    private let schedCap = 128
    private let sched: UnsafeMutablePointer<Ramp>
    private var schedCount = 0
    private let jumpCap = 16
    private let jumps: UnsafeMutablePointer<Jump>
    private var jumpCount = 0
    private var commitFrame: Int64 = 0
    private var onsetArmed = false
    private var onsetDeadline: Int64 = 0
    private var watchdogFrame: Int64 = 0

    // Beat alignment
    private var alignOn = false
    private var periodA = 0.0, periodB = 0.0, periodOut = 0.0, bFirst = 0.0   // frames
    private var gridA = 0.0
    private var onsetFrameB: Int64 = 0
    private var pllFrame: Int64 = 0
    private var drain = false

    // Inbox (network thread → audio thread)
    private let lock: UnsafeMutablePointer<os_unfair_lock>
    private let inboxCap = 128
    private let inbox: UnsafeMutablePointer<PendingRamp>
    private var inboxCount = 0
    private let jinbox: UnsafeMutablePointer<PendingJump>
    private var jinboxCount = 0
    private var pendingReset = -1.0, pendingDelayMs = -1.0, pendingFeedback = -1.0
    private var pendingWatchdogMs = -1.0, pendingOnsetTimeoutMs = -1.0, pendingCommitMs = -1.0
    private var pendingAlign = AlignSpec(periodA: 0, periodB: 0, periodOut: 0, bFirst: 0)
    private var hasPendingAlign = false

    // Events (audio thread → log)
    private let evLock: UnsafeMutablePointer<os_unfair_lock>
    private let evCap = 64
    private let events: UnsafeMutablePointer<Event>
    private var evCount = 0

    // Echo
    private var delayBuf: UnsafeMutablePointer<Float>
    private var echoCap = 0, echoLen = 1, echoIdx = 0
    private var feedback: Float = 0.5
    private var fbState: (Float, Float) = (0, 0)
    private var fbCoef: Float = 0.3

    // WSOLA (pitch-preserving rate change): segments are spliced where the waveform matches best within ±S
    private var wsN = 3360, wsHs = 2880, wsO = 480, wsS = 576, wsM = 1024, wsL = 3937
    private var wsWin = UnsafeMutablePointer<Float>.allocate(capacity: 1)
    private var wsAcc = UnsafeMutablePointer<Float>.allocate(capacity: 1)     // [voice][ch][N]
    private var wsNat = UnsafeMutablePointer<Float>.allocate(capacity: 1)
    private var wsCand = UnsafeMutablePointer<Float>.allocate(capacity: 1)
    private var wsIdx = (0, 0), wsHop = (0, 0)
    private var wsPrevA: (Int64, Int64) = (0, 0)
    private var wsHasPrev = (false, false)

    var currentLagMs: Double { (Double(now) - voices[active].pos) / sr * 1000 }

    init() {
        sched = .allocate(capacity: schedCap); sched.initialize(repeating: Ramp(), count: schedCap)
        jumps = .allocate(capacity: jumpCap); jumps.initialize(repeating: Jump(), count: jumpCap)
        inbox = .allocate(capacity: inboxCap); inbox.initialize(repeating: PendingRamp(), count: inboxCap)
        jinbox = .allocate(capacity: jumpCap); jinbox.initialize(repeating: PendingJump(), count: jumpCap)
        events = .allocate(capacity: evCap); events.initialize(repeating: Event(), count: evCap)
        lock = .allocate(capacity: 1); lock.initialize(to: os_unfair_lock())
        evLock = .allocate(capacity: 1); evLock.initialize(to: os_unfair_lock())
        voices.initialize(repeating: Voice(), count: 2)
        ring = .allocate(capacity: 2); env = .allocate(capacity: 2); delayBuf = .allocate(capacity: 2)
        configure(sampleRate: 48000)
    }

    /// Only call while audio IO is stopped
    func configure(sampleRate: Double) {
        sr = sampleRate
        now = 0; active = 0
        for p in 0..<DSP.nParams { vals[p] = neutral(p) }
        fz.initialize(repeating: 0, count: 16)
        lpC = (.lowpass(22000, sr, q: 0.9), .lowpass(22000, sr, q: 0.9))
        hpC = (.highpass(10, sr, q: 0.707), .highpass(10, sr, q: 0.707))
        ring.deallocate(); ringLen = Int(sr * 32)
        ring = .allocate(capacity: ringLen * 2); ring.initialize(repeating: 0, count: ringLen * 2)
        voices[0] = Voice(); voices[1] = Voice()
        xfLen = Int(sr * 0.02)
        // SoundTouch-style: play 60 ms segments untouched and crossfade only 10 ms at each splice,
        // placed where the waveform matches best within ±12 ms. Most of the time the output is a single
        // unaltered copy of the input, so there is no chorusing or buzz from stacked overlaps.
        wsHs = Int(sr * 0.060); wsO = Int(sr * 0.010); wsN = wsHs + wsO; wsS = Int(sr * 0.012)
        wsM = Int(sr * 0.021); wsL = wsN + wsS + 1
        wsWin.deallocate(); wsWin = .allocate(capacity: wsN)
        for i in 0..<wsN {
            let w: Double
            if i < wsO { w = pow(sin(Double.pi / 2 * Double(i) / Double(wsO)), 2) }
            else if i < wsHs { w = 1 }
            else { w = pow(cos(Double.pi / 2 * Double(i - wsHs) / Double(wsO)), 2) }
            wsWin[i] = Float(w)
        }
        wsAcc.deallocate(); wsAcc = .allocate(capacity: 4 * wsN); wsAcc.initialize(repeating: 0, count: 4 * wsN)
        let M = wsM
        wsNat.deallocate(); wsNat = .allocate(capacity: M); wsNat.initialize(repeating: 0, count: M)
        wsCand.deallocate(); wsCand = .allocate(capacity: M + 2 * wsS + 1); wsCand.initialize(repeating: 0, count: M + 2 * wsS + 1)
        wsIdx = (0, 0); wsHop = (0, 0); wsPrevA = (0, 0); wsHasPrev = (false, false)
        env.deallocate(); envCap = ringLen / H + 1
        env = .allocate(capacity: envCap); env.initialize(repeating: 0, count: envCap)
        hopIdx = 0; hopAcc = 0; hopCount = 0; ePrev = -9; prevMono = 0
        delayBuf.deallocate(); echoCap = Int(sr * 2.0) + 1
        delayBuf = .allocate(capacity: echoCap * 2); delayBuf.initialize(repeating: 0, count: echoCap * 2)
        echoLen = Int(sr * 0.5); echoIdx = 0; fbState = (0, 0)
        fbCoef = Float(1 - exp(-2 * Double.pi * 3500 / sr))
        schedCount = 0; jumpCount = 0; commitFrame = 0; onsetArmed = false; watchdogFrame = 0
        alignOn = false; pllFrame = 0; drain = false
    }

    // MARK: Network-thread API
    func enqueue(reset: Double?, ramps: [RampSpec], jumps js: [JumpSpec], commitMs: Double?, delayMs: Double?,
                 feedback fb: Double?, watchdogMs: Double?, onsetTimeoutMs: Double?, align: AlignSpec? = nil) {
        os_unfair_lock_lock(lock)
        if let r = reset { inboxCount = 0; jinboxCount = 0; pendingCommitMs = -1; hasPendingAlign = false; pendingReset = max(r, 1) }
        for s in ramps where inboxCount < inboxCap {
            inbox[inboxCount] = PendingRamp(kind: s.kind.rawValue, role: s.role, to: s.to, atMs: s.atMs, durMs: s.durMs, onset: s.onset, curve: s.curve)
            inboxCount += 1
        }
        for j in js where jinboxCount < jumpCap { jinbox[jinboxCount] = PendingJump(atMs: j.atMs, delayMs: j.delayMs, role: j.role); jinboxCount += 1 }
        if let c = commitMs { pendingCommitMs = c }
        if let d = delayMs { pendingDelayMs = d }
        if let f = fb { pendingFeedback = f }
        if let w = watchdogMs { pendingWatchdogMs = w }
        if let o = onsetTimeoutMs { pendingOnsetTimeoutMs = o }
        if let a = align { pendingAlign = a; hasPendingAlign = true }
        os_unfair_lock_unlock(lock)
    }

    /// Called periodically on the main thread to collect audio-thread events
    func drainEvents(_ handle: (Int32, Double, Double) -> Void) {
        os_unfair_lock_lock(evLock)
        var copy: [Event] = []
        for i in 0..<evCount { copy.append(events[i]) }
        evCount = 0
        os_unfair_lock_unlock(evLock)
        for e in copy { handle(e.code, e.a, e.b) }
    }

    // MARK: Audio thread
    private func emit(_ code: Int32, _ a: Double = 0, _ b: Double = 0) {
        guard os_unfair_lock_trylock(evLock) else { return }
        if evCount < evCap { events[evCount] = Event(code: code, a: a, b: b); evCount += 1 }
        os_unfair_lock_unlock(evLock)
    }
    @inline(__always) private func frames(_ ms: Double) -> Int64 { Int64(ms / 1000 * sr) }
    @inline(__always) private func ms(_ frames: Double) -> Double { frames / sr * 1000 }

    private func pickup() {
        guard os_unfair_lock_trylock(lock) else { return }
        defer { os_unfair_lock_unlock(lock) }
        if pendingReset >= 0 { reset(ms: pendingReset); pendingReset = -1 }
        var anyOnset = false
        for i in 0..<inboxCount where schedCount < schedCap {
            let r = inbox[i]
            let voice = r.role == 0 ? active : 1 - active
            let off = frames(r.atMs)
            sched[schedCount] = Ramp(param: pidx(r.kind, voice), to: r.to, startFrame: r.onset ? max(0, off) : now + off,
                                     durFrames: max(1, frames(r.durMs)), onset: r.onset, curve: r.curve)
            schedCount += 1
            anyOnset = anyOnset || r.onset
        }
        inboxCount = 0
        for i in 0..<jinboxCount where jumpCount < jumpCap {
            let j = jinbox[i]
            jumps[jumpCount] = Jump(frame: now + frames(j.atMs), delay: j.delayMs / 1000 * sr, voice: j.role == 0 ? active : 1 - active)
            jumpCount += 1
        }
        jinboxCount = 0
        if pendingCommitMs >= 0 { commitFrame = now + frames(pendingCommitMs); pendingCommitMs = -1 }
        if hasPendingAlign { hasPendingAlign = false; startAlign(pendingAlign) }
        if anyOnset {
            onsetArmed = true
            onsetDeadline = now + frames(pendingOnsetTimeoutMs >= 0 ? pendingOnsetTimeoutMs : 1500)
        }
        pendingOnsetTimeoutMs = -1
        if pendingDelayMs >= 0 { echoLen = min(max(1, Int(frames(pendingDelayMs))), echoCap - 1); if echoIdx >= echoLen { echoIdx = 0 }; pendingDelayMs = -1 }
        if pendingFeedback >= 0 { feedback = Float(min(pendingFeedback, 0.85)); pendingFeedback = -1 }
        if pendingWatchdogMs >= 0 { watchdogFrame = pendingWatchdogMs == 0 ? 0 : now + frames(pendingWatchdogMs); pendingWatchdogMs = -1 }
    }

    // ── Envelope analysis ──
    @inline(__always) private func envAt(_ h: Int) -> Double {
        if h < 0 || h >= hopIdx || hopIdx - h >= envCap { return 0 }
        return Double(env[h % envCap])
    }

    /// Refine a jump length: search ±64 ms around d for the best rhythmic match between the last 2 s and the 2 s one jump earlier
    private func refineJump(_ d: Double) -> Double {
        let d0 = Int((d / Double(H)).rounded())
        let w = min(400, hopIdx - d0 - 20)
        guard w > 100 else { return d }
        let span = 16
        var best = -1.0, bestI = 0, sum = 0.0
        for i in -span...span {
            var s = 0.0
            for k in 1...w { s += envAt(hopIdx - k) * envAt(hopIdx - k - d0 - i) }
            scratch[i + span] = s; sum += s
            if s > best { best = s; bestI = i }
        }
        let mean = sum / Double(2 * span + 1)
        // No clear peak, or the peak sits on the search edge (true optimum out of range) → keep the planned value
        guard best > mean * 1.2, best > 0, abs(bestI) < span - 1 else { emit(10, ms(d), Double(bestI) * Double(H) / sr * 1000); return d }
        var off = 0.0
        do {
            let l = scratch[bestI + span - 1], c = scratch[bestI + span], r = scratch[bestI + span + 1]
            let den = l - 2 * c + r
            if den < 0 { off = 0.5 * (l - r) / den }
        }
        return (Double(d0 + bestI) + off) * Double(H)
    }

    /// Comb-filter beat phase: position (frames) of the last beat in [startHop, endHop) and its confidence
    private func combPhase(endHop: Int, startHop: Int, period: Double, maxBeats: Int) -> (frame: Double, conf: Double, half: Double) {
        let P = period / Double(H)
        guard P >= 2 else { return (0, 0, 0) }
        let K = min(maxBeats, Int(Double(endHop - startHop) / P))
        guard K >= 3 else { return (0, 0, 0) }
        let nPhi = min(1000, Int(P.rounded(.up)))
        var best = -1.0, bestI = 0, sum = 0.0
        for phi in 0..<nPhi {
            var s = 0.0
            for k in 0..<K {
                let h = endHop - 1 - phi - Int((Double(k) * P).rounded())
                s += envAt(h) + 0.5 * (envAt(h - 1) + envAt(h + 1))
            }
            scratch[phi] = s; sum += s
            if s > best { best = s; bestI = phi }
        }
        let mean = sum / Double(nPhi)
        guard mean > 0 else { return (0, 0, 0) }
        let l = scratch[(bestI - 1 + nPhi) % nPhi], c = scratch[bestI], r = scratch[(bestI + 1) % nPhi]
        let den = l - 2 * c + r
        let off = den < 0 ? 0.5 * (l - r) / den : 0
        let hop = Double(endHop - 1) - (Double(bestI) + off)
        // On-beat vs off-beat: score ratio between the best phase and half a beat away
        let halfI = (bestI + nPhi / 2) % nPhi
        let half = scratch[halfI] > 0 ? best / scratch[halfI] : 99
        return (hop * Double(H), best / mean, half)
    }

    private func startAlign(_ a: AlignSpec) {
        alignOn = false
        guard a.periodA > 0.2, a.periodB > 0.2, a.periodOut > 0.2 else { return }
        periodA = a.periodA * sr; periodB = a.periodB * sr; periodOut = a.periodOut * sr; bFirst = a.bFirst * sr
        let r = combPhase(endHop: hopIdx, startHop: hopIdx - envCap + 8, period: periodA, maxBeats: 24)
        emit(3, r.conf, r.half)
        guard r.conf >= 1.4, r.half >= 1.15 else { return }
        gridA = r.frame
        alignOn = true
    }

    // ── Transition events ──
    private func setPos(_ v: Int, _ p: Double, fade: Bool) {
        if fade { voices[v].oldPos = voices[v].pos; voices[v].xf = xfLen } else { voices[v].oldPos = p; voices[v].xf = 0 }
        voices[v].pos = p
    }

    private func reset(ms: Double) {
        schedCount = 0; jumpCount = 0; commitFrame = 0; onsetArmed = false; watchdogFrame = 0
        alignOn = false; pllFrame = 0; drain = false
        let a = active
        if Double(now) - voices[a].pos > 1 { setPos(a, Double(now), fade: true) }
        voices[a].endFrame = .max
        setPos(1 - a, Double(now), fade: false); voices[1 - a].endFrame = .max
        vals[pidx(Kind.rate.rawValue, 0)] = 1; vals[pidx(Kind.rate.rawValue, 1)] = 1
        let d = max(1, frames(ms))
        for p in 0..<DSP.nParams where (p - 1) % 4 != 3 || p == 0 {
            sched[schedCount] = Ramp(param: p, to: neutral(p), startFrame: now, durFrames: d); schedCount += 1
        }
        emit(6, ms)
    }

    private func commit() {
        commitFrame = 0
        let old = active
        active = 1 - active
        setPos(old, Double(now), fade: false)
        voices[old].endFrame = .max
        voices[active].endFrame = .max
        for k in 0..<4 { let p = 1 + old * 4 + k; vals[p] = neutral(p) }
        for i in 0..<schedCount where sched[i].param != 0 && (sched[i].param - 1) / 4 == old { sched[i].dead = true }
        for i in 0..<8 { fz[old * 8 + i] = 0 }
        alignOn = false; pllFrame = 0
        drain = true
        // Safety: return any leftover filter/send on the new active voice to neutral within 0.4 s so styles never bleed into each other
        let settle = max(1, frames(400))
        for i in 0..<4 {   // no array literal: avoid allocating on the audio thread
            let p = i == 3 ? 0 : pidx(i, active)   // 0 gain, 1 lp, 2 hp, 3 → send
            if !hasRamp(p) && abs(vals[p] - neutral(p)) > 1e-3 && schedCount < schedCap {
                sched[schedCount] = Ramp(param: p, to: neutral(p), startFrame: now, durFrames: settle); schedCount += 1
            }
        }
        emit(5, currentLagMs)
    }

    private func fireOnset() {
        onsetArmed = false
        let a = active, b = 1 - active
        var startAt = now
        if alignOn {
            let pa = voices[a].pos
            let rA = max(0.5, vals[pidx(Kind.rate.rawValue, a)])
            let k = ((pa - gridA) / periodA).rounded(.up)
            let sNext = gridA + k * periodA
            let tA = Double(now) + (sNext - pa + Double(wsL)) / rA - Double(wsL)   // correct for WSOLA latency under a rate change
            let tB0 = Double(now) + bFirst
            let pal = min(periodOut, periodB)      // half/double time: aligning to the nearest beat is enough
            var delta = fmod(tA - tB0, pal)
            if delta < 0 { delta += pal }
            setPos(b, Double(now) - delta, fade: false)
            startAt = now + Int64(delta)
            onsetFrameB = now
            pllFrame = startAt + Int64(max(2.2 * sr, 6.2 * periodB))   // measure after at least 6 incoming beats
            emit(2, ms(delta), 1)
        } else {
            emit(2, 0, 0)
        }
        voices[a].endFrame = now
        for i in 0..<schedCount where sched[i].onset { sched[i].startFrame = startAt + sched[i].startFrame; sched[i].onset = false }
    }

    private func runPLL() {
        pllFrame = 0
        guard alignOn else { return }
        let a = active
        let rA0 = max(0.5, vals[pidx(Kind.rate.rawValue, a)])
        let remaining = (Double(voices[a].endFrame) - voices[a].pos) / rA0      // output frames left in the outgoing voice
        guard vals[pidx(Kind.gain.rawValue, a)] > 0.05, remaining > 0.6 * sr else { emit(8, 0, 1); return }
        let r = combPhase(endHop: hopIdx, startHop: Int(onsetFrameB / Int64(H)) + 2, period: periodB, maxBeats: 16)
        guard r.conf >= 2.5 else { emit(8, 0, 2); return }
        guard r.half >= 1.25 else { emit(8, 0, 3); return }
        let pal = min(periodB, periodOut)
        var e = fmod(r.frame - (Double(onsetFrameB) + bFirst), pal)
        if e >= pal / 2 { e -= pal }
        if e < -pal / 2 { e += pal }
        guard abs(e) <= 0.22 * pal else { emit(8, ms(e), 4); return }     // too large: probably locked to the off-beat
        emit(4, ms(e), r.conf)
        guard abs(e) > 0.008 * sr else { return }
        // shift the outgoing beats by e with a temporary rate change of at most 2.5%
        let p = pidx(Kind.rate.rawValue, a)
        let rNow = vals[p], T = min(remaining * 0.8, max(0.5 * sr, abs(e) / 0.025))
        let r1 = rNow * (1 - e / T)
        for i in 0..<schedCount where sched[i].param == p { sched[i].dead = true }
        if schedCount + 2 <= schedCap {
            sched[schedCount] = Ramp(param: p, to: r1, startFrame: now, durFrames: frames(30)); schedCount += 1
            sched[schedCount] = Ramp(param: p, to: rNow, startFrame: now + Int64(T), durFrames: frames(30)); schedCount += 1
        }
    }

    private func advanceRamps(to t: Int64) {
        for i in 0..<schedCount {
            if sched[i].dead || sched[i].onset { continue }
            if !sched[i].started {
                guard sched[i].startFrame <= t else { continue }
                let p = sched[i].param
                for j in 0..<schedCount where j != i && sched[j].started && sched[j].param == p { sched[j].dead = true }
                sched[i].started = true
                sched[i].from = vals[p]
            }
            let r = sched[i]
            let x = min(1, max(0, Double(t - r.startFrame) / Double(r.durFrames)))
            let v: Double
            switch r.curve {
            case 1: v = r.from + (r.to - r.from) * sin(x * Double.pi / 2)
            case 2: v = r.from + (r.to - r.from) * (1 - cos(x * Double.pi / 2))
            default:
                if isFreq(r.param), r.from > 0, r.to > 0 { v = r.from * pow(r.to / r.from, x) }
                else { v = r.from + (r.to - r.from) * x }
            }
            vals[r.param] = v
            if x >= 1 { sched[i].dead = true }
        }
        var w = 0
        for i in 0..<schedCount where !sched[i].dead { if w != i { sched[w] = sched[i] }; w += 1 }
        schedCount = w
    }

    private func hasRamp(_ p: Int) -> Bool {
        for i in 0..<schedCount where sched[i].param == p && !sched[i].dead { return true }
        return false
    }

    // ── Sample access ──
    @inline(__always) private func ringAt(_ frame: Int64, _ ch: Int, _ newest: Int64) -> Float {
        let f = min(frame, newest)
        if f < 0 || newest - f >= Int64(ringLen) { return 0 }
        return ring[ch * ringLen + Int(f % Int64(ringLen))]
    }
    /// Catmull-Rom interpolated read
    @inline(__always) private func readFrac(_ pos: Double, _ ch: Int, _ newest: Int64) -> Float {
        let i = Int64(pos.rounded(.down))
        let fr = Float(pos - Double(i))
        if fr == 0 { return ringAt(i, ch, newest) }
        let y0 = ringAt(i - 1, ch, newest), y1 = ringAt(i, ch, newest), y2 = ringAt(i + 1, ch, newest), y3 = ringAt(i + 2, ch, newest)
        let c1 = 0.5 * (y2 - y0)
        let c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3
        let c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2)
        return ((c3 * fr + c2) * fr + c1) * fr + y1
    }

    @inline(__always) private func mono(_ f: Int64, _ newest: Int64) -> Float { ringAt(f, 0, newest) + ringAt(f, 1, newest) }

    /// Start a new segment for voice v at read head − L. When the rate changes or the head jumps, search ±S for the
    /// position that best matches the natural continuation of the previous segment.
    private func startGrain(_ v: Int, _ pos: Double, _ newest: Int64) {
        let aNom = Int64(pos.rounded(.down)) - Int64(wsL)
        let hasPrev = v == 0 ? wsHasPrev.0 : wsHasPrev.1
        let prevA = v == 0 ? wsPrevA.0 : wsPrevA.1
        let rate = vals[pidx(Kind.rate.rawValue, v)]
        var a = aNom
        if hasPrev {
            let nat = prevA + Int64(wsHs)
            let off = aNom - nat
            if abs(rate - 1) < 1e-9 && abs(off) <= Int64(wsS) {
                a = nat                       // rate 1: exact continuation = bit-transparent passthrough
            } else {
                let S = wsS, M = wsM
                for k in 0..<M { wsNat[k] = mono(nat + Int64(k), newest) }
                let c0 = aNom - Int64(S)
                for k in 0..<(M + 2 * S + 1) { wsCand[k] = mono(c0 + Int64(k), newest) }
                // coarse search: step 4, every 4th sample
                var best = -Float.greatestFiniteMagnitude, bestD = S
                var d = 0
                while d <= 2 * S {
                    var xy: Float = 0, yy: Float = 1e-9
                    var k = 0
                    while k < M { let y = wsCand[d + k]; xy += wsNat[k] * y; yy += y * y; k += 4 }
                    let sc = xy / sqrtf(yy)
                    if sc > best { best = sc; bestD = d }
                    d += 4
                }
                // fine search: ±3
                let lo = max(0, bestD - 3), hi = min(2 * S, bestD + 3)
                best = -Float.greatestFiniteMagnitude
                var fine = bestD
                for d2 in lo...hi {
                    var xy: Float = 0, yy: Float = 1e-9
                    for k in 0..<M { let y = wsCand[d2 + k]; xy += wsNat[k] * y; yy += y * y }
                    let sc = xy / sqrtf(yy)
                    if sc > best { best = sc; fine = d2 }
                }
                a = c0 + Int64(fine)
            }
        }
        if v == 0 { wsPrevA.0 = a; wsHasPrev.0 = true } else { wsPrevA.1 = a; wsHasPrev.1 = true }
        let idx = v == 0 ? wsIdx.0 : wsIdx.1
        let N = wsN
        for ch in 0..<2 {
            let base = (v * 2 + ch) * N
            var j = idx
            for i in 0..<N {
                wsAcc[base + j] += wsWin[i] * ringAt(a + Int64(i), ch, newest)
                j += 1; if j == N { j = 0 }
            }
        }
    }

    @inline(__always) private func softClip(_ x: Float) -> Float {
        let a = abs(x)
        if a <= 0.9 { return x }
        return (x < 0 ? -1 : 1) * (0.9 + 0.1 * tanhf((a - 0.9) / 0.1))
    }

    @inline(__always) private func filter(_ x: Double, _ v: Int, _ ch: Int) -> Double {
        let b = v * 8 + ch * 4
        let l = v == 0 ? lpC.0 : lpC.1, h = v == 0 ? hpC.0 : hpC.1
        var y = l.b0 * x + fz[b]
        fz[b] = l.b1 * x - l.a1 * y + fz[b + 1]
        fz[b + 1] = l.b2 * x - l.a2 * y
        let x2 = y
        y = h.b0 * x2 + fz[b + 2]
        fz[b + 2] = h.b1 * x2 - h.a1 * y + fz[b + 3]
        fz[b + 3] = h.b2 * x2 - h.a2 * y
        return y
    }

    func process(input: UnsafeMutableAudioBufferListPointer, output: UnsafeMutableAudioBufferListPointer) {
        guard let ob = output.first, ob.mNumberChannels > 0 else { return }
        let n = Int(ob.mDataByteSize) / (MemoryLayout<Float>.size * Int(ob.mNumberChannels))
        guard n > 0 else { return }

        // 1) Write ring buffer + onset envelope
        var energy: Float = 0
        for f in 0..<n {
            let l = readSample(input, f, 0), r = readSample(input, f, 1)
            let idx = Int((now + Int64(f)) % Int64(ringLen))
            ring[idx] = l; ring[ringLen + idx] = r
            energy += l * l + r * r
            let m = (l + r) * 0.5, d = m - prevMono
            prevMono = m
            hopAcc += d * d; hopCount += 1
            if hopCount == H {
                let e = log10f(hopAcc / Float(H) + 1e-9)
                env[hopIdx % envCap] = max(0, e - ePrev)
                ePrev = e; hopAcc = 0; hopCount = 0; hopIdx += 1
            }
        }
        let newest = now + Int64(n) - 1

        // 2) Schedules and events
        pickup()
        if onsetArmed && (sqrtf(energy / Float(2 * n)) > 0.003 || now >= onsetDeadline) { fireOnset() }
        if watchdogFrame > 0 && now >= watchdogFrame { emit(7); reset(ms: 600) }
        if commitFrame > 0 && now >= commitFrame { commit() }
        if pllFrame > 0 && now >= pllFrame { runPLL() }
        if drain && jumpCount == 0 && commitFrame == 0 && !onsetArmed {
            let p = pidx(Kind.rate.rawValue, active)
            if !hasRamp(p) {
                if Double(now) - voices[active].pos > 2 { vals[p] = 1.0025 }
                else { voices[active].pos = Double(now); vals[p] = 1; drain = false }
            }
        }

        // 3) Parameters
        let g0a = Float(vals[1]), g1a = Float(vals[5]), sa = Float(vals[0])
        let r0a = vals[4], r1a = vals[8]
        advanceRamps(to: now + Int64(n))
        let g0b = Float(vals[1]), g1b = Float(vals[5]), sb = Float(vals[0])
        let r0b = vals[4], r1b = vals[8]
        lpC = (.lowpass(vals[2], sr, q: 0.9), .lowpass(vals[6], sr, q: 0.9))
        hpC = (.highpass(vals[3], sr, q: 0.707), .highpass(vals[7], sr, q: 0.707))

        // 4) Per frame
        let invN = 1 / Float(n), dInvN = 1 / Double(n)
        let endFade = 0.03 * sr
        for f in 0..<n {
            let t = now + Int64(f)
            if jumpCount > 0 {
                var i = 0
                while i < jumpCount {
                    if jumps[i].frame <= t {
                        let v = jumps[i].voice
                        let d = refineJump(jumps[i].delay)
                        emit(1, ms(jumps[i].delay), ms(d))
                        setPos(v, voices[v].pos - d, fade: true)
                        jumps[i] = jumps[jumpCount - 1]; jumpCount -= 1
                    } else { i += 1 }
                }
            }
            let k = Float(f) * invN, kd = Double(f) * dInvN
            let g0 = g0a + (g0b - g0a) * k, g1 = g1a + (g1b - g1a) * k, send = sa + (sb - sa) * k
            var out: (Float, Float) = (0, 0)
            var activeSig: (Float, Float) = (0, 0)
            for v in 0..<2 {
                let tt = Double(t)
                if voices[v].pos > tt { voices[v].pos = tt }
                let pos = voices[v].pos
                var em: Float = 1
                if voices[v].endFrame != .max { em = Float(min(1, max(0, (Double(voices[v].endFrame) - pos) / endFade))) }
                let g = (v == 0 ? g0 : g1) * em
                if (v == 0 ? wsHop.0 : wsHop.1) <= 0 {
                    startGrain(v, pos, newest)
                    if v == 0 { wsHop.0 = wsHs } else { wsHop.1 = wsHs }
                }
                let wi = v == 0 ? wsIdx.0 : wsIdx.1
                for ch in 0..<2 {
                    let ai = (v * 2 + ch) * wsN + wi
                    let s = wsAcc[ai]
                    wsAcc[ai] = 0
                    let y = Float(filter(Double(s), v, ch))
                    if ch == 0 { out.0 += y * g } else { out.1 += y * g }
                    if v == active { if ch == 0 { activeSig.0 = y } else { activeSig.1 = y } }
                }
                let rate = v == 0 ? r0a + (r0b - r0a) * kd : r1a + (r1b - r1a) * kd
                voices[v].pos += rate
                voices[v].oldPos += rate
                if v == 0 { wsIdx.0 = wsIdx.0 + 1 == wsN ? 0 : wsIdx.0 + 1; wsHop.0 -= 1 }
                else { wsIdx.1 = wsIdx.1 + 1 == wsN ? 0 : wsIdx.1 + 1; wsHop.1 -= 1 }
                if voices[v].xf > 0 { voices[v].xf -= 1 }
            }
            // Echo
            for ch in 0..<2 {
                let di = ch * echoCap + echoIdx
                let echo = delayBuf[di]
                let fb: Float
                if ch == 0 { fbState.0 += fbCoef * (echo - fbState.0); fb = fbState.0 }
                else { fbState.1 += fbCoef * (echo - fbState.1); fb = fbState.1 }
                delayBuf[di] = (ch == 0 ? activeSig.0 : activeSig.1) * send + fb * feedback
                if ch == 0 { out.0 = softClip(out.0 + echo) } else { out.1 = softClip(out.1 + echo) }
            }
            echoIdx += 1; if echoIdx >= echoLen { echoIdx = 0 }
            writeFrame(output, f, out)
        }
        now += Int64(n)
    }

    @inline(__always) private func readSample(_ abl: UnsafeMutableAudioBufferListPointer, _ f: Int, _ ch: Int) -> Float {
        if abl.count == 0 { return 0 }
        if abl.count == 1 {
            let b = abl[0]; let nch = Int(b.mNumberChannels)
            guard nch > 0, let d = b.mData?.assumingMemoryBound(to: Float.self), (f + 1) * nch * 4 <= Int(b.mDataByteSize) else { return 0 }
            return d[f * nch + min(ch, nch - 1)]
        }
        let b = abl[min(ch, abl.count - 1)]
        guard let d = b.mData?.assumingMemoryBound(to: Float.self), (f + 1) * 4 <= Int(b.mDataByteSize) else { return 0 }
        return d[f]
    }

    @inline(__always) private func writeFrame(_ abl: UnsafeMutableAudioBufferListPointer, _ f: Int, _ s: (Float, Float)) {
        var g = 0
        for b in abl {
            let nch = Int(b.mNumberChannels)
            guard let d = b.mData?.assumingMemoryBound(to: Float.self) else { g += nch; continue }
            for c in 0..<nch {
                let idx = f * nch + c
                if (idx + 1) * 4 <= Int(b.mDataByteSize) { d[idx] = g == 0 ? s.0 : (g == 1 ? s.1 : 0) }
                g += 1
            }
        }
    }
}
