// Shared RGSS engine core. RPG Maker XP/VX/VX Ace ports are near-identical
// whichever runtime plays them — same strip list, name normalization, gptk,
// boxart, RTP handling, port layout. The only differences are which games an
// engine claims, which runtime/launch script it targets, and its config file.
// `createRgssEngine(cfg)` bakes those in; rgss.js and rgss-legacy.js are thin.
import {
    text, entriesIn, reroot, dirname, basename, depth, slugify, safeName, manifest,
} from "../core.js";

const enc = (s) => new TextEncoder().encode(s);

// --- Windows engine / cruft that must NOT enter the port ---------------------
const STRIP_NAMES = new Set([
    "game.exe", "install_or_update.bat", "launch-wine.sh", ".ds_store",
    "savefile.lnk", "credits.txt", "readme.txt", "readme.md",
]);
const STRIP_EXTS = new Set(["exe", "dll", "bat", "lnk"]);
const STRIP_DIRS = new Set([".git", ".idea", "required_by_installer_updater"]);

function isStripped(path) {
    const name = basename(path).toLowerCase();
    const top = path.split("/")[0].toLowerCase();
    if (STRIP_DIRS.has(top)) return true;
    if (STRIP_NAMES.has(name)) return true;
    const dot = name.lastIndexOf(".");
    return dot >= 0 && STRIP_EXTS.has(name.slice(dot + 1));
}

const GPTK =
    "back = esc\nstart = enter\na = z\nb = x\nx = a\ny = s\nl1 = q\nr1 = w\n" +
    "up = up\ndown = down\nleft = left\nright = right\n";

// --- RTP dependency table (official rights-holder downloads) ------------------
const RTP = {
    RPGXP:    { label: "RPG Maker XP RTP",     folder: "RPGXP",    url: "https://dl.komodo.jp/rpgmakerweb/run-time-packages/rpgxp_rtp103e.zip", verified: false },
    RPGVX:    { label: "RPG Maker VX RTP",     folder: "RPGVX",    url: "https://dl.komodo.jp/rpgmakerweb/run-time-packages/vx_rtp102e.zip",     verified: true },
    RPGVXAce: { label: "RPG Maker VX Ace RTP", folder: "RPGVXAce", url: "https://dl.komodo.jp/rpgmakerweb/run-time-packages/RPGVXAce_RTP.zip",  verified: true },
};
export const RTP_SHARED_DIR = ".rtp"; // sibling of the port dirs, under ports/
export const rtpRef = (folder) => `../${RTP_SHARED_DIR}/${folder}`;

const EXTRACT_STEPS = [
    "Unzip the download — you'll get RTP*/Setup.exe + Setup-1.bin.",
    "Extract Setup.exe with innoextract (NOT 7-Zip — the data is in the .bin):",
    "Drop the resulting folder (the one holding Graphics/ and Audio/) below.",
];
const EXTRACT_CMD =
    "cd RTP*/ && nix-shell -p innoextract --run 'innoextract Setup.exe'\n" +
    "# not on Nix? install innoextract (constexpr.org/innoextract) then: innoextract Setup.exe";

// --- ini parsing + detection helpers -----------------------------------------
function parseIni(t) {
    let title = "", library = "", rtp = "";
    for (const raw of t.split(/\r?\n/)) {
        const line = raw.trim();
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim().toLowerCase();
        const val = line.slice(eq + 1).trim();
        if (key === "title") title = val;
        else if (key === "library") library = val;
        else if (key === "rtp") rtp = val;
    }
    return { title, library, rtp };
}

function findGameIni(tree) {
    const inis = tree
        .filter((f) => /\.ini$/i.test(f.path))
        .filter((f) => text(f.bytes).split(/\r?\n/).some((l) => {
            const u = l.trim().toUpperCase();
            return u.startsWith("LIBRARY=") && u.includes("RGSS");
        }));
    if (!inis.length) return null;
    inis.sort((a, b) => {
        const ga = basename(a.path).toLowerCase() === "game.ini" ? 0 : 1;
        const gb = basename(b.path).toLowerCase() === "game.ini" ? 0 : 1;
        return ga - gb || depth(a.path) - depth(b.path) || a.path.localeCompare(b.path);
    });
    return inis[0];
}

function rgssVersion(library) {
    const m = library.toUpperCase().match(/RGSS(\d)/);
    const n = m ? Number(m[1]) : 0;
    return { 1: { n: 1, name: "XP" }, 2: { n: 2, name: "VX" }, 3: { n: 3, name: "VX Ace" } }[n] || { n: 0, name: "unknown" };
}

function normalizeRtpKey(rtp) {
    const u = rtp.trim().toUpperCase();
    if (u === "RPGVXACE") return "RPGVXAce";
    if (u === "RPGVX") return "RPGVX";
    if (u === "RPGXP") return "RPGXP";
    return null;
}

