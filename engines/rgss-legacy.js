// Engine: RPG Maker XP (classic) on falcon-mkxp (Ruby 2.7) — the legacy runtime
// for pre-mkxp-z games (old Essentials-era, Ruby-1.8 idioms, Win32API input).
// Runs them OG on the runtime they were built for — NO compat loader. It claims
// a game only when the scripts carry classic-runtime fingerprints (ctx.legacy),
// so it's registered FIRST and hands everything else to the modern engine.
import { createRgssEngine } from "./rgss-common.js";

// Config for falcon-mkxp: `mkxp.conf` (INI key=value), NOT mkxp.json — falcon
// is the older mkxp lineage. Keys + the Ruby-1.8 compat preloads are taken from
// a real PortMaster classic-RMXP port (To the Moon). Those preload scripts are
// falcon's OWN (bundled with the runtime) — this is how it runs classic RGSS1
// games OG on Ruby 2.7, no loader from us.
function buildConfig(rtp) {
    // Keys from falcon-mkxp's canonical mkxp.conf, tuned for the handheld
    // (fullscreen + fixed aspect). preloadScript points at falcon's bundled
    // Win32API/Ruby-1.8 shim, which the launcher symlinks in from the runtime.
    const lines = [
        "fullscreen=true",
        "fixedAspectRatio=true",
        "winResizable=false",
        "smoothScaling=true",
        "vsync=true",
        "subImageFix=true",
        "enableBlitting=false",
        "anyAltToggleFS=true",
        "useScriptNames=true",
        "preloadScript=Falcon_preload/win32_wrap.rb",
    ];
    // TODO(runtime): falcon's RTP= takes physfs paths/archives; verify a folder
    // ref resolves on-device before relying on it for RTP-dependent classics.
    if (rtp) lines.push(`RTP=${rtp}`);
    return { name: "mkxp.conf", text: lines.join("\n") + "\n" };
}

export default createRgssEngine({
    id: "rgss-legacy",
    name: "RPG Maker XP (classic)",
    runtime: "falcon-mkxp",
    launchAsset: "assets/launch-falcon.sh.tmpl",
    claims: (d, ctx) => !d.ownConfig && !!ctx.legacy,
    buildConfig,
});
