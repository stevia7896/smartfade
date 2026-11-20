<p align="center">
  <img src="assets/icon.png" width="128" height="128" alt="">
</p>

<h1 align="center">SmartFade</h1>

<p align="center">Crossfade for Spotify free on macOS.</p>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/how-dark.svg">
  <img src="assets/how-light.svg" width="100%" alt="The outgoing track slows slightly, then overlaps the incoming track with beats aligned">
</picture>

<p align="center">
  <img src="assets/panel.png" width="380" alt="Smart Transition settings in Spotify">
</p>

## Install

Requires macOS 14.4+.

1. Install **SmartFade** from the Spicetify Marketplace.
2. Download [SmartFade.app](https://github.com/stevia7896/smartfade/releases/latest), move it to Applications and open it.

The app isn't notarized. On first launch, allow it in System Settings → Privacy & Security.

<details>
<summary>Build from source</summary>

```sh
./build.sh
open build/SmartFade.app

cp extension/smartTransition.js ~/.config/spicetify/Extensions/
spicetify config extensions smartTransition.js
spicetify apply
```

</details>

<br>

<sub>MIT License.</sub>
