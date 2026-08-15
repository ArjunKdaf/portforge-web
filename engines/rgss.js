// Engine: RPG Maker XP / VX / VX Ace on mkxp-z (Ruby 3.1) — the modern runtime.
// The catch-all: it claims every RGSS game the legacy engine didn't, so it must
// be registered LAST. Output mirrors kUI's on-device Port Forge.
import { createRgssEngine } from "./rgss-common.js";

// Generic fallback mkxp.json — vanilla mkxp-z, no engine hacks.
const MKXP_BASE = {
    rgssVersion: 0, fullscreen: true, winResizable: false, anyAltToggleFS: true,
    fixedAspectRatio: true, smoothScaling: 1, vsync: false, frameSkip: false,
    subImageFix: true, enableBlitting: false, JITEnable: true, JITMinCalls: 5000,
};
function buildMkxp(rtp) {
    const o = { ...MKXP_BASE };
    if (rtp) o.RTP = [rtp];
    return JSON.stringify(o, null, 4) + "\n";
}

export default createRgssEngine({
    id: "rgss",
    name: "RPG Maker XP / VX / VX Ace",
    runtime: "mkxp-z",
    launchAsset: "assets/launch.sh.tmpl",
    claims: () => true, // catch-all — must be registered LAST
    buildConfig: (rtp) => ({ name: "mkxp.json", text: buildMkxp(rtp) }),
});
