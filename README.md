# SmartFade

Beat-matched transitions for the Spotify desktop app on macOS.

Spotify's built-in crossfade is a plain volume fade that ignores tempo and structure. SmartFade captures Spotify's audio with a Core Audio process tap and mixes the outgoing and incoming tracks itself. A Spicetify extension plans each transition from Spotify's audio analysis.

## How it works

1. **Plan.** The extension reads the beats, bars, sections and key of both tracks and picks a technique: *Blend*, *Filter* or *Echo out*.
2. **Drift.** Over the last minute or two, the outgoing track slows by 2–5% with its pitch preserved. This quietly builds a few seconds of buffer.
3. **Mix.** At the cut, the buffered tail plays over the incoming track, tempo-matched and beat-aligned, with a bass swap.

Nothing is repeated or skipped.

## Requirements

- macOS 14.4 or later
- Spotify desktop with [Spicetify](https://spicetify.app)
- Xcode Command Line Tools

## Install

```sh
./build.sh
open build/SmartFade.app      # allow System Audio Recording when prompted

cp extension/smartTransition.js ~/.config/spicetify/Extensions/
spicetify config extensions smartTransition.js
spicetify apply
```

Settings live behind the Smart Transition button in Spotify's top bar.

## Notes

- SmartFade runs in the background with no Dock icon. Quit it with `pkill SmartFade` to restore Spotify's original audio.
- It listens on `127.0.0.1:17890` and only accepts connections from the Spotify client.
- Logs are written to `~/Library/Logs/SmartFade.log`.
- Rebuilding changes the app's signature, so macOS asks for the recording permission again.

MIT License. Not affiliated with Spotify.
