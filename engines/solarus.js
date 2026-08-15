// Engine: Solarus (top-down action-RPGs) → Solarus runtime (GPLv3, SDL2).
//
// A Solarus game is a "quest": distributed either as a single `.solarus`
// package (a zip of the quest's data/) or as an extracted quest folder holding
// `data/project_db.dat`. The runtime squashfs provides the engine; the port
// ships only the quest. Output mirrors the engine-agnostic port layout.
import { reroot, basename, dirname, slugify, safeName, manifest } from "../core.js";

const enc = (s) => new TextEncoder().encode(s);

// gptokeyb map for Solarus's default keyboard scheme: move = arrows, action =
// Space, sword/cancel = C, items = X/V, pause = D. (Quit is MENU+START via the
// launch harness.) Finalized against the shipped Solarus port's own .gptk.
const GPTK =
    "a = space\nb = c\nx = x\ny = v\n" +
    "up = up\ndown = down\nleft = left\nright = right\n" +
    "start = d\nback = escape\n";

// Strip version tails so the title/slug is the game, not the build
// (e.g. "zsdx-v1.12.3" -> "zsdx", "Mystery of Solarus DX-1.12" -> "...DX").
function cleanTitle(s) {
    if (!s) return "";
    return s
        .replace(/[-_]v?\d+(?:\.\d+)+.*$/i, " ")
        .replace(/[-_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// A Solarus quest: a `.solarus` package, or an extracted quest (data/project_db.dat).
function findQuest(tree) {
    const pkg = tree.find((f) => /\.solarus$/i.test(f.path));
    if (pkg) {
        const root = dirname(pkg.path);
        return { kind: "package", root, rel: root ? pkg.path.slice(root.length + 1) : pkg.path };
    }
    const db = tree.find((f) => /(^|\/)data\/project_db\.dat$/i.test(f.path));
    if (db) {
        const segs = db.path.split("/");
        const di = segs.findIndex((s) => s.toLowerCase() === "data");
        return { kind: "dir", root: segs.slice(0, di).join("/") };
    }
    return null;
}

export default {
    id: "solarus",
    name: "Solarus",
    runtime: "solarus",
    launchAsset: "assets/launch-solarus.sh.tmpl",

    detect(tree) {
        const q = findQuest(tree);
        if (!q) return null;
        const fromFile = q.kind === "package" ? basename(q.rel).replace(/\.solarus$/i, "") : "";
        const title = cleanTitle(basename(q.root)) || cleanTitle(fromFile) || basename(q.root) || "Game";
        const slug = slugify(title);
        return {
            engineId: "solarus",
            gameRoot: q.root,
            questKind: q.kind,
            questRel: q.rel || null,
            title,
            slug,
            safe: safeName(title, slug),
            warnings: [],
        };
    },

    // The runtime bundles the engine — nothing for the user to supply.
    dependencies() {
        return [];
    },

    plan(d, tree, _provided, assets) {
        const game = reroot(tree, d.gameRoot);
        const entries = new Map();
        const put = (p, bytes) => entries.set(p, bytes);
        const PORT = `Data/ports/${d.slug}`;

        if (d.questKind === "package") {
            // ship the .solarus package as a stable name
            const pkg = game.find((f) => f.path === d.questRel);
            if (pkg) put(`${PORT}/${d.slug}.solarus`, pkg.bytes);
        } else {
            // ship the extracted quest (its data/ tree)
            for (const f of game) {
                if (!/^data\//i.test(f.path)) continue;
                put(`${PORT}/${f.path}`, f.bytes);
            }
        }

        put(`${PORT}/${d.slug}.gptk`, enc(GPTK));
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
