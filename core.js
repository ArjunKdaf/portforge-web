// Port Forge (web) — engine-agnostic core.
//
// The site turns a user's game into a PortMaster-ready port, entirely in the
// browser. It knows nothing about any specific engine: it normalizes the
// dropped files into a flat tree, then asks each registered engine "is this
// yours?". The first that claims it drives detection, the dependency
// checklist, and the final assembly. Adding support for a new engine
// (GameMaker, Godot, RPG Maker MV, …) is a new module in engines/ — no change
// here.

// A normalized tree is a plain array of { path, bytes } where `path` is
// forward-slashed and relative to the drop root. Helpers below operate on it.

export const dirname = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const basename = (p) => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p);
export const depth = (p) => (p.match(/\//g) || []).length;

/// Decode bytes as text. RPG Maker .ini files are ASCII/latin1 for the fields
/// we read (Library=, RTP=, Title=); latin1 never throws on stray bytes.
export function text(bytes) {
    return new TextDecoder("latin1").decode(bytes);
}

/// Files directly inside `dir` (not in sub-folders), by tree path.
export function entriesIn(tree, dir) {
    const prefix = dir ? dir + "/" : "";
    return tree.filter((f) => f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes("/"));
}

/// Re-root a tree at `dir`: keep only what's under it, strip the prefix. Used
/// when a drop/zip wraps the game in a top folder (e.g. "MyGame/Game.ini").
export function reroot(tree, dir) {
    const prefix = dir ? dir + "/" : "";
    return tree
        .filter((f) => f.path.startsWith(prefix) && f.path.length > prefix.length)
        .map((f) => ({ path: f.path.slice(prefix.length), bytes: f.bytes }));
}

/// The Inno Setup signature, present in every Inno installer's bytes. Games or
/// RTPs delivered as an Inno .exe can't be read here (see Plan B) — the user
/// extracts them first. We only need to RECOGNIZE that case to say so.
function looksInno(tree) {
    const marker = Uint8Array.from("Inno Setup Setup Data", (c) => c.charCodeAt(0));
    for (const f of tree) {
        if (!/\.exe$/i.test(f.path)) continue;
        if (indexOfBytes(f.bytes, marker) >= 0) return true;
    }
    return false;
}

function indexOfBytes(hay, needle) {
    outer: for (let i = 0; i + needle.length <= hay.length; i++) {
        for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
        return i;
    }
    return -1;
}

/// Run the dropped tree past every engine, in order (first match wins, so more
/// specific engines go first in the registry). `ctx` carries cross-engine hints
/// computed once by the caller — notably `ctx.legacy` from the script
/// fingerprint. Returns the first match with its detection + dependency
/// checklist, or an `issue` explaining why nothing matched.
export function analyze(tree, engines, ctx = {}) {
    for (const engine of engines) {
        const detection = engine.detect(tree, ctx);
        if (detection) {
            return { engine, detection, deps: engine.dependencies(detection) };
        }
    }
    const issue = looksInno(tree)
        ? "inno"      // an installer we can't read — extract on PC first
        : "unknown";  // no recognizable game found in the drop
    return { engine: null, detection: null, deps: [], issue };
}

// --- RGSS script fingerprint (legacy vs modern) ------------------------------
// Old RMXP/Essentials games (Ruby 1.8 era) and modern mkxp-z games are BOTH
// RGSS1 with no bundled mkxp.json — the ini can't tell them apart. But the
// scripts can: `Scripts.rxdata` is a Ruby-1.8 Marshal array of
// [id, name, zlib(source)], and the sources reveal Ruby-1.8-only idioms and
// Windows input calls that only run on the classic runtime.

/// Concatenated Ruby source of all scripts in `Scripts.rxdata/.rvdata/.rvdata2`.
/// Each script's source is a zlib stream inside the Marshal blob; we scan for
/// stream starts and inflate each with the injected `inflate(bytes)` (fflate's
/// decompressSync in-browser, node:zlib in tests), which stops at the stream
/// end and ignores the trailing Marshal bytes. Format-agnostic — works for RMXP
/// (Ruby-1.8) and VX/VX Ace (Ruby-1.9+) alike, no Marshal parsing needed.
export function scriptSources(tree, inflate) {
    // The scripts are either a loose Scripts.* file, or packed inside an RGSSAD
    // v1 archive (Game.rgssad / .rgss2a — RMXP & VX both use v1). Old games that
    // pack their scripts would otherwise fingerprint as empty → mis-route.
    let b = null;
    const loose = tree.find((x) => /(^|\/)Scripts\.(rxdata|rvdata2?)$/i.test(x.path));
    if (loose) {
        b = loose.bytes;
    } else {
        const arc = tree.find((x) => /\.(rgssad|rgss2a)$/i.test(x.path));
        if (arc) b = rgssadScriptsV1(arc.bytes); // .rgss3a (v3) not handled yet
    }
    if (!b) return "";
    let out = "";
    for (let i = 0; i + 1 < b.length; i++) {
        // zlib header: 0x78 followed by 0x01 / 0x9c / 0xda
        if (b[i] !== 0x78) continue;
        const h = b[i + 1];
        if (h !== 0x01 && h !== 0x9c && h !== 0xda) continue;
        try {
            const dec = inflate(b.subarray(i));
            if (dec && dec.length) out += text(dec);
        } catch (_) { /* not a real stream start here */ }
    }
    return out;
}

/// Decrypt just the Scripts member out of an RGSSAD **v1** archive (magic
/// `RGSSAD\0\x01`; used by both `.rgssad`/RMXP and `.rgss2a`/VX). The cipher: a
/// key seeded 0xDEADCAFE advancing k = k*7+3 per header field and per name byte;
/// file data XORs a local copy of the key advancing every 4 bytes (the main key
/// is NOT advanced by payload, so non-Scripts members are skipped cheaply).
/// Returns the decrypted Scripts bytes, or null. (Same cipher as the Rust side.)
function rgssadScriptsV1(data) {
    const magic = [0x52, 0x47, 0x53, 0x53, 0x41, 0x44, 0x00];
    if (data.length < 8 || magic.some((m, i) => data[i] !== m) || data[7] !== 1) return null;
    const adv = (k) => (Math.imul(k, 7) + 3) >>> 0;
    const u32 = (p) => (data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24)) >>> 0;
    let key = 0xdeadcafe >>> 0;
    let pos = 8;
    while (pos + 4 <= data.length) {
        const namelen = (u32(pos) ^ key) >>> 0; key = adv(key); pos += 4;
        if (namelen === 0 || namelen > 1000 || pos + namelen > data.length) break;
        let name = "";
        for (let i = 0; i < namelen; i++) { name += String.fromCharCode(data[pos] ^ (key & 0xff)); key = adv(key); pos++; }
        name = name.replace(/\\/g, "/");
        if (pos + 4 > data.length) break;
        const size = (u32(pos) ^ key) >>> 0; key = adv(key); pos += 4;
        if (size > data.length || pos + size > data.length) break;
        if (/Scripts\.(rxdata|rvdata2?)$/i.test(name)) {
            const buf = data.slice(pos, pos + size);
            let dk = key;
            for (let i = 0; i < size; i++) { buf[i] ^= (dk >>> (8 * (i & 3))) & 0xff; if ((i & 3) === 3) dk = adv(dk); }
            return buf;
        }
        pos += size; // skip this member's still-encrypted data
    }
    return null;
}

/// True when the scripts carry unambiguous classic-runtime fingerprints —
/// Ruby-1.8-only idioms or Windows keyboard calls that modern mkxp-z games
/// don't use. Heuristic, kept conservative to avoid mis-routing modern games.
export function isLegacyRgss(sources) {
    if (!sources) return false;
    // Ruby-1.8-only idioms, or loading Windows DLLs the modern runtime can't
    // (Win32API/Kernel32/User32) — classic games do this; modern mkxp-z games
    // don't. Safe to be liberal: config-shipping games never reach here.
    return /\bThread\.critical\b/.test(sources)
        || /GetAsyncKeyState/i.test(sources)
        || /\bWin32API\b/.test(sources)
        || /\b(Kernel32|User32)\b/i.test(sources);
}

/// The package manifest the device's generic installer reads. Engine-agnostic
/// on purpose: it carries only what the device needs to place files and
/// register the port — never anything engine-specific. `shared` lists
/// card-relative folders that are cross-port deps (e.g. an RTP): the installer
/// places them once and skips them if already present.
export function manifest(meta) {
    return JSON.stringify(
        {
            format: "portforge-port",
            version: 1,
            title: meta.title,
            slug: meta.slug,
            script: meta.script,          // basename in Roms/Ports (PORTS)/
            boxart: meta.boxart || null,  // basename in .media/, or null
            shared: meta.shared || [],    // card-relative dirs to dedupe
        },
        null,
        2
    ) + "\n";
}

// --- shared slug/name rules (identical to the on-device forge) ---------------

/// Slug for the port dir: lowercase, ASCII alphanumerics only. Falls back to
/// "game".
export function slugify(title) {
    const s = [...title].filter((c) => /[A-Za-z0-9]/.test(c)).join("").toLowerCase();
    return s || "game";
}

/// Display/file name for the .sh + boxart: keep spaces and a few safe marks,
/// collapse whitespace, everything else → space.
export function safeName(title, slug) {
    const s = [...title]
        .map((c) => (/[\p{L}\p{N}]/u.test(c) || " _-!'.".includes(c) ? c : " "))
        .join("")
        .split(/\s+/)
        .filter(Boolean)
        .join(" ");
    return s.trim() || slug;
}
