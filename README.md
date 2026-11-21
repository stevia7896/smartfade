<p align="center">
  <img src="assets/icon.png" width="128" height="128" alt="">
</p>

<h1 align="center">SmartFade</h1>

<p align="center">Smooth transitions for Spotify on macOS.</p>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/how-dark.svg">
  <img src="assets/how-light.svg" width="100%" alt="The song plays at original speed; only its last 1–4 bars are filtered, the final beat echoes out and the next track fades in under the echo">
</picture>

<p align="center">
  <img src="assets/panel.png" width="380" alt="Smart Transition settings in Spotify">
</p>

## Install

Requires macOS 14.4+.

Install **spicetify**(https://github.com/spicetify/cli)
1. Install **SmartFade** and [**adblockify**](https://github.com/rxri/spicetify-extensions/tree/main/adblock) from the Spicetify Marketplace.
2. Download [SmartFade](https://github.com/stevia7896/smartfade/releases/latest), drag it to Applications and open it.


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
