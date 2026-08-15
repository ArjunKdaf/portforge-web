# Port Forge (web)

A browser tool that turns a PC game into a **PortMaster-ready port**. Everything
runs locally in your browser — nothing is uploaded. Drop a game, the site tells
you which dependencies it needs (with official links), you provide them, and it
hands back a single zip you extract onto your device's SD card and install with
Port Forge.

It reuses the real tools — [mkxp-z](https://github.com/mkxp-z/mkxp-z) (the
engine), [innoextract](https://constexpr.org/innoextract/) (you run it once on
your PC to extract an RTP), and the official RTPs — and only adds the glue:
detection, the dependency checklist, and assembly.

## Engines

The core is engine-agnostic. Each engine is a module in `engines/` that knows how
to recognize its games, what they depend on, and how to lay out a port. Today:

- **`rgss`** — RPG Maker XP / VX / VX Ace, run by mkxp-z. Mirrors kUI's on-device
  Port Forge byte-for-byte, and adds RTP handling.

Adding GameMaker, Godot, RPG Maker MV, … is a new module registered in
`engines/index.js`. Nothing else changes.

## Run locally

ES modules + `fetch()` need HTTP (not `file://`):

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Test

```sh
node test/test.mjs
```

## How the RTP is handled

Games that declare an RTP (`RTP=RPGVXAce` in `Game.ini`) don't bundle the stock
assets. The site:

1. Lists the official RTP download + how to extract it (Inno Setup → innoextract).
2. Takes the folder you extracted and bundles it once, shared, at
   `ports/.rtp/<pack>/`.
3. Points the port's `mkxp.json` at it **relatively** (`"RTP": ["../.rtp/<pack>"]`),
   so it works on any PortMaster device, not a specific card.

## Open items

- Confirm mkxp-z resolves the relative `../.rtp/<pack>` RTP path against the game
  dir on-device (one constant in `engines/rgss.js` if it needs an absolute path).
- Verify the official **XP** RTP URL (`rgss.js` marks it `verified: false`; VX and
  VX Ace are verified).
- Parity: the device also unpacks an RGSS **v1** archive (`Game.rgssad`, RMXP) to
  loose files. VX/VX Ace need no unpacking; port the v1 cipher here if an RMXP
  game ever needs it.
