// Engine: Ren'Py (modern) → renpy_8.3.4 runtime (Python 3). The catch-all for
// Ren'Py games the legacy engine didn't claim, so it's registered AFTER
// renpy-legacy. Runs modern Ren'Py (7.8+/8.x).
import { createRenpyEngine } from "./renpy-common.js";

export default createRenpyEngine({
    id: "renpy",
    name: "Ren'Py",
    runtime: "renpy",
    launchAsset: "assets/launch-renpy.sh.tmpl",
    claims: () => true, // catch-all — must be registered after renpy-legacy
});
