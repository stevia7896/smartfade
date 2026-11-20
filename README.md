<p align="center">
  <img src="assets/icon.png" width="128" height="128" alt="">
</p>

<h1 align="center">SmartFade</h1>

<p align="center">Beat-matched transitions for Spotify on macOS.</p>

<br>

Spotify's built-in crossfade is a plain volume fade. SmartFade reads the structure of both tracks, matches their tempo, lines up the beats and swaps the bass, without repeating or skipping a note.

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/how-dark.svg">
  <img src="assets/how-light.svg" width="100%" alt="The outgoing track slows slightly, then overlaps the incoming track with beats aligned">
</picture>

## How it works

**Play.** A Spicetify extension reads Spotify's audio analysis for the current and next track: beats, bars, sections, loudness and key.

**Drift.** Over the last minute or two, the outgoing track slows by 2–5% with its pitch preserved. This builds a few seconds of buffer.

**Mix.** At the cut, the buffered tail plays over the incoming track. It is tempo-matched and beat-aligned, with a bass swap.

In *Auto*, each pair of tracks gets the technique that suits it:

| Style | Chosen when |
|---|---|
| **Blend** | Both tracks are rhythmic and their tempos are close |
| **Filter** | One track has little rhythmic drive |
| **Echo out** | Tempos or loudness are too far apart to overlap |

<p align="center">
  <img src="assets/panel.png" width="380" alt="Smart Transition settings in Spotify">
</p>

## Install

Requires macOS 14.4 or later, [Spicetify](https://spicetify.app) and the Xcode Command Line Tools.

```sh
./build.sh
open build/SmartFade.app      # allow System Audio Recording when prompted

cp extension/smartTransition.js ~/.config/spicetify/Extensions/
spicetify config extensions smartTransition.js
spicetify apply
```

Settings live behind the Smart Transition button in Spotify's top bar.

## Under the hood

- **Capture.** A Core Audio process tap captures Spotify's output and mutes the original. Nothing is installed system-wide.
- **Time-stretch.** SoundTouch-style WSOLA: untouched 60 ms segments, spliced where the waveform matches.
- **Beat alignment.** A comb filter finds the beat phase, the incoming track is offset by less than one beat, and a phase-locked loop corrects any remaining error.
- **Link.** The extension and the engine talk over a loopback WebSocket that only accepts the Spotify client.

## Notes

- SmartFade runs in the background without a Dock icon. Quit it with `pkill SmartFade` to restore Spotify's original audio.
- Logs are written to `~/Library/Logs/SmartFade.log`.
- Rebuilding changes the app's signature, so macOS asks for the recording permission again.

<br>

<sub>MIT License.</sub>
