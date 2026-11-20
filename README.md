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

Requires macOS 14.4+ and [Spicetify](https://spicetify.app).

```sh
./build.sh
open build/SmartFade.app

cp extension/smartTransition.js ~/.config/spicetify/Extensions/
spicetify config extensions smartTransition.js
spicetify apply
```

<br>

<sub>MIT License.</sub>