/// Patch mount paths from a game's own mkxp.json `patches` array. Regex, not
/// JSON.parse — real mkxp.json files use trailing commas (invalid JSON). mkxp-z
/// FATALS if a configured patch dir is missing, and browser folder-ingest drops
/// empty dirs, so the port must recreate them.
function patchDirs(mkxpText) {
    const m = mkxpText.match(/"patches"\s*:\s*\[([^\]]*)\]/);
    if (!m) return [];
    return [...m[1].matchAll(/"([^"]+)"/g)]
        .map((x) => x[1])
        .filter((p) => p && !p.includes("..") && !p.startsWith("/"));
}

/// Blocking-ish warnings about a detected game — things that will stop it
/// running on the handheld no matter which engine, surfaced BEFORE the user
/// builds/installs. Today: bundled native Ruby gems (.so), which are built for
/// PC and can't load on the device's engine.
function detectWarnings(tree, gameRoot) {
    const prefix = gameRoot ? gameRoot + "/" : "";
    // Only native GEMS (gems/*.so) are the hazard — a bundled native extension
    // the game loads via rubygems, built for PC (e.g. a bundled discord.so).
    // NOT the bundled Ruby/SDL runtime in lib/, lib64/, libs/ (libruby.so.3.1,
    // libcrypt…): those are just dead weight — the device supplies its own
    // runtime — so flagging them would be a false positive.
    const natives = tree
        .map((f) => f.path)
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length))
        .filter((p) => /(^|\/)gems\/.+\.so(\.\d+)*$/i.test(p));
    const w = [];
    if (natives.length) {
        w.push({
            level: "error",
            title: "Bundled native gem won't run on the handheld",
            detail:
                "This game loads a native Ruby gem (.so) built for PC. The device " +
                "engine can't load it, so it will likely crash on launch. Not " +
                "fixable by Port Forge — it's the game's own dependency.",
            items: natives.slice(0, 8),
        });
    }
    return w;
}

/// Engine-neutral RGSS detection: does the tree hold an RGSS game, and what is
/// it? Returns the shared detection facts (no engine identity) or null.
export function baseDetect(tree) {
    const ini = findGameIni(tree);
    if (!ini) return null;
    const root = dirname(ini.path);
    const rootFiles = entriesIn(tree, root).map((f) => basename(f.path).toLowerCase());
    const { title, library, rtp } = parseIni(text(ini.bytes));
    const ver = rgssVersion(library);
    const t = title || basename(root) || "Game";
    const slug = slugify(t);
    return {
        gameRoot: root,
        iniName: basename(ini.path),
        title: t,
        engineName: ver.name,
        rgssVersion: ver.n,
        library,
        ownConfig: rootFiles.includes("mkxp.json"),
        rtpKey: normalizeRtpKey(rtp),
        archives: rootFiles.filter((n) => /\.(rgssad|rgss2a|rgss3a)$/i.test(n)),
        slug,
        safe: safeName(t, slug),
    };
}

// --- boxart (light port of the device heuristic) -----------------------------
function pngDims(bytes) {
    if (bytes.length < 24) return null;
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;
    const be = (o) => (bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3];
    return { w: be(16) >>> 0, h: be(20) >>> 0 };
}
function pickBoxart(game) {
    const POS = ["title", "intro", "splash", "cover", "boxart", "logo"];
    const NEG = ["background", "bg", "effect", "particle", "shine", "bar", "overlay", "sil", "light", "gradient", "credit", "under", "oculta"];
    let best = null, fallback = null;
    for (const f of game) {
        if (!/^graphics\/titles\/[^/]+\.png$/i.test(f.path)) continue;
        const name = basename(f.path).toLowerCase();
        const size = f.bytes.length;
        if (!fallback || size > fallback.size) fallback = { size, f };
        const d = pngDims(f.bytes);
        if (d && Math.min(d.w, d.h) >= 200) {
            let score = size;
            if (POS.some((k) => name.includes(k))) score += 3_000_000;
            if (NEG.some((k) => name.includes(k))) score -= 3_000_000;
            if (!best || score > best.score) best = { score, f };
        }
    }
    return (best || fallback)?.f || null;
}

