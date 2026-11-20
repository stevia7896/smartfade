// NAME: Smart Transition
// AUTHOR: local
// VERSION: 0.7.0
// DESCRIPTION: Crossfade for Spotify free on macOS. Requires SmartFade.app.

(function SmartTransition() {
    const S = window.Spicetify;
    if (!S?.Player?.origin?._state || !S?.Platform?.PlayerAPI || !S?.LocalStorage || !S?.getAudioData ||
        !S?.Topbar || !S?.PopupModal || !S?.Player?.data) {
        setTimeout(SmartTransition, 300);
        return;
    }

    // ─── How it works ──────────────────────────────────────────────
    // Spotify plays one track at a time, so to overlap two tracks the listener has to run slightly
    // behind Spotify. SmartFade builds that gap without ever repeating audio:
    //   1. drift  – over the last minute or two the outgoing track slows by 2–5% (pitch preserved),
    //               so the listener falls a few seconds behind
    //   2. match  – just before the cut it eases onto the incoming track's tempo
    //   3. cut    – Spotify moves to the next track; the buffered tail of the outgoing track plays over it, beat-aligned
    //   4. commit – the buffer runs out and the small remaining delay drains away
    //  Echo: no overlap. The last two bars darken, the final beat trails into an echo, the next track fades in.

    // ─── Config ────────────────────────────────────────────────────
    const WS_URL = "ws://127.0.0.1:17890";
    const RELEASES = "https://github.com/stevia7896/smartfade/releases/latest";
    const SETTINGS_KEY = "smarttransition:settings:v3";
    const SILENCE_DB = -45;
    const PREP_AHEAD_SEC = 3;
    const MAX_LAG_SEC = 16;
    const MIN_TRACK_SEC = 45;
    const DRIFT_RAMP = 10;         // seconds to ease into the drift
    const DRIFT_WINDOW = 150;      // longest lead-in, seconds
    const DRIFT_MIN = 0.02, DRIFT_MAX = 0.05;
    const MIN_LAG = 1.5;           // shortest blend overlap worth doing
    const MIN_FILTER_LAG = 1.0;    // shortest filtered overlap; below this Auto echoes out
    const BLEND_MIN_LAG = 2.5;     // a blend squeezed below this sounds rushed → Auto uses a filtered blend instead
    const OVERLAPS = { short: 3, medium: 5, long: 8 };   // target overlap, seconds
    const RHYTHM_CONF = 0.25;      // mean beat confidence above which a track counts as rhythmic
    const DEFAULTS = {
        enabled: true,
        style: "auto",
        overlap: "medium",
        beatmatch: true,
        maxStretch: 0.06,
        trimOutro: true,
        trimSilence: true,
        skipSameAlbum: true,
        debug: false,
    };
    const STYLES = {
        auto: { name: "Auto", hint: "Chooses the right technique for every pair of tracks." },
        blend: { name: "Blend", hint: "Long beat-matched overlap with a bass swap." },
        filter: { name: "Filter", hint: "Short overlap as the outgoing track sinks into a low-pass." },
        echo: { name: "Echo", hint: "No overlap. The final beat trails off into an echo." },
    };
    const MODE_NAMES = { blend: "Blend", filter: "Filter", echo: "Echo out" };

    const cfg = (() => {
        const c = { ...DEFAULTS };
        try { Object.assign(c, JSON.parse(S.LocalStorage.get(SETTINGS_KEY) || "{}")); } catch (_) {}
        if (!STYLES[c.style]) c.style = DEFAULTS.style;
        if (!OVERLAPS[c.overlap]) c.overlap = DEFAULTS.overlap;
        return c;
    })();
    const saveCfg = () => S.LocalStorage.set(SETTINGS_KEY, JSON.stringify(cfg));
    const dbg = (...a) => cfg.debug && console.log("[SmartTransition]", ...a);
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    // ─── SmartFade connection ──────────────────────────────────────
    let ws = null;
    let hadConnection = false;
    const noEngine = () => ({ connected: false, tapping: false, output: "", overlap: false, beatmatch: false, keylock: false });
    let engine = noEngine();

    function connect() {
        try { ws = new WebSocket(WS_URL); } catch (e) { setTimeout(connect, 5000); return; }
        ws.onopen = () => {
            engine.connected = true;
            send({ type: "hello" });
            if (hadConnection) send({ type: "reset", dur: 250, reason: "reconnected" });
            hadConnection = true;
            refreshButton();
        };
        ws.onclose = () => {
            if (hadConnection) {
                st = freshState(st.uri);
                st.retryAt = Date.now() + 1000;
            }
            lastMix = null;
            engine = noEngine(); ws = null; refreshButton(); setTimeout(connect, 3000);
        };
        ws.onerror = () => {};
        ws.onmessage = (e) => {
            try {
                const m = JSON.parse(e.data);
                if (m.type === "status") {
                    const f = Array.isArray(m.features) ? m.features : [];
                    engine = { connected: true, tapping: !!m.tapping, output: m.output || "", version: m.version,
                               overlap: f.includes("overlap"), beatmatch: f.includes("beatmatch"), keylock: f.includes("keylock") };
                    refreshButton();
                }
            } catch (_) {}
        };
    }
    const ready = () => engine.connected && engine.tapping && engine.keylock && ws?.readyState === 1;
    function send(obj) { if (ws?.readyState === 1) { ws.send(JSON.stringify(obj)); dbg("→", obj.type, obj.label || obj.reason || "", obj); } }

    // ─── Audio analysis ────────────────────────────────────────────
    const analysisCache = new Map();
    function getAnalysis(uri) {
        if (!uri?.startsWith("spotify:track:")) return Promise.resolve(null);
        if (!analysisCache.has(uri)) {
            const p = S.getAudioData(uri).catch((e) => { dbg("analysis failed", uri, e); analysisCache.delete(uri); return null; });
            analysisCache.set(uri, p);
            if (analysisCache.size > 30) analysisCache.delete(analysisCache.keys().next().value);
        }
        return analysisCache.get(uri);
    }

    const median = (arr) => { if (!arr.length) return NaN; const s = [...arr].sort((a, b) => a - b); return s[s.length >> 1]; };
    const mean = (arr) => arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : 0;
    function beatLength(beats, fromSec, toSec, tempo) {
        let L = median(beats.filter((b) => b.start >= fromSec && b.start <= toSec).map((b) => b.duration));
        if (!Number.isFinite(L) || L <= 0) L = tempo > 0 ? 60 / tempo : 0.5;
        while (L < 0.3) L *= 2;
        while (L > 1.0) L /= 2;
        return L;
    }
    function rawBeat(beats, fromSec, toSec) {
        const d = beats.filter((b) => b.start >= fromSec && b.start <= toSec && b.duration > 0.2 && b.duration < 2).map((b) => b.duration);
        return d.length >= 4 ? median(d) : NaN;
    }
    const beatConf = (beats, from, to) => mean((beats || []).filter((b) => b.start >= from && b.start <= to).map((b) => b.confidence || 0));

    // ─── Key (Camelot) ─────────────────────────────────────────────
    function camelot(key, mode) {
        const k = mode === 1 ? key : (key + 3) % 12;
        return { n: ((k * 7) % 12 + 7) % 12 + 1, letter: mode === 1 ? "B" : "A" };
    }
    function keyOf(sec, track) {
        if (sec && sec.key >= 0 && (sec.key_confidence ?? 0) >= 0.3) return camelot(sec.key, sec.mode);
        if (track && track.key >= 0 && (track.key_confidence ?? 1) >= 0.3) return camelot(track.key, track.mode);
        return null;
    }
    function keyCompat(x, y) {
        const d = Math.min((x.n - y.n + 12) % 12, (y.n - x.n + 12) % 12);
        return d === 0 || (d === 1 && x.letter === y.letter);
    }

    /** How well do the two tracks fit → which technique Auto picks */
    function assess(a, na, cut, firstSound, match, tempoKnown) {
        if (!na) return { mode: "echo", reason: "No analysis for the next track", keyOK: true };
        const rA = beatConf(a.beats, cut - 30, cut), rB = beatConf(na.beats, firstSound, firstSound + 30);
        const secA = [...(a.sections || [])].reverse().find((s) => s.start < cut - 1);
        const secB = (na.sections || []).find((s) => s.start + s.duration > firstSound + 1);
        const gap = secA && secB ? Math.abs(secA.loudness - secB.loudness) : 0;
        const kA = keyOf(secA, a.track), kB = keyOf(secB, na.track);
        const keyOK = !kA || !kB || keyCompat(kA, kB);
        const info = { rA, rB, gap, keyA: kA && `${kA.n}${kA.letter}`, keyB: kB && `${kB.n}${kB.letter}`, keyOK };
        if (gap >= 12) return { ...info, mode: "echo", reason: `${gap.toFixed(0)} dB loudness gap` };
        const strongA = rA >= RHYTHM_CONF, strongB = rB >= RHYTHM_CONF;
        if (strongA && strongB) {
            if (match) return { ...info, mode: "blend", reason: keyOK ? "Both rhythmic, tempos within reach" : "Tempos align, keys clash — shorter overlap" };
            if (!cfg.beatmatch) return { ...info, mode: "filter", reason: "Beat-matching is off — short filtered blend" };
            if (!tempoKnown) return { ...info, mode: "filter", reason: "Tempo unclear — short filtered blend, kicks kept apart" };
            return { ...info, mode: "filter", reason: "Tempos too far apart to beat-match — short filtered blend, kicks kept apart" };
        }
        return { ...info, mode: "filter", reason: "Low rhythmic drive — short filtered blend" };
    }

    // ─── Planning ──────────────────────────────────────────────────
    /** preview: the listener gets the whole lag up front (a short silent gap), so no drift is needed */
    function computePlan(uri, a, nextUri, na, pNow = 0, preview = false) {
        const t = a.track, dur = t.duration;
        if (dur < MIN_TRACK_SEC) return null;
        const segs = a.segments || [], bars = a.bars || [], beats = a.beats || [];

        // 1) Cut point
        let audibleEnd = dur;
        if (cfg.trimSilence) {
            for (let i = segs.length - 1; i >= 0; i--) {
                if (segs[i].loudness_max > SILENCE_DB) { audibleEnd = Math.min(dur, segs[i].start + segs[i].duration); break; }
            }
        }
        let target = audibleEnd;
        if (cfg.trimOutro && t.start_of_fade_out > 0 && audibleEnd - t.start_of_fade_out > 6) {
            target = Math.min(audibleEnd, t.start_of_fade_out + 3);
        }
        const trimmed = target < audibleEnd - 0.5;
        const beatSec = beatLength(beats, target - 20, target, t.tempo);
        let cutIdx = -1;
        for (let i = bars.length - 1; i >= 0; i--) { if (bars[i].start <= target + 0.25) { cutIdx = i; break; } }
        if (cutIdx >= 0 && target - bars[cutIdx].start >= beatSec * 4 * 1.05) cutIdx = -1;
        let cut = trimmed && cutIdx >= 0 ? bars[cutIdx].start : target;
        const natural = dur - cut < 0.6;
        if (natural) cut = dur;

        // 2) Next track
        let inPoint = 0, firstSound = 0, inBeat = 0.5;
        if (na) {
            const first = (na.segments || []).find((s) => s.loudness_max > SILENCE_DB);
            if (first) firstSound = first.start;
            if (cfg.trimSilence && first && first.start > 0.5 && first.start < 20) inPoint = Math.max(0, first.start - 0.05);
            inBeat = beatLength(na.beats || [], firstSound, firstSound + 20, na.track?.tempo);
        }

        // 3) Tempo match (half/double-time aware)
        const pA = rawBeat(beats, cut - 20, cut);
        const bpmA = pA > 0 ? 60 / pA : null;
        let bpmB = null, match = null, tempoKnown = false;
        if (na && pA > 0) {
            const nb = na.beats || [];
            const pB = rawBeat(nb, firstSound, firstSound + 20);
            if (pB > 0) {
                bpmB = 60 / pB; tempoKnown = true;
                let best = null;
                for (const m of [0.5, 1, 2]) { const r = pA / (pB * m); if (!best || Math.abs(r - 1) < Math.abs(best.r - 1)) best = { r, m }; }
                const firstBeat = nb.find((b) => b.start >= firstSound - 0.03);
                if (cfg.beatmatch && Math.abs(best.r - 1) <= cfg.maxStretch && firstBeat) {
                    match = { r: best.r, periodA: pA, periodB: pB, periodOut: pB * best.m, bFirst: firstBeat.start - firstSound };
                }
            }
        }

        // 4) Technique
        const c = assess(a, na, cut, firstSound, match, tempoKnown);
        let mode = cfg.style === "auto" ? c.mode : cfg.style;
        let reason = cfg.style === "auto" ? c.reason : "Set manually";
        let want = OVERLAPS[cfg.overlap];
        if (mode === "filter" || (cfg.style === "auto" && !c.keyOK)) want = Math.min(want, 3);
        const common = { uri, nextUri, dur, cut, natural, beatSec, inPoint, bpmA, bpmB, assess: c,
                         inSec: clamp(2 * 4 * inBeat, 1.5, 5) };

        const echoPlan = (why) => {
            let outStart = cutIdx >= 2 ? bars[cutIdx - 2].start : cut - 8 * beatSec;
            outStart = clamp(outStart, cut - 10, cut - 2);
            if (outStart < 20 || (!preview && outStart < pNow + 1)) return null;
            return { ...common, mode: "echo", reason: why, prepAt: outStart, outStart, lag: 0, lag0: 0, overlap: 0, want: 0, match: null };
        };
        if (mode === "echo") return echoPlan(reason);

        // 5) Lead-in drift: slow the outgoing track by s (pitch preserved) so the listener falls `lag` seconds behind
        const rampSec = match ? Math.min(8 * match.periodA, 6) : 0;
        if (match) match.rampSec = rampSec;
        const T1 = cut - rampSec;
        const finalLag = (sd) => match ? (1 - ((1 - sd) + match.r) / 2) * rampSec : 0;
        if (preview) {
            const lag0 = clamp(want - finalLag(0), MIN_LAG, MAX_LAG_SEC - 4);
            const lag = lag0 + finalLag(0);
            return { ...common, mode, reason, want, prepAt: T1 - 1, driftStart: T1, drift: 0, lag0, lag, overlap: lag / (match ? match.r : 1), match };
        }
        const T0min = Math.max(20, cut - DRIFT_WINDOW, pNow + 5);
        const avail = T1 - T0min;
        if (avail < DRIFT_RAMP + 4) return echoPlan("Too close to the end to build an overlap — echoing out");
        const lagFor = (sd, T0) => sd * DRIFT_RAMP / 2 + sd * Math.max(0, T1 - DRIFT_RAMP - T0) + finalLag(sd);
        let sd = (want - (match ? (1 - match.r) / 2 * rampSec : 0)) / (avail - DRIFT_RAMP / 2 + rampSec / 2);
        sd = clamp(sd, DRIFT_MIN, DRIFT_MAX);
        let T0 = T0min;
        if (lagFor(sd, T0) > want) {   // smallest drift already overshoots → start later instead
            const hold = (want - sd * DRIFT_RAMP / 2 - finalLag(sd)) / sd;
            T0 = clamp(T1 - DRIFT_RAMP - hold, T0min, T1 - DRIFT_RAMP);
        }
        const lag = lagFor(sd, T0);
        if (cfg.style === "auto") {
            // started late: a short filtered blend sounds smoother than a cramped blend or an echo
            if (lag < MIN_FILTER_LAG) return echoPlan("Too little time to build an overlap — echoing out");
            if (mode === "blend" && lag < BLEND_MIN_LAG) { mode = "filter"; reason = "Started late — short filtered blend"; want = Math.min(want, 3); }
        } else if (lag < (mode === "filter" ? MIN_FILTER_LAG : MIN_LAG)) return null;
        const outRate = match ? match.r : 1 - sd;
        return { ...common, mode, reason, want, prepAt: T0, driftStart: T0, drift: sd, lag0: 0, lag, overlap: lag / outRate, match };
    }

    /** Outgoing playback rate SmartFade applies at Spotify time t once the plan is running */
    function rateAt(plan, t) {
        let r = 1;
        if (plan.drift > 0 && t > plan.driftStart) r = 1 - plan.drift * Math.min(1, (t - plan.driftStart) / DRIFT_RAMP);
        const m = plan.match;
        if (m && engine.beatmatch && t > plan.cut - m.rampSec) r += (m.r - r) * Math.min(1, (t - (plan.cut - m.rampSec)) / m.rampSec);
        return r;
    }
    /** How far the listener is behind Spotify at Spotify time t */
    function lagAt(plan, t) {
        let lag = plan.lag0 || 0;
        const step = 0.25, end = Math.min(t, plan.cut);
        for (let x = Math.min(plan.driftStart ?? plan.cut, plan.cut - (plan.match?.rampSec || 0)); x < end; x += step) {
            lag += (1 - rateAt(plan, Math.min(x + step / 2, end))) * Math.min(step, end - x);
        }
        return Math.max(0, lag);
    }

    // ─── SmartFade schedules ───────────────────────────────────────
    function prepSchedule(plan, p) {
        if (plan.mode === "echo") {
            const t0 = Math.max(0, (plan.outStart - p) * 1000), L = (plan.cut - plan.outStart) * 1000, beat = plan.beatSec * 1000;
            return {
                type: "schedule", label: "prep-echo",
                ramps: [
                    { p: "out.lp", to: 900, at: t0, dur: Math.max(300, L - beat) },
                    { p: "out.gain", to: 0.85, at: t0, dur: Math.max(300, L - beat) },
                    { p: "send", to: 0.85, at: t0 + L - beat, dur: beat * 0.5 },     // final beat into the echo
                    { p: "out.gain", to: 0, at: t0 + L - 25, dur: 40 },                // dry signal off at the cut, echo rings on
                    { p: "send", to: 0, at: t0 + L, dur: 30 },
                ],
                delayMs: beat, feedback: 0.55, watchdogMs: t0 + L + 8000,
            };
        }
        const ramps = plan.drift > 0 ? [{ p: "out.rate", to: 1 - plan.drift, at: Math.max(0, (plan.driftStart - p) * 1000), dur: DRIFT_RAMP * 1000 }] : [];
        const msg = { type: "schedule", label: "prep", ramps, watchdogMs: ((plan.cut - p) + plan.lag) * 1000 + 8000,
                      note: plan.lag0 > 0 ? `preview lag ${plan.lag0.toFixed(1)}s → ${plan.lag.toFixed(1)}s`
                                          : `drift ${(plan.drift * 100).toFixed(1)}% → ${plan.lag.toFixed(1)}s` };
        if (plan.match && engine.beatmatch) {
            const m = plan.match;
            ramps.push({ p: "out.rate", to: m.r, at: Math.max(0, (plan.cut - m.rampSec - p) * 1000), dur: m.rampSec * 1000 });
            msg.note += `, match ${((m.r - 1) * 100).toFixed(1)}%`;
        }
        return msg;
    }

    function cutSchedule(plan) {
        if (plan.mode === "echo") {
            return {
                type: "schedule", label: "cut-echo",
                ramps: [{ p: "in.lp", to: 22000, at: 0, dur: 10 }, { p: "in.hp", to: 400, at: 0, dur: 10 }],
                commitAt: 2500, watchdogMs: 6000,
            };
        }
        const D = plan.overlap * 1000;
        const ramps = [{ p: "in.lp", to: 22000, at: 0, dur: 10 }];
        const msg = { type: "schedule", label: "cut", ramps, commitAt: D + 300, watchdogMs: D + 5000 };
        if (plan.match && engine.beatmatch) {
            const m = plan.match;
            msg.align = { periodA: m.periodA, periodB: m.periodB, periodOut: m.periodOut, bFirst: m.bFirst };
        }
        if (plan.mode === "filter" && !(plan.match && engine.beatmatch)) {
            // beats can't be aligned: pull the outgoing bass first, only then open the incoming low end — kicks never stack
            ramps.push({ p: "out.hp", to: 220, at: 0, dur: D * 0.25 });
            ramps.push({ p: "out.lp", to: 600, at: 0, dur: D * 0.8 });
            ramps.push({ p: "out.gain", to: 0, at: D * 0.1, dur: D * 0.8, curve: "cos" });
            ramps.push({ p: "in.hp", to: 1200, at: 0, dur: 10 });
        } else if (plan.mode === "filter") {
            ramps.push({ p: "out.lp", to: 500, at: 0, dur: D * 0.9 });
            ramps.push({ p: "out.gain", to: 0, at: D * 0.2, dur: D * 0.8, curve: "cos" });
            ramps.push({ p: "in.hp", to: 1500, at: 0, dur: 10 });
        } else {
            ramps.push({ p: "out.gain", to: 0, at: 0, dur: D, curve: "cos" });
            ramps.push({ p: "out.hp", to: 300, at: D * 0.3, dur: D * 0.25 });
            ramps.push({ p: "in.hp", to: 300, at: 0, dur: 10 });
        }
        return msg;
    }

    function inSchedule(plan) {
        if (plan.mode === "echo") {
            const I = plan.inSec * 1000;
            return {
                type: "schedule", label: "in-echo",
                ramps: [
                    { p: "in.gain", to: 1, at: 0, dur: I * 0.7, curve: "sin", anchor: "onset" },
                    { p: "in.hp", to: 10, at: 0, dur: I, anchor: "onset" },
                ],
                watchdogMs: 0, onsetTimeoutMs: 1200,
            };
        }
        const D = plan.overlap * 1000;
        const aligned = plan.match && engine.beatmatch;
        const ramps = plan.mode === "filter" && !aligned
            ? [{ p: "in.gain", to: 1, at: 0, dur: D * 0.45, curve: "sin", anchor: "onset" },
               { p: "in.hp", to: 10, at: D * 0.4, dur: D * 0.5, anchor: "onset" }]
            : plan.mode === "filter"
            ? [{ p: "in.gain", to: 1, at: 0, dur: D * 0.4, curve: "sin", anchor: "onset" },
               { p: "in.hp", to: 10, at: 0, dur: D * 0.9, anchor: "onset" }]
            : [{ p: "in.gain", to: 1, at: 0, dur: D * 0.5, curve: "sin", anchor: "onset" },
               { p: "in.hp", to: 10, at: D * 0.45, dur: D * 0.15, anchor: "onset" }];
        return { type: "schedule", label: "in", ramps, watchdogMs: 0, onsetTimeoutMs: 1200 };
    }

    // ─── State machine ─────────────────────────────────────────────
    // idle → planned → prepped → cutting → idle (next track)
    // engineDirty: SmartFade is holding a lag / running a schedule for this track, so cancelling must reset it.
    const freshState = (uri) => ({ uri, phase: "idle", plan: null, planning: false, replan: false, note: "", gen: 0,
                                   lastProgress: 0, lastWall: 0, wasPlaying: true, cutAt: 0, retryAt: 0,
                                   engineDirty: false, dirtyUntil: 0, expectSeek: null, pauseGrace: 0, preview: false });
    let st = freshState(null);
    let lastMix = null;   // { plan, cutWall, until } — keeps the card meaningful while the overlap plays out

    const curItem = () => S.Player.data?.item;
    const nextTrackInfo = () => {
        const n = S.Queue?.nextTracks?.find((x) => x?.contextTrack?.uri && x.provider !== "ad" && x.contextTrack.uri !== "spotify:delimiter");
        return n?.contextTrack || null;
    };
    const excluded = (item) => !(item?.uri || "").startsWith("spotify:track:") || item?.isAd || item?.type === "ad" || S.Player.getRepeat?.() === 2;

    function cancel(reason, retryMs = 1000) {
        if (st.engineDirty) send({ type: "reset", dur: 250, reason });
        dbg("cancel:", reason);
        st.gen++;
        Object.assign(st, { phase: "idle", plan: null, replan: false, engineDirty: false, dirtyUntil: 0, expectSeek: null,
                            preview: false, retryAt: Date.now() + retryMs });
    }

    async function makePlan(uri) {
        const state = st, gen = ++st.gen;
        state.planning = true; state.replan = false;
        let plan = null, note = "", retry = 5000;
        try {
            const next = nextTrackInfo();
            const nextUri = next?.uri;
            if (!nextUri?.startsWith("spotify:track:")) note = "Queue is empty";
            else if (cfg.skipSameAlbum && curItem()?.album?.uri && curItem().album.uri === next?.metadata?.album_uri) note = "Same album — playing gaplessly";
            else {
                const [a, na] = await Promise.all([getAnalysis(uri), getAnalysis(nextUri)]);
                if (st !== state || state.gen !== gen) return;
                if (nextTrackInfo()?.uri !== nextUri) { note = "Queue changed"; retry = 1000; }
                else if (!a) note = "Audio analysis unavailable";
                else {
                    retry = 15000;
                    const p = S.Player.getProgress() / 1000;
                    plan = computePlan(uri, a, nextUri, na, p);
                    if (!plan) note = "Not enough of the track left to mix";
                    else if (p > plan.prepAt - 1) { plan = null; note = "Too late to mix this track"; }
                    else { plan.from = curItem()?.name || ""; plan.to = next?.metadata?.title || ""; }
                }
            }
        } catch (e) {
            dbg("plan failed", e); note = "Planning failed";
        } finally {
            state.planning = false;
        }
        if (st !== state || state.gen !== gen || state.engineDirty && state.phase !== "idle") return;
        state.plan = plan; state.phase = plan ? "planned" : "idle"; state.note = note;
        if (!plan) state.retryAt = Date.now() + retry;
        dbg("plan", plan || note);
    }

    function onTrackChange(uri) {
        const prev = st;
        st = freshState(uri);
        lastMix = null;
        if (prev.phase === "cutting") {
            const plan = prev.plan;
            if (plan.nextUri === uri) {
                if (plan.inPoint > 0.5) {
                    S.Player.seek(Math.round(plan.inPoint * 1000));
                    st.expectSeek = { to: plan.inPoint, until: Date.now() + 3000 };
                }
                send(inSchedule(plan));
                const D = Math.max(plan.overlap, plan.inSec) * 1000;
                st.engineDirty = true; st.dirtyUntil = Date.now() + D + 1500;   // a pause/seek mid-overlap must still reset
                lastMix = { plan, cutWall: prev.cutAt, until: Date.now() + D + 800 };
            } else {
                send({ type: "reset", dur: 200, reason: "unexpected-track" });
            }
        } else if (prev.engineDirty) {
            send({ type: "reset", dur: 200, reason: "manual-change" });
        }
    }

    function tick() {
        const item = curItem();
        const uri = item?.uri || null;
        if (uri !== st.uri) onTrackChange(uri);

        if (!cfg.enabled || !uri || excluded(item)) { if (st.phase !== "idle" || st.engineDirty) cancel("disabled/excluded"); return; }

        const playing = S.Player.isPlaying();
        const p = S.Player.getProgress() / 1000;
        const nowWall = Date.now();
        const expected = st.lastProgress + (st.wasPlaying ? (nowWall - (st.lastWall || nowWall)) / 1000 : 0);
        const jumped = st.lastWall > 0 && Math.abs(p - expected) > 1.5;
        st.lastProgress = p; st.wasPlaying = playing; st.lastWall = nowWall;

        // A seek we started ourselves (preview, intro trim): wait for it to land, don't treat it as the user's
        if (st.expectSeek) {
            const es = st.expectSeek;
            if (Math.abs(p - es.to) < 1.5 || nowWall > es.until) {
                st.expectSeek = null; st.pauseGrace = nowWall + 2000;
                es.onArrive?.();
            }
            return;
        }
        if (st.dirtyUntil && nowWall > st.dirtyUntil) { if (st.phase === "idle" || st.phase === "planned") st.engineDirty = false; st.dirtyUntil = 0; }

        if (st.phase === "cutting") {
            if (nowWall - st.cutAt > (st.plan.natural ? 3000 : 1500)) cancel("skip-failed", 15000);
            return;
        }
        if (jumped) {
            // SmartFade already holds a lag for this track → it no longer matches; start over from here
            if (st.engineDirty) { cancel("seek", 300); return; }
            // nothing running yet → quietly re-plan; the card keeps the old plan until the new one is ready
            if (st.phase === "planned") { st.replan = true; st.retryAt = 0; }
        }
        if (!playing) { if (st.engineDirty && nowWall > st.pauseGrace) cancel("paused"); return; }

        if (st.phase === "planned" && nextTrackInfo()?.uri !== st.plan.nextUri) {
            if (st.engineDirty) cancel("queue-changed", 0); else { st.replan = true; st.retryAt = 0; }
        }

        if ((st.phase === "idle" || st.replan) && !st.planning && nowWall >= st.retryAt && ready()) makePlan(uri);
        if (st.phase === "idle" || st.planning || st.replan) return;

        const plan = st.plan;
        if (st.phase === "planned" && p >= plan.prepAt - PREP_AHEAD_SEC) {
            if (!ready()) return;
            send(prepSchedule(plan, p));
            st.phase = "prepped"; st.engineDirty = true;
            if (cfg.debug) S.showNotification(`Smart Transition · ${MODE_NAMES[plan.mode]}`);
            return;
        }
        if (st.phase === "prepped") {
            const due = plan.natural ? p >= plan.dur - 0.08 : p >= plan.cut - 0.03;
            if (due) {
                send(cutSchedule(plan));
                st.phase = "cutting"; st.cutAt = nowWall;
                if (!plan.natural) S.Player.next();
            }
        }
    }

    // ─── Preview ───────────────────────────────────────────────────
    // Jumps to just before the transition and gives the listener the full lag up front (a short silent gap),
    // so the preview sounds exactly like the real thing instead of a squeezed version of it.
    const PREVIEW_LEAD = 10;   // seconds of the outgoing track heard before the mix begins
    async function startPreview() {
        const uri = st.uri, next = nextTrackInfo(), nextUri = next?.uri;
        if (!uri || !nextUri?.startsWith("spotify:track:") || !ready() || st.phase === "cutting") return;
        const state = st, gen = ++st.gen;
        const [a, na] = await Promise.all([getAnalysis(uri), getAnalysis(nextUri)]);
        if (st !== state || st.gen !== gen) return;
        const plan = a && computePlan(uri, a, nextUri, na, 0, true);
        if (!plan) { S.showNotification("Smart Transition · can't preview this track"); return; }
        plan.from = curItem()?.name || ""; plan.to = next?.metadata?.title || "";
        const echo = plan.mode === "echo";
        const seekTo = Math.max(0, (echo ? plan.outStart : plan.cut - plan.lag) - PREVIEW_LEAD);
        const gapMs = echo ? 0 : plan.lag0 * 1000;

        send({ type: "schedule", label: "preview-mute", reset: true, ramps: [{ p: "out.gain", to: 0, at: 0, dur: 120 }], watchdogMs: 10000 });
        const onArrive = () => {
            if (st.plan !== plan) return;
            if (echo) {
                send({ type: "schedule", label: "preview-in", ramps: [{ p: "out.gain", to: 1, at: 400, dur: 400, curve: "sin" }], watchdogMs: 0 });
                st.engineDirty = false;
                return;
            }
            // muted, let the read head pass the seek, then hold it still for gapMs → the listener is exactly lag0 behind
            const G = 500;
            send({ type: "schedule", label: "preview", note: `gap ${plan.lag0.toFixed(1)}s`,
                   ramps: [{ p: "out.rate", to: 0, at: G, dur: 20 },
                           { p: "out.rate", to: 1, at: G + gapMs, dur: 20 },
                           { p: "out.gain", to: 1, at: G + gapMs + 20, dur: 500, curve: "sin" }],
                   watchdogMs: (plan.cut - seekTo + plan.lag) * 1000 + 15000 });
        };
        Object.assign(st, { phase: "planned", plan, note: "", replan: false, engineDirty: true, dirtyUntil: 0, preview: true,
                            expectSeek: { to: seekTo, until: Date.now() + 4000, onArrive } });
        if (Math.abs(S.Player.getProgress() / 1000 - seekTo) >= 1.5) S.Player.seek(Math.round(seekTo * 1000));
        if (!S.Player.isPlaying()) S.Player.play();
        S.showNotification(`Preview · ${MODE_NAMES[plan.mode]} in ~${Math.round(gapMs / 1000 + PREVIEW_LEAD + 1)} s`);
    }

    function startTicker(ms) {
        const run = () => { try { tick(); } catch (e) { console.error("[SmartTransition]", e); } };
        try {
            const blob = new Blob([`setInterval(() => postMessage(0), ${ms});`], { type: "text/javascript" });
            const w = new Worker(URL.createObjectURL(blob));
            w.onmessage = run;
            return;
        } catch (e) { dbg("Worker unavailable, falling back to setInterval", e); }
        setInterval(run, ms);
    }

    // ─── UI ────────────────────────────────────────────────────────
    const CSS = `
.stx{--a:var(--spice-button,#1ed760);--t:var(--spice-text,#fff);--s:var(--spice-subtext,#a7a7a7);
  --f1:color-mix(in srgb,var(--t) 6%,transparent);--f2:color-mix(in srgb,var(--t) 10%,transparent);--f3:color-mix(in srgb,var(--t) 18%,transparent);
  color:var(--t);font-size:14px;line-height:1.4;width:min(420px,78vw);-webkit-font-smoothing:antialiased}
.stx *{box-sizing:border-box}
.stx-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.stx-status{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--s);min-width:0}
.stx-status span:last-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stx-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--s)}
.stx-dot.live{background:var(--a);box-shadow:0 0 0 3px color-mix(in srgb,var(--a) 22%,transparent)}
.stx-dot.warn{background:#f5a524}
.stx-card{background:var(--f1);border-radius:14px;padding:16px 16px 14px;margin-bottom:22px;min-height:132px}
.stx-eyebrow{font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--s)}
.stx-mode{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-top:6px}
.stx-mode b{font-size:22px;font-weight:800;letter-spacing:-.01em}
.stx-when{font-size:12px;font-weight:600;color:var(--s);font-variant-numeric:tabular-nums;white-space:nowrap}
.stx-when.now{color:var(--a)}
.stx-tracks{font-size:13px;color:var(--s);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stx-tracks i{font-style:normal;opacity:.6;padding:0 6px}
.stx-line{position:relative;height:4px;border-radius:2px;background:var(--f2);margin:16px 0 8px}
.stx-zone,.stx-ease,.stx-skip{position:absolute;top:0;bottom:0;border-radius:2px}
.stx-zone{background:var(--a);min-width:3px}
.stx-ease{background:var(--a);opacity:.3}
.stx-skip{background:repeating-linear-gradient(90deg,var(--f3) 0 3px,transparent 3px 6px)}
.stx-legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--s);margin-bottom:12px;font-variant-numeric:tabular-nums}
.stx-legend i{display:inline-block;width:10px;height:4px;border-radius:2px;margin-right:5px;vertical-align:middle;background:var(--a)}
.stx-legend i.e{opacity:.35}
.stx-legend i.s{background:repeating-linear-gradient(90deg,var(--s) 0 2px,transparent 2px 4px)}
.stx-ph{position:absolute;top:50%;width:9px;height:9px;margin:-4.5px 0 0 -4.5px;border-radius:50%;background:var(--t);transition:left .25s linear}
.stx-chips{display:flex;flex-wrap:wrap;gap:6px}
.stx-chip{font-size:11px;font-weight:600;padding:3px 9px;border-radius:999px;background:var(--f2);font-variant-numeric:tabular-nums}
.stx-chip.warn{color:#f5a524}
.stx-why{font-size:12px;color:var(--s);margin-top:10px}
.stx-empty{display:flex;flex-direction:column;justify-content:center;min-height:100px}
.stx-empty b{font-size:16px;font-weight:700;margin-bottom:3px}
.stx-empty span{font-size:12.5px;color:var(--s)}
.stx-empty a{color:var(--t);text-decoration:underline;text-underline-offset:2px}
.stx-sec{margin-bottom:6px}
.stx-seg{display:flex;background:var(--f1);border-radius:9px;padding:3px;margin-top:8px}
.stx-seg button{flex:1;border:0;background:transparent;color:var(--s);font:inherit;font-size:12.5px;font-weight:600;padding:6px 10px;border-radius:7px;cursor:pointer;transition:background .15s,color .15s}
.stx-seg button:hover{color:var(--t)}
.stx-seg button.on{background:var(--f3);color:var(--t)}
.stx-seg.sm{display:inline-flex;margin:0}
.stx-seg.sm button{flex:none;padding:5px 10px}
.stx-hint{font-size:12px;color:var(--s);margin:8px 2px 12px;min-height:17px}
.stx-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:11px 0;border-top:1px solid var(--f1);transition:opacity .2s}
.stx-row.dim{opacity:.35;pointer-events:none}
.stx-sw{appearance:none;-webkit-appearance:none;flex:none;width:34px;height:20px;border-radius:10px;background:var(--f3);position:relative;cursor:pointer;transition:background .2s;margin:0;outline:none}
.stx-sw::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .2s}
.stx-sw:checked{background:var(--a)}
.stx-sw:checked::after{transform:translateX(14px)}
.stx-adv{border-top:1px solid var(--f1)}
.stx-adv summary{list-style:none;cursor:pointer;font-size:12px;font-weight:600;color:var(--s);padding:12px 0;display:flex;align-items:center;gap:6px;user-select:none}
.stx-adv summary::-webkit-details-marker{display:none}
.stx-adv summary::before{content:"";width:5px;height:5px;border:solid currentColor;border-width:0 1.5px 1.5px 0;transform:rotate(-45deg);transition:transform .2s;margin-right:2px}
.stx-adv[open] summary::before{transform:rotate(45deg)}
.stx-adv .stx-row{font-size:13px}
.stx-foot{display:flex;justify-content:space-between;align-items:center;margin-top:16px;gap:12px}
.stx-ver{font-size:11px;color:var(--s);opacity:.7}
.stx-btn{border:0;border-radius:999px;padding:8px 18px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;background:var(--t);color:var(--spice-main,#121212);transition:transform .1s,opacity .2s}
.stx-btn:hover{transform:scale(1.03)}
.stx-btn:disabled{opacity:.3;cursor:default;transform:none}
.stx.off .stx-body{opacity:.4;pointer-events:none}
`;
    function injectCSS() {
        if (document.getElementById("stx-css")) return;
        const el = document.createElement("style");
        el.id = "stx-css"; el.textContent = CSS;
        document.head.appendChild(el);
    }

    const ICON = `<svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M1.5 11.5c2.6 0 3.4-7 6.5-7M8 11.5c3.1 0 3.9-7 6.5-7"/></svg>`;
    let button = null;

    function engineState() {
        if (!engine.connected) return { cls: "", text: "Offline" };
        if (!engine.keylock) return { cls: "warn", text: "Update needed" };
        if (!engine.tapping) return { cls: "warn", text: "No audio" };
        return { cls: "live", text: `Live · ${engine.output}` };
    }
    function refreshButton() {
        if (!button) return;
        button.label = `Smart Transition · ${!cfg.enabled ? "Off" : ready() ? "Live" : "Offline"}`;
        if (button.element?.style) button.element.style.opacity = cfg.enabled && ready() ? "1" : "0.5";
    }

    const empty = (title, sub) => `<div class="stx-empty"><b>${title}</b><span>${sub}</span></div>`;

    function cardHTML() {
        if (!engine.connected) return empty("Engine offline", `Install and open <a href="${RELEASES}">SmartFade.app</a> to enable transitions.`);
        if (!engine.keylock) return empty("Update required", "Relaunch the latest SmartFade.app.");
        if (!engine.tapping) return empty("Waiting for audio", "Start playback in Spotify.");
        if (!cfg.enabled) return empty("Transitions off", "Tracks will play back to back.");

        const mixing = lastMix && Date.now() < lastMix.until;
        const plan = st.plan || (mixing ? lastMix.plan : null);
        if (!plan) {
            if (st.phase === "cutting") return empty("Mixing…", "");
            if (st.planning || (!st.note && st.uri)) return empty("Analyzing…", "Reading the structure of both tracks.");
            return empty("No transition", esc(st.note || "Nothing to mix into."));
        }

        const live = !st.plan || st.phase === "prepped" || st.phase === "cutting";
        const p = st.plan ? S.Player.getProgress() / 1000 : plan.cut;
        // The playhead is what you hear, which runs behind Spotify's own progress bar by the lag built so far
        let heard = p;
        if (!st.plan) heard = Math.min(plan.cut, plan.cut - plan.lag + (Date.now() - lastMix.cutWall) / 1000 * (plan.match?.r || 1));
        else if (st.phase === "prepped" || st.phase === "cutting" || (st.preview && !st.expectSeek)) heard = p - lagAt(plan, p);
        const echo = plan.mode === "echo";
        const zStart = echo ? plan.outStart : plan.cut - plan.lag;
        const eStart = echo ? zStart : Math.min(plan.driftStart ?? zStart, plan.cut - (plan.match?.rampSec || 0));
        let when;
        if (st.expectSeek) when = "Preparing…";
        else if (!st.plan || st.phase === "cutting") when = "Mixing";
        else if (p >= plan.cut - 0.5) when = "Now";
        else when = `in ${fmt(plan.cut - p)}`;

        const pct = (x) => `${clamp(x / plan.dur, 0, 1) * 100}%`;
        const span = (cls, a, b) => b - a > 0.05 ? `<div class="${cls}" style="left:${pct(a)};width:calc(${pct(b)} - ${pct(a)})"></div>` : "";
        const skip = plan.dur - plan.cut;
        const legend = [];
        if (!echo && zStart - eStart > 1) legend.push(`<span><i class="e"></i>Ease in ${fmt(eStart)}</span>`);
        legend.push(`<span><i></i>${echo ? "Echo" : "Mix"} ${fmt(zStart)}–${fmt(plan.cut)}</span>`);
        if (skip > 1) legend.push(`<span><i class="s"></i>Skips last ${fmt(skip)}</span>`);
        const shortened = !echo && plan.want && plan.lag < plan.want - 0.4;

        const c = plan.assess || {};
        const chips = [];
        if (plan.bpmA && plan.bpmB) {
            const r = plan.match?.r ?? 1;
            const stretch = Math.abs(r - 1) > 0.002 ? ` · ${r > 1 ? "+" : "−"}${(Math.abs(r - 1) * 100).toFixed(1)}%` : "";
            chips.push(`${Math.round(plan.bpmA)} → ${Math.round(plan.bpmB)} BPM${stretch}`);
        }
        if (c.keyA && c.keyB) chips.push(`<span class="stx-chip${c.keyOK ? "" : " warn"}">${c.keyA} → ${c.keyB}</span>`);
        if (!echo) chips.push(shortened ? `<span class="stx-chip warn">${plan.overlap.toFixed(1)}s overlap · shortened</span>` : `${plan.overlap.toFixed(1)}s overlap`);

        const eyebrow = !st.plan ? "Mixing" : st.preview ? "Preview" : st.phase === "prepped" && heard < p - 0.2 ? "Easing in" : "Up next";
        const why = shortened ? "Started late in the track, so there was less time to build the overlap. Preview plays the full version." : plan.reason;
        return `
            <span class="stx-eyebrow">${eyebrow}</span>
            <div class="stx-mode"><b>${MODE_NAMES[plan.mode]}</b><span class="stx-when${when === "Now" || when === "Mixing" || live ? " now" : ""}">${when}</span></div>
            <div class="stx-tracks">${esc(plan.from) || "This track"}<i>→</i>${esc(plan.to) || "Next track"}</div>
            <div class="stx-line">${span("stx-ease", eStart, zStart)}${span("stx-zone", zStart, plan.cut)}${span("stx-skip", plan.cut, plan.dur)}<div class="stx-ph" style="left:${pct(heard)}"></div></div>
            <div class="stx-legend">${legend.join("")}</div>
            <div class="stx-chips">${chips.map((x) => x.startsWith("<") ? x : `<span class="stx-chip">${x}</span>`).join("")}</div>
            <div class="stx-why">${esc(why)}</div>`;
    }

    function openSettings() {
        injectCSS();
        const wrap = document.createElement("div");
        wrap.className = "stx";
        const seg = (key, opts, cls = "") => `<div class="stx-seg ${cls}" data-key="${key}">${
            opts.map(([v, label]) => `<button data-v="${v}" class="${String(cfg[key]) === String(v) ? "on" : ""}">${label}</button>`).join("")}</div>`;
        const sw = (key) => `<input type="checkbox" class="stx-sw" data-key="${key}" ${cfg[key] ? "checked" : ""}>`;
        const row = (label, ctl, cls = "") => `<div class="stx-row ${cls}"><span>${label}</span>${ctl}</div>`;

        wrap.innerHTML = `
            <div class="stx-top">
                <div class="stx-status"><span class="stx-dot"></span><span class="stx-st"></span></div>
                ${sw("enabled")}
            </div>
            <div class="stx-body">
                <div class="stx-card"></div>
                <div class="stx-sec">
                    <span class="stx-eyebrow">Style</span>
                    ${seg("style", Object.entries(STYLES).map(([k, v]) => [k, v.name]))}
                    <div class="stx-hint"></div>
                </div>
                ${row("Overlap", seg("overlap", [["short", "Short"], ["medium", "Medium"], ["long", "Long"]], "sm"), "stx-ov")}
                ${row("Beat-match", sw("beatmatch"), "stx-ov")}
                ${row("Max tempo stretch", seg("maxStretch", [[0.03, "3%"], [0.06, "6%"], [0.08, "8%"]], "sm"), "stx-ov stx-bm")}
                <details class="stx-adv">
                    <summary>Advanced</summary>
                    ${row("Skip long fade-outs", sw("trimOutro"))}
                    ${row("Trim silence", sw("trimSilence"))}
                    ${row("Gapless within albums", sw("skipSameAlbum"))}
                    ${row("Debug logging", sw("debug"))}
                </details>
                <div class="stx-foot">
                    <span class="stx-ver"></span>
                    <button class="stx-btn stx-preview">Preview</button>
                </div>
            </div>`;

        const q = (s) => wrap.querySelector(s);
        const qa = (s) => wrap.querySelectorAll(s);

        function renderStatic() {
            wrap.classList.toggle("off", !cfg.enabled);
            q(".stx-hint").textContent = STYLES[cfg.style].hint;
            qa(".stx-ov").forEach((el) => el.classList.toggle("dim", cfg.style === "echo"));
            q(".stx-bm").classList.toggle("dim", cfg.style === "echo" || !cfg.beatmatch);
        }
        function renderLive() {
            const es = engineState();
            q(".stx-dot").className = `stx-dot ${es.cls}`;
            q(".stx-st").textContent = es.text;
            q(".stx-card").innerHTML = cardHTML();
            q(".stx-ver").textContent = engine.version ? `SmartFade ${engine.version} · Extension 0.7` : "Extension 0.7";
            q(".stx-preview").disabled = !ready() || !cfg.enabled || st.phase === "cutting" || !!st.expectSeek ||
                !nextTrackInfo()?.uri?.startsWith("spotify:track:");
        }

        const apply = () => {
            saveCfg();
            if (!cfg.enabled) cancel("disabled");
            else if (st.phase === "idle" || (st.phase === "planned" && !st.engineDirty)) { st.gen++; st.planning = false; st.replan = true; st.note = ""; st.retryAt = 0; }
            refreshButton(); renderStatic(); renderLive();
        };
        qa(".stx-seg").forEach((g) => g.addEventListener("click", (e) => {
            const b = e.target.closest("button"); if (!b) return;
            const key = g.dataset.key, v = b.dataset.v;
            cfg[key] = typeof DEFAULTS[key] === "number" ? +v : v;
            g.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
            apply();
        }));
        qa(".stx-sw").forEach((el) => el.addEventListener("change", () => { cfg[el.dataset.key] = el.checked; apply(); }));
        q(".stx-preview").onclick = () => { S.PopupModal.hide(); startPreview(); };

        renderStatic(); renderLive();
        const timer = setInterval(() => { if (!wrap.isConnected) { clearInterval(timer); return; } renderLive(); }, 500);
        S.PopupModal.display({ title: "Smart Transition", content: wrap });
    }

    button = new S.Topbar.Button("Smart Transition", ICON, openSettings);
    refreshButton();
    connect();
    startTicker(40);
    window.smartTransition = { state: () => st, engine: () => engine, cfg,
                               _test: { computePlan, lagAt, startPreview, prepSchedule, cutSchedule, inSchedule, assess, camelot, keyCompat, cardHTML } };
})();
