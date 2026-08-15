// Shared Ren'Py engine core. A Ren'Py game is a folder with a `game/` subdir
// holding Ren'Py content (.rpa archives / .rpyc compiled / .rpy source). The
// port ships ONLY `game/` — the runtime squashfs provides the whole engine
// (Python + librenpython + lib/), so the bulky `renpy/`, `lib/`, and the
// Windows/.sh launchers are stripped. Two runtimes, split by the game's Ren'Py
// era (like RGSS's mkxp-z/falcon split):
//   renpy         → renpy_8.3.4 (Python 3) — modern games (7.8+/8.x), catch-all
//   renpy-legacy  → renpy_7.8.7 (Python 2) — classic 6.x games
// Launch mechanics are identical (mount squashfs → renpy/, bind game/ →
// renpy/game, run startRENPY); only the squashfs differs. createRenpyEngine(cfg)
// bakes in identity/runtime/launch; renpy.js and renpy-legacy.js are thin.
import { text, reroot, basename, depth, slugify, safeName, manifest } from "../core.js";

const enc = (s) => new TextEncoder().encode(s);

// gptokeyb map for Ren'Py — key names per the proven PortMaster milkinside port
// (gptokeyb wants `enter`/`esc`, NOT return/escape/lctrl, which it ignores → the
// bug where only the dpad worked). A = enter (advance/select), B/Select = esc
// (game menu), Start = enter, dpad = arrows; unused buttons disabled with ".
// (Quit is MENU+START via the launch harness.)
const GPTK =
    'back = esc\nstart = enter\na = enter\nb = esc\n' +
    'x = "\ny = "\nl1 = "\nr1 = "\n' +
    'up = up\ndown = down\nleft = left\nright = right\n';

