// Engine: RPG Maker 2000 / 2003 → EasyRPG Player (GPLv3, software-rendered).
//
// A distinct family from RGSS (XP/VX/VX Ace): these games carry an RPG_RT.ldb
// database and no RGSS scripts, so detection never collides with the
// mkxp-z/falcon engines — order in the registry doesn't matter for correctness.
// EasyRPG reads the game folder as-is (no conversion), and the runtime squashfs
// bundles EasyRPG's own FREE RTP replacement, so a game needs no user-supplied
// dependency. Output mirrors the engine-agnostic port layout the device
// installer reads (portforge.json).
import { text, reroot, dirname, basename, depth, slugify, safeName, manifest } from "../core.js";

const enc = (s) => new TextEncoder().encode(s);

// Windows engine + cruft that must NOT enter the port. RPG_RT.exe and the DLLs
// (harmony.dll, RPG_RT.dll) are the Windows player — stripped by extension;
// RPG_RT.ldb / RPG_RT.lmt / RPG_RT.ini are game data and are KEPT.
const STRIP_EXTS = new Set(["exe", "dll", "bat", "lnk"]);
const STRIP_NAMES = new Set([".ds_store", "thumbs.db", "readme.txt", "readme.md", "credits.txt"]);
const STRIP_DIRS = new Set([".git", ".idea", "__macosx"]);
function isStripped(path) {
    const name = basename(path).toLowerCase();
    const top = path.split("/")[0].toLowerCase();
    if (STRIP_DIRS.has(top)) return true;
    if (STRIP_NAMES.has(name)) return true;
    const dot = name.lastIndexOf(".");
    return dot >= 0 && STRIP_EXTS.has(name.slice(dot + 1));
}

// gptokeyb map for EasyRPG's default keyboard scheme: decision = Enter, cancel
// = Esc, dash = Shift. (Quit is MENU+START via the launch harness, not here.)
const GPTK =
    "a = enter\nb = escape\nx = shift\ny = space\n" +
    "up = up\ndown = down\nleft = left\nright = right\n" +
    "start = enter\nback = escape\n";

// RM2k/2k3 store the title in RPG_RT.ini under [RPG_RT] GameTitle=...
function iniTitle(t) {
    for (const raw of t.split(/\r?\n/)) {
        const line = raw.trim();
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        if (line.slice(0, eq).trim().toLowerCase() === "gametitle") return line.slice(eq + 1).trim();
    }
    return "";
}

// RM2k/2k3 title screens live in Title/. Best-effort: largest PNG there (BMP/XYZ
// title art can't be sized cheaply — skip, boxart is optional).
function pickBoxart(game) {
    let best = null;
    for (const f of game) {
        if (!/^title\/[^/]+\.png$/i.test(f.path)) continue;
        if (!best || f.bytes.length > best.bytes.length) best = f;
    }
    return best;
}

// The database file is the unambiguous RM2k/2k3 fingerprint. Prefer the
// shallowest one if a drop nests the game.
function findLdb(tree) {
    const hits = tree.filter((f) => /(^|\/)RPG_RT\.ldb$/i.test(f.path));
    if (!hits.length) return null;
    hits.sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path));
    return hits[0];
}

export default {
    id: "easyrpg",
    name: "RPG Maker 2000 / 2003",
    runtime: "easyrpg",
    launchAsset: "assets/launch-easyrpg.sh.tmpl",

    detect(tree) {
        const ldb = findLdb(tree);
        if (!ldb) return null;
        const root = dirname(ldb.path);
        const ini = tree.find(
            (f) => dirname(f.path) === root && basename(f.path).toLowerCase() === "rpg_rt.ini"
        );
        const title = (ini ? iniTitle(text(ini.bytes)) : "") || basename(root) || "Game";
        const slug = slugify(title);
        return {
            engineId: "easyrpg",
            gameRoot: root,
            title,
            slug,
            safe: safeName(title, slug),
            warnings: [],
        };
    },

    // The runtime bundles EasyRPG's free RTP, so games are self-contained here.
    dependencies() {
        return [];
    },

    plan(d, tree, _provided, assets) {
        const game = reroot(tree, d.gameRoot);
        const entries = new Map();
        const put = (p, bytes) => entries.set(p, bytes);
        const PORT = `Data/ports/${d.slug}`;

        for (const f of game) {
            if (isStripped(f.path)) continue;
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