/// Build an RGSS engine. cfg:
///   id, name, runtime          — identity + display (runtime shown in the list)
///   launchAsset                — path to its launch .sh template
///   claims(d, ctx) -> bool     — does this engine take this detected game?
///   buildConfig(rtpRef|null)   — { name, text } for the port's config file
export function createRgssEngine(cfg) {
    return {
        id: cfg.id,
        name: cfg.name,
        runtime: cfg.runtime,
        launchAsset: cfg.launchAsset,

        detect(tree, ctx) {
            const d = baseDetect(tree);
            if (!d) return null;
            if (!cfg.claims(d, ctx || {})) return null;
            return { ...d, engineId: cfg.id, warnings: detectWarnings(tree, d.gameRoot) };
        },

        dependencies(d) {
            // A game shipping its own mkxp.json is self-contained; otherwise a
            // declared RTP must be supplied by the user.
            if (d.ownConfig || !d.rtpKey || !RTP[d.rtpKey]) return [];
            const r = RTP[d.rtpKey];
            return [{
                id: d.rtpKey,
                label: r.label,
                url: r.url,
                verified: r.verified,
                provideAs: "folder",
                extractSteps: EXTRACT_STEPS,
                extractCmd: EXTRACT_CMD,
                target: `ports/${RTP_SHARED_DIR}/${r.folder}`,
            }];
        },

        plan(d, tree, provided, assets) {
            const game = reroot(tree, d.gameRoot);
            const entries = new Map();
            const put = (p, bytes) => entries.set(p, bytes);
            const PORT = `Data/ports/${d.slug}`;

            const needRtp = !d.ownConfig && d.rtpKey && RTP[d.rtpKey];
            const rtpFolder = needRtp ? RTP[d.rtpKey].folder : null;

            const renameArchive = !d.ownConfig;
            const takenArchiveExt = new Set(
                game.filter((f) => /^game\.(rgssad|rgss2a|rgss3a)$/i.test(f.path))
                    .map((f) => f.path.split(".").pop().toLowerCase())
            );

            for (const f of game) {
                if (isStripped(f.path)) continue;
                let out = f.path;
                if (renameArchive) {
                    const m = f.path.match(/^([^/]+)\.(rgssad|rgss2a|rgss3a)$/i);
                    if (m && m[1].toLowerCase() !== "game" && !takenArchiveExt.has(m[2].toLowerCase())) {
                        takenArchiveExt.add(m[2].toLowerCase());
                        out = `Game.${m[2]}`;
                    }
                }
                put(`${PORT}/${out}`, f.bytes);
            }

            // Split-asset games (e.g. Master of the Wind ships Audio/ in a
            // SEPARATE folder next to the game): if a standard RPG Maker dir is
            // missing from the game root but exists elsewhere in the drop, merge
            // it in. Only ADDS files — safe, no false positives. Benefits from
            // dropping the PARENT folder that holds both.
            const rootPrefix = d.gameRoot ? d.gameRoot + "/" : "";
            for (const std of ["Audio", "Graphics", "Fonts"]) {
                if (game.some((f) => new RegExp(`^${std}/`, "i").test(f.path))) continue;
                const grab = new RegExp(`(?:^|/)(${std}/.+)$`, "i");
                for (const f of tree) {
                    if (f.path.startsWith(rootPrefix)) continue; // already under the game root
                    const m = f.path.match(grab);
                    if (m && !isStripped(m[1])) put(`${PORT}/${m[1]}`, f.bytes);
                }
            }

            // engine stays OG: only a game WITHOUT its own config gets one
            if (!d.ownConfig) {
                if (d.iniName.toLowerCase() !== "game.ini") {
                    const src = game.find((f) => f.path === d.iniName);
                    if (src) put(`${PORT}/Game.ini`, src.bytes);
                }
                const cfgFile = cfg.buildConfig(needRtp ? rtpRef(rtpFolder) : null, d);
                put(`${PORT}/${cfgFile.name}`, enc(cfgFile.text));
            }
            // Recreate any patch dir the game's mkxp.json declares but that came
            // in empty (browser ingest drops empty dirs; mkxp-z fatals without
            // the mount) — a placeholder file materializes the directory.
            if (d.ownConfig) {
                const mk = game.find((f) => f.path.toLowerCase() === "mkxp.json");
                if (mk) {
                    const keys = [...entries.keys()];
                    for (const p of patchDirs(text(mk.bytes))) {
                        if (!keys.some((k) => k.startsWith(`${PORT}/${p}/`))) {
                            put(`${PORT}/${p}/.portforge-keep`, enc(""));
                        }
                    }
                }
            }
            put(`${PORT}/${d.slug}.gptk`, enc(GPTK));
            put(`Roms/Ports (PORTS)/${d.safe}.sh`, enc(assets.launchTemplate.replaceAll("@SLUG@", d.slug)));

            const art = pickBoxart(game);
            const boxart = art ? `${d.safe}.png` : null;
            if (art) put(`Roms/Ports (PORTS)/.media/${boxart}`, art.bytes);

            if (needRtp && provided && provided[d.rtpKey]) {
                for (const f of provided[d.rtpKey]) {
                    put(`Data/ports/${RTP_SHARED_DIR}/${rtpFolder}/${f.path}`, f.bytes);
                }
            }

            put("portforge.json", enc(manifest({
                title: d.title,
                slug: d.slug,
                script: `${d.safe}.sh`,
                boxart,
                shared: needRtp ? [`Data/ports/${RTP_SHARED_DIR}/${rtpFolder}`] : [],
            })));

            return { entries, needRtp: !!needRtp, rtpFolder };
        },
    };
}

// NOTE (parity TODO): the device also unpacks an RGSS v1 archive (Game.rgssad,
// RMXP) to loose files for FileTest.exist? probes. VX/VX Ace read archives
// natively, so no unpacking needed there; port the v1 cipher if an RMXP game
// ever needs it.
