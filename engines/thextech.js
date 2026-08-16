// Engine: TheXTech (open-source 2D platformer engine) → the TheXTech runtime
// (GPLv3, SDL2).
//
// A TheXTech game is a complete "asset package": a folder holding gameinfo.ini +
// graphics/ (+ music/ sound/) and its episode/world files. The runtime squashfs
// provides only the engine binary; the port ships the whole game folder, which
// the engine runs against directly (force-portable). Output mirrors the
// engine-agnostic port layout.
import { reroot, basename, dirname, slugify, safeName, manifest, text } from "../core.js";

const enc = (s) => new TextEncoder().encode(s);

function cleanTitle(s) {
    if (!s) return "";
    return s
        .replace(/[-_]v?\d+(?:\.\d+)+.*$/i, " ")
        .replace(/[-_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// gameinfo.ini `[game] title="..."` is the pack's own display name.
function titleFromGameInfo(bytes) {
    for (const raw of text(bytes).split(/\r?\n/)) {
        const m = raw.match(/^\s*title\s*=\s*"?([^"\r\n]+?)"?\s*$/i);
        if (m) return m[1].trim();
    }
    return "";
}

// A TheXTech asset-package game = a root holding gameinfo.ini AND a graphics/
// dir (the renderer). That pair is the fingerprint — a bare episode
// (just .lvl/.wld, no assets) is the RTP case and is intentionally NOT claimed.
function findGame(tree) {
    const infos = tree.filter((f) => /(^|\/)gameinfo\.ini$/i.test(f.path));
    for (const info of infos) {
        const root = dirname(info.path);
        const prefix = root ? root + "/" : "";
        const hasGraphics = tree.some((f) => new RegExp(`^${prefix}graphics/`, "i").test(f.path));
        if (hasGraphics) return { root, info };
    }
    return null;
}

export default {
    id: "thextech",
    name: "TheXTech",
    runtime: "thextech",
    launchAsset: "assets/launch-thextech.sh.tmpl",

    detect(tree) {
        const g = findGame(tree);
        if (!g) return null;
        const title = titleFromGameInfo(g.info.bytes) || cleanTitle(basename(g.root)) || "Game";
        const slug = slugify(title);
        return {
            engineId: "thextech",
            gameRoot: g.root,
            title,
            slug,
            safe: safeName(title, slug),
            warnings: [],
        };
    },

    // The runtime bundles the engine — nothing for the user to supply. (Vanilla
    // engine episodes that need the original copyrighted assets are a separate,
    // not-yet-supported case; a complete asset package is self-contained.)
    dependencies() {
        return [];
    },

    plan(d, tree, _provided, assets) {
        const game = reroot(tree, d.gameRoot);
        const entries = new Map();
        const put = (p, bytes) => entries.set(p, bytes);
        const PORT = `Data/ports/${d.slug}`;

        // ship the whole game folder (assets + episodes); the engine comes from
        // the runtime and is materialized into this dir at launch.
        for (const f of game) put(`${PORT}/${f.path}`, f.bytes);

        put(`Roms/Ports (PORTS)/${d.safe}.sh`, enc(assets.launchTemplate.replaceAll("@SLUG@", d.slug)));

        put("portforge.json", enc(manifest({
            title: d.title,
            slug: d.slug,
            script: `${d.safe}.sh`,
            boxart: null,
            shared: [],
        })));

        return { entries };
    },
};