// Strip Ren'Py distribution tails off a folder name (e.g. "Digital-linux-x86",
// "MyVN-1.2-all") so the title/slug is the game, not the build.
function cleanTitle(s) {
    if (!s) return "";
    return s
        .replace(/[-_](linux|win(?:dows|32|64)?|mac(?:osx)?|osx|pc|all|market|steam|x86[-_]?64|x86|i686|amd64|arm\w*|universal)\b/gi, " ")
        .replace(/[-_]v?\d+(?:\.\d+)+.*$/i, " ")
        .replace(/[-_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// A Ren'Py game = a `game/` dir with engine content.
export function findGameRoot(tree) {
    const markers = tree.filter((f) =>
        /(^|\/)game\/.*\.(rpa|rpyc|rpy)$/i.test(f.path) ||
        /(^|\/)game\/script_version\.txt$/i.test(f.path));
    if (!markers.length) return null;
    markers.sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path));
    const segs = markers[0].path.split("/");
    const gi = segs.findIndex((s) => s.toLowerCase() === "game");
    return segs.slice(0, gi).join("/");
}

// Title from config.name/window_title in any loose .rpy under game/; else the
// cleaned folder name (config is often packed in a .rpa).
function titleFrom(tree, root) {
    const prefix = ((root ? root + "/" : "") + "game/").toLowerCase();
    for (const f of tree) {
        if (!f.path.toLowerCase().startsWith(prefix) || !/\.rpy$/i.test(f.path)) continue;
        const m = text(f.bytes).match(/config\.(?:name|window_title)\s*=\s*_?\(?\s*["']([^"']+)["']/);
        if (m) return m[1].trim();
    }
    return cleanTitle(basename(root)) || basename(root) || "Game";
}

// Best-effort boxart: largest PNG under game/gui/.
function pickBoxart(game) {
    let best = null;
    for (const f of game) {
        if (!/^game\/gui\/.*\.png$/i.test(f.path)) continue;
        if (!best || f.bytes.length > best.bytes.length) best = f;
    }
    return best;
}

/// Classic (Python 2 → renpy_7.8.7) vs modern (Python 3 → renpy_8.3.4). The
/// split is really the Python line: Ren'Py 8 = Py3, Ren'Py 6/7 = Py2. Signals,
/// most reliable first:
///   1. an explicit `config.script_version` in a loose .rpy (<=6 → legacy);
///   2. the distro's `lib/` dir — `py3-*` = Py3 (modern), `py2-*` or old
///      un-prefixed `linux/windows/mac-*` = Py2 (legacy). Most reliable when the
///      dropped folder is a full distribution (it is, before we strip lib/);
///   3. fallback: the GUI framework — modern Ren'Py ships `game/gui/`, classic
///      6.x doesn't. (Weak: a modern game that PACKS gui/ into a .rpa slips
///      through, which is why the lib/ check comes first.)
export function isLegacyRenpy(tree, root) {
    const prefix = ((root ? root + "/" : "") + "game/").toLowerCase();
    for (const f of tree) {
        if (!f.path.toLowerCase().startsWith(prefix) || !/\.rpy$/i.test(f.path)) continue;
        const m = text(f.bytes).match(/config\.script_version\s*=\s*\(\s*(\d+)/);
        if (m) return Number(m[1]) <= 6;
    }
    const paths = tree.map((f) => f.path);
    if (paths.some((p) => /(^|\/)lib\/py3-/i.test(p))) return false;                       // Python 3 = modern
    if (paths.some((p) => /(^|\/)lib\/py2-/i.test(p))) return true;                        // Python 2 = legacy
    if (paths.some((p) => /(^|\/)lib\/(linux|windows|mac|darwin)-/i.test(p))) return true; // old 6.x (no py prefix)
    const hasGui = tree.some((f) => /(^|\/)game\/gui(\/|\.rpy)/i.test(f.path));
    return !hasGui;
}

/// Build a Ren'Py engine. cfg: id, name, runtime, launchAsset,
/// claims(tree, gameRoot) -> bool (does this engine take this game?).
export function createRenpyEngine(cfg) {
    return {
        id: cfg.id,
        name: cfg.name,
        runtime: cfg.runtime,
        launchAsset: cfg.launchAsset,

        detect(tree) {
            const root = findGameRoot(tree);
            if (root === null) return null;
            if (!cfg.claims(tree, root)) return null;
            const title = titleFrom(tree, root);
            const slug = slugify(title);
            // Only MODERN Ren'Py (7.8+/8.x, Python 3) is supported. Classic 6.x
            // (Python 2) can't run on the shipped runtime — warn up front rather
            // than build a port that fails on device.
            const warnings = isLegacyRenpy(tree, root)
                ? [{
                    level: "error",
                    title: "Classic Ren'Py (6.x) isn't supported",
                    detail:
                        "This game targets Ren'Py 6.x (Python 2). kUI ships the " +
                        "modern Ren'Py 8 (Python 3) runtime, which can't run 6.x " +
                        "games. Only Ren'Py 7.8+/8.x is supported.",
                }]
                : [];
            return {
                engineId: cfg.id,
                gameRoot: root,
                title,
                slug,
                safe: safeName(title, slug),
                warnings,
            };
        },

        dependencies() {
            return [];
        },

        plan(d, tree, _provided, assets) {
            const game = reroot(tree, d.gameRoot);
            const entries = new Map();
            const put = (p, bytes) => entries.set(p, bytes);
            const PORT = `Data/ports/${d.slug}`;

            for (const f of game) {
                if (!/^game\//i.test(f.path)) continue; // ship only game/
                put(`${PORT}/${f.path}`, f.bytes);
            }
            put(`${PORT}/${d.slug}.gptk`, enc(GPTK));
            put(`Roms/Ports (PORTS)/${d.safe}.sh`, enc(assets.launchTemplate.replaceAll("@SLUG@", d.slug)));

            const art = pickBoxart(game);
            const boxart = art ? `${d.safe}.png` : null;
            if (art) put(`Roms/Ports (PORTS)/.media/${boxart}`, art.bytes);

            put("portforge.json", enc(manifest({
                title: d.title,
                slug: d.slug,
                script: `${d.safe}.sh`,
                boxart,
                shared: [],
            })));

            return { entries };
        },
    };
}
