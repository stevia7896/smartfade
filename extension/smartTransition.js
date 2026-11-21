// NAME: Smart Transition
// AUTHOR: local
// VERSION: 0.8.0
// DESCRIPTION: Smooth transitions for Spotify on macOS. Requires SmartFade.app.

(function SmartTransition() {
    const S = window.Spicetify;
    if (!S?.Player?.origin?._state || !S?.Platform?.PlayerAPI || !S?.LocalStorage || !S?.getAudioData ||
        !S?.Topbar || !S?.PopupModal || !S?.Player?.data) {
        setTimeout(SmartTransition, 300);
        return;
    }

    // ─── How it works ──────────────────────────────────────────────
    // The song plays untouched — original speed, no processing — until its last few bars. Only there:
    //   Echo out – the outgoing track darkens and thins out, its final beat trails into a tempo-synced echo,
    //              and the next track fades in under the echo.
    //   Filter   – the outgoing track sinks into a low-pass and fades; the next track rises out of one.
    // The next track also plays at original speed from its first beat; nothing is slowed, stretched or replayed.

    // ─── Config ────────────────────────────────────────────────────
    const WS_URL = "ws://127.0.0.1:17890";
    const RELEASES = "https://github.com/stevia7896/smartfade/releases/latest";
    const SETTINGS_KEY = "smarttransition:settings:v3";
    const SILENCE_DB = -45;
    const PREP_AHEAD_SEC = 2;
    const MIN_TRACK_SEC = 45;
    const MIN_TAIL_SEC = 1.5;      // shortest outro treatment worth doing
    const LENGTHS = { short: 1, medium: 2, long: 4 };    // bars of outro treatment
    const RHYTHM_CONF = 0.25;      // mean beat confidence above which a track counts as rhythmic
    const DEFAULTS = {
        enabled: true,
        style: "auto",
        overlap: "medium",          // transition length (key kept for saved settings)
        trimOutro: true,
        trimSilence: true,
        gaplessAlbums: false,       // off: albums get transitions too (replaces skipSameAlbum, which defaulted on)
        debug: false,
    };
    const STYLES = {
        auto: { name: "Auto", hint: "Echo out for rhythmic tracks, a filter fade for the rest." },
        echo: { name: "Echo out", hint: "The last beat trails into an echo while the next track fades in." },
        filter: { name: "Filter", hint: "The track sinks into a low-pass; the next one rises out of it." },
    };
    const MODE_NAMES = { echo: "Echo out", filter: "Filter fade" };

    const cfg = (() => {
        const c = { ...DEFAULTS };
        try { Object.assign(c, JSON.parse(S.LocalStorage.get(SETTINGS_KEY) || "{}")); } catch (_) {}
        if (!STYLES[c.style]) c.style = DEFAULTS.style;
        if (!LENGTHS[c.overlap]) c.overlap = DEFAULTS.overlap;
        delete c.skipSameAlbum;
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

    /** How the two tracks meet → which technique Auto picks and how the next track comes in */
    function assess(a, na, cut, firstSound) {
        const rA = beatConf(a.beats, cut - 30, cut);
        const secA = [...(a.sections || [])].reverse().find((s) => s.start < cut - 1);
        const secB = na && (na.sections || []).find((s) => s.start + s.duration > firstSound + 1);
        const rise = secA && secB ? secB.loudness - secA.loudness : 0;     // > 0: next track is louder
        const kA = keyOf(secA, a.track), kB = na && keyOf(secB, na.track);
        const keyOK = !kA || !kB || keyCompat(kA, kB);
        const info = { rA, rise, keyA: kA && `${kA.n}${kA.letter}`, keyB: kB && `${kB.n}${kB.letter}`, keyOK };
        if (rA >= RHYTHM_CONF) return { ...info, mode: "echo", reason: keyOK ? "Rhythmic ending — the last beat echoes out" : "Rhythmic ending, keys clash — shorter echo" };
        return { ...info, mode: "filter", reason: "Soft ending — filter fade" };
    }

    // ─── Planning ──────────────────────────────────────────────────
    function computePlan(uri, a, nextUri, na, pNow = 0) {
        const t = a.track, dur = t.duration;
        if (dur < MIN_TRACK_SEC) return null;
        const segs = a.segments || [], bars = a.bars || [], beats = a.beats || [];

        // 1) Cut point: end of the audible track, or a bar line shortly into a long fade-out
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

        // 3) Technique
        const c = assess(a, na, cut, firstSound);
        const mode = cfg.style === "auto" ? c.mode : cfg.style;
        const reason = cfg.style === "auto" ? c.reason : "Set manually";

        // 4) Where the outro treatment starts: N bars before the cut, on a bar line
        const nBars = LENGTHS[cfg.overlap];
        let outStart = cutIdx >= nBars ? bars[cutIdx - nBars].start : cut - nBars * 4 * beatSec;
        outStart = clamp(outStart, cut - 16, cut - MIN_TAIL_SEC);
        let late = false;
        if (outStart < pNow + PREP_AHEAD_SEC + 0.3) { outStart = pNow + PREP_AHEAD_SEC + 0.3; late = true; }   // joined late: shorter tail
        if (cut - outStart < MIN_TAIL_SEC || outStart < 10) return null;

        const bpmA = t.tempo > 0 ? t.tempo : null, bpmB = na?.track?.tempo > 0 ? na.track.tempo : null;
        // Next track's fade-in: about a bar, longer when it comes in louder than this one ends
        const inSec = clamp(4 * inBeat * (c.rise >= 6 ? 1.6 : 1), 1, 4);
        return { uri, nextUri, dur, cut, natural, beatSec, inPoint, inSec, bpmA, bpmB, assess: c, mode, reason, late,
                 outStart, prepAt: outStart, nBars };
    }

    // ─── SmartFade schedules ───────────────────────────────────────
    // Ramp times are ms from when the message arrives; "anchor: onset" ramps start when the next track's first sound arrives.
    function prepSchedule(plan, p) {
        const t0 = Math.max(0, (plan.outStart - p) * 1000), L = (plan.cut - Math.max(p, plan.outStart)) * 1000, beat = plan.beatSec * 1000;
        const tail = Math.max(300, L - beat);
        const keyOK = plan.assess?.keyOK !== false;
        if (plan.mode === "echo") {
            return {
                type: "schedule", label: "prep-echo",
                ramps: [
                    { p: "out.lp", to: 2500, at: t0, dur: tail },                          // darkens a little
                    { p: "out.hp", to: 160, at: t0 + L * 0.5, dur: Math.max(200, L * 0.5 - beat * 0.5) },   // bass thins out in the second half
                    { p: "out.gain", to: 0.9, at: t0, dur: tail },
                    { p: "send", to: 0.8, at: t0 + L - beat, dur: beat * 0.5 },         // final beat into the echo
                    { p: "out.gain", to: 0, at: t0 + L - 25, dur: 40 },                  // dry signal off at the cut, echo rings on
                    { p: "send", to: 0, at: t0 + L, dur: 30 },
                ],
                delayMs: beat, feedback: keyOK ? 0.5 : 0.38, watchdogMs: t0 + L + 8000,
            };
        }
        return {
            type: "schedule", label: "prep-filter",
            ramps: [
                { p: "out.lp", to: 450, at: t0, dur: L },
                { p: "out.hp", to: 120, at: t0 + L * 0.5, dur: L * 0.5 },
                { p: "out.gain", to: 0.55, at: t0 + L * 0.3, dur: L * 0.7, curve: "cos" },
                { p: "send", to: 0.45, at: t0 + L - beat, dur: beat * 0.5 },           // a soft tail so the end isn't abrupt
                { p: "out.gain", to: 0, at: t0 + L - 25, dur: 40 },
                { p: "send", to: 0, at: t0 + L, dur: 30 },
            ],
            delayMs: beat, feedback: 0.35, watchdogMs: t0 + L + 8000,
        };
    }

    function cutSchedule(plan) {
        const ramps = plan.mode === "echo"
            ? [{ p: "in.lp", to: 22000, at: 0, dur: 10 }, { p: "in.hp", to: 300, at: 0, dur: 10 }]
            : [{ p: "in.lp", to: 700, at: 0, dur: 10 }, { p: "in.hp", to: 10, at: 0, dur: 10 }];
        return { type: "schedule", label: `cut-${plan.mode}`, ramps, commitAt: plan.inSec * 1000 + 1500, watchdogMs: plan.inSec * 1000 + 6000 };
    }

    function inSchedule(plan) {
        const I = plan.inSec * 1000, beat = plan.beatSec * 1000;
        const ramps = plan.mode === "echo"
            ? [{ p: "in.gain", to: 1, at: 0, dur: I, curve: "sin", anchor: "onset" },
               { p: "in.hp", to: 10, at: Math.min(I * 0.5, beat * 2), dur: I, anchor: "onset" }]       // its bass arrives as the echo fades
            : [{ p: "in.gain", to: 1, at: 0, dur: I, curve: "sin", anchor: "onset" },
               { p: "in.lp", to: 22000, at: 0, dur: I * 1.4, anchor: "onset" }];                      // rises out of the low-pass
        return { type: "schedule", label: `in-${plan.mode}`, ramps, feedback: 0.35, watchdogMs: 0, onsetTimeoutMs: 1200 };
    }

    // ─── State machine ─────────────────────────────────────────────
    // idle → planned → prepped → cutting → idle (next track)
    // engineDirty: SmartFade is running a schedule for this track, so cancelling must reset it.
    const freshState = (uri) => ({ uri, phase: "idle", plan: null, planning: false, replan: false, note: "", gen: 0,
                                   lastProgress: 0, lastWall: 0, wasPlaying: true, cutAt: 0, retryAt: 0,
                                   engineDirty: false, dirtyUntil: 0, expectSeek: null, pauseGrace: 0, preview: false });
    let st = freshState(null);
    let lastMix = null;   // { plan, until } — keeps the card meaningful while the transition plays out

    const curItem = () => S.Player.data?.item;
    const nextTrackInfo = () => {
        const n = S.Queue?.nextTracks?.find((x) => x?.contextTrack?.uri && x.provider !== "ad" && x.contextTrack.uri !== "spotify:delimiter");
        return n?.contextTrack || null;
    };
    const sameAlbum = (next) => !!(cfg.gaplessAlbums && curItem()?.album?.uri && curItem().album.uri === next?.metadata?.album_uri);
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
            else if (sameAlbum(next)) note = "Same album — playing gaplessly";
            else {
                const [a, na] = await Promise.all([getAnalysis(uri), getAnalysis(nextUri)]);
                if (st !== state || state.gen !== gen) return;
                if (nextTrackInfo()?.uri !== nextUri) { note = "Queue changed"; retry = 1000; }
                else if (!a) note = "Audio analysis unavailable";
                else {
                    retry = 15000;
                    plan = computePlan(uri, a, nextUri, na, S.Player.getProgress() / 1000);
                    if (!plan) note = "Too close to the end to transition";
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
                st.engineDirty = true; st.dirtyUntil = Date.now() + plan.inSec * 1000 + 2000;   // a pause/seek mid-fade must still reset
                lastMix = { plan, until: Date.now() + plan.inSec * 1000 + 800 };
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
            if (Math.abs(p - es.to) < 1.5 || nowWall > es.until) { st.expectSeek = null; st.pauseGrace = nowWall + 2000; }
            return;
        }
        if (st.dirtyUntil && nowWall > st.dirtyUntil) { if (st.phase === "idle" || st.phase === "planned") st.engineDirty = false; st.dirtyUntil = 0; }

        if (st.phase === "cutting") {
            if (nowWall - st.cutAt > (st.plan.natural ? 3000 : 1500)) cancel("skip-failed", 15000);
            return;
        }
        if (jumped) {
            if (st.engineDirty) { cancel("seek", 300); return; }
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
    const PREVIEW_LEAD = 6;   // seconds of normal playback before the transition starts
    async function startPreview() {
        const uri = st.uri, next = nextTrackInfo(), nextUri = next?.uri;
        if (!uri || !nextUri?.startsWith("spotify:track:") || !ready() || st.phase === "cutting" || excluded(curItem())) return;
        if (sameAlbum(next)) { S.showNotification("Smart Transition · same album, plays gaplessly"); return; }
        const state = st, gen = ++st.gen;
        const [a, na] = await Promise.all([getAnalysis(uri), getAnalysis(nextUri)]);
        if (st !== state || st.gen !== gen) return;
        const full = a && computePlan(uri, a, nextUri, na, 0);
        if (!full) { S.showNotification("Smart Transition · can't preview this track"); return; }
        const seekTo = Math.max(0, full.outStart - PREVIEW_LEAD);
        const plan = computePlan(uri, a, nextUri, na, seekTo);
        plan.from = curItem()?.name || ""; plan.to = next?.metadata?.title || "";
        if (st.engineDirty) send({ type: "reset", dur: 150, reason: "preview" });
        Object.assign(st, { phase: "planned", plan, note: "", replan: false, engineDirty: false, dirtyUntil: 0, preview: true,
                            expectSeek: { to: seekTo, until: Date.now() + 4000 } });
        S.Player.seek(Math.round(seekTo * 1000));
        if (!S.Player.isPlaying()) S.Player.play();
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
.stx-zone,.stx-skip{position:absolute;top:0;bottom:0;border-radius:2px}
.stx-zone{background:var(--a);min-width:3px}
.stx-skip{background:repeating-linear-gradient(90deg,var(--f3) 0 3px,transparent 3px 6px)}
.stx-legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--s);margin-bottom:12px;font-variant-numeric:tabular-nums}
.stx-legend i{display:inline-block;width:10px;height:4px;border-radius:2px;margin-right:5px;vertical-align:middle;background:var(--a)}
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
            if (st.phase === "cutting") return empty("Transitioning…", "");
            if (st.planning || (!st.note && st.uri)) return empty("Analyzing…", "Reading the structure of both tracks.");
            return empty("No transition", esc(st.note || "Nothing to transition into."));
        }

        const live = !st.plan || st.phase === "prepped" || st.phase === "cutting";
        const p = st.plan ? S.Player.getProgress() / 1000 : plan.cut;
        let when;
        if (st.expectSeek) when = "Seeking…";
        else if (!st.plan || st.phase === "cutting") when = "Now";
        else if (p >= plan.outStart) when = "Now";
        else when = `in ${fmt(plan.outStart - p)}`;

        const pct = (x) => `${clamp(x / plan.dur, 0, 1) * 100}%`;
        const span = (cls, a, b) => b - a > 0.05 ? `<div class="${cls}" style="left:${pct(a)};width:calc(${pct(b)} - ${pct(a)})"></div>` : "";
        const skip = plan.dur - plan.cut;
        const legend = [`<span><i></i>${MODE_NAMES[plan.mode]} ${fmt(plan.outStart)}–${fmt(plan.cut)}</span>`];
        if (skip > 1) legend.push(`<span><i class="s"></i>Skips last ${fmt(skip)}</span>`);

        const c = plan.assess || {};
        const chips = [];
        if (plan.bpmA && plan.bpmB) chips.push(`${Math.round(plan.bpmA)} → ${Math.round(plan.bpmB)} BPM`);
        if (c.keyA && c.keyB) chips.push(`<span class="stx-chip${c.keyOK ? "" : " warn"}">${c.keyA} → ${c.keyB}</span>`);
        chips.push(plan.late ? `<span class="stx-chip warn">${(plan.cut - plan.outStart).toFixed(1)}s · shortened</span>`
                             : `${plan.nBars} bar${plan.nBars > 1 ? "s" : ""} · ${(plan.cut - plan.outStart).toFixed(1)}s`);

        const eyebrow = !st.plan ? "Transitioning" : st.preview ? "Preview" : "Up next";
        const why = plan.late ? "Joined late in the track, so the outro is shorter." : plan.reason;
        return `
            <span class="stx-eyebrow">${eyebrow}</span>
            <div class="stx-mode"><b>${MODE_NAMES[plan.mode]}</b><span class="stx-when${when === "Now" || live ? " now" : ""}">${when}</span></div>
            <div class="stx-tracks">${esc(plan.from) || "This track"}<i>→</i>${esc(plan.to) || "Next track"}</div>
            <div class="stx-line">${span("stx-zone", plan.outStart, plan.cut)}${span("stx-skip", plan.cut, plan.dur)}<div class="stx-ph" style="left:${pct(p)}"></div></div>
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
                ${row("Length", seg("overlap", [["short", "1 bar"], ["medium", "2 bars"], ["long", "4 bars"]], "sm"))}
                <details class="stx-adv">
                    <summary>Advanced</summary>
                    ${row("Skip long fade-outs", sw("trimOutro"))}
                    ${row("Trim silence", sw("trimSilence"))}
                    ${row("Gapless within albums", sw("gaplessAlbums"))}
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
        }
        function renderLive() {
            const es = engineState();
            q(".stx-dot").className = `stx-dot ${es.cls}`;
            q(".stx-st").textContent = es.text;
            q(".stx-card").innerHTML = cardHTML();
            q(".stx-ver").textContent = engine.version ? `SmartFade ${engine.version} · Extension 0.8` : "Extension 0.8";
            const nx = nextTrackInfo();
            q(".stx-preview").disabled = !ready() || !cfg.enabled || st.phase === "cutting" || !!st.expectSeek ||
                !nx?.uri?.startsWith("spotify:track:") || excluded(curItem()) || sameAlbum(nx);
        }

        const apply = () => {
            saveCfg();
            if (!cfg.enabled) cancel("disabled");
            else if (st.phase === "idle" || (st.phase === "planned" && !st.engineDirty)) { st.gen++; st.planning = false; st.replan = true; st.note = ""; st.retryAt = 0; }
            refreshButton(); renderStatic(); renderLive();
        };
        qa(".stx-seg").forEach((g) => g.addEventListener("click", (e) => {
            const b = e.target.closest("button"); if (!b) return;
            cfg[g.dataset.key] = b.dataset.v;
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
                               _test: { computePlan, startPreview, prepSchedule, cutSchedule, inSchedule, assess, camelot, keyCompat, cardHTML } };
})();
