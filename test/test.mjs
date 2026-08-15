// Node test of the pure pipeline (core.js + engines/rgss.js). No DOM/fflate.
// Run: node test/test.mjs
import assert from "node:assert";
import zlib from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyze, scriptSources, isLegacyRgss } from "../core.js";
import { engines } from "../engines/index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const launchTemplate = readFileSync(here + "../assets/launch.sh.tmpl", "utf8");
const b = (s) => new Uint8Array(Buffer.from(s, "latin1"));

// a minimal-but-valid 640x480 PNG header so boxart selection triggers
function png(w, h) {
    const a = new Uint8Array(24);
    a.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const be = (o, v) => { a[o] = v >>> 24; a[o + 1] = v >>> 16; a[o + 2] = v >>> 8; a[o + 3] = v; };
    be(16, w); be(20, h);
    return a;
}

let pass = 0;
const ok = (name) => { console.log("  ✓ " + name); pass++; };

// --- 1: VX Ace game needing the RTP (modeled on a packed VX Ace freeware) ----
{
    const ini = "[Game]\nRTP=RPGVXAce\nLibrary=System\\RGSS300.dll\nScripts=Data\\Scripts.rvdata2\nTitle=Test Castle\n";
    const tree = [
        { path: "TestCastle/Game.ini", bytes: b(ini) },
        { path: "TestCastle/Game.rgss3a", bytes: b("packed-archive") },
        { path: "TestCastle/Graphics/Titles/title.png", bytes: png(640, 480) },
    ];
    const r = analyze(tree, engines);
    assert.equal(r.engine.id, "rgss");
    assert.equal(r.detection.engineName, "VX Ace");
    assert.equal(r.detection.rgssVersion, 3);
    assert.equal(r.detection.ownConfig, false);
    assert.equal(r.detection.rtpKey, "RPGVXAce");
    assert.equal(r.detection.slug, "testcastle");
    assert.equal(r.detection.safe, "Test Castle");
    assert.equal(r.deps.length, 1);
    assert.equal(r.deps[0].id, "RPGVXAce");
    ok("detect VX Ace + RTP dependency");

    const provided = { RPGVXAce: [{ path: "Graphics/Characters/Vehicle.png", bytes: b("veh") }] };
    const { entries } = r.engine.plan(r.detection, tree, provided, { launchTemplate });
    const paths = [...entries.keys()];
    assert.ok(paths.includes("Data/ports/testcastle/Game.ini"));
    assert.ok(paths.includes("Data/ports/testcastle/Game.rgss3a"));
    assert.ok(paths.includes("Data/ports/testcastle/mkxp.json"));
    assert.ok(paths.includes("Data/ports/testcastle/testcastle.gptk"));
    assert.ok(paths.includes("Roms/Ports (PORTS)/Test Castle.sh"));
    assert.ok(paths.includes("Roms/Ports (PORTS)/.media/Test Castle.png"));
    assert.ok(paths.includes("Data/ports/.rtp/RPGVXAce/Graphics/Characters/Vehicle.png"));
    const mkxp = JSON.parse(new TextDecoder().decode(entries.get("Data/ports/testcastle/mkxp.json")));
    assert.deepEqual(mkxp.RTP, ["../.rtp/RPGVXAce"]);
    assert.equal(mkxp.rgssVersion, 0);
    const sh = new TextDecoder().decode(entries.get("Roms/Ports (PORTS)/Test Castle.sh"));
    assert.ok(sh.includes('GAMEDIR="/$directory/ports/testcastle"'));
    assert.ok(!sh.includes("@SLUG@"));
    ok("plan bundles RTP, wires ../.rtp ref, fills launch script");

    const man = JSON.parse(new TextDecoder().decode(entries.get("portforge.json")));
    assert.equal(man.format, "portforge-port");
    assert.equal(man.slug, "testcastle");
    assert.equal(man.script, "Test Castle.sh");
    assert.equal(man.boxart, "Test Castle.png");
    assert.deepEqual(man.shared, ["Data/ports/.rtp/RPGVXAce"]);
    ok("manifest describes the port for the device installer");
}

// --- 2: VX game with RTP disabled (self-contained, no dep) -------------------
{
    const ini = "[Game]\nRTP=\nLibrary=RGSS202E.dll\nScripts=Data\\Scripts.rvdata\nTitle=Test House\n";
    const tree = [
        { path: "TestHouse109/Game.ini", bytes: b(ini) },
        { path: "TestHouse109/Game.rgss2a", bytes: b("packed") },
    ];
    const r = analyze(tree, engines);
    assert.equal(r.detection.engineName, "VX");
    assert.equal(r.detection.rtpKey, null);
    assert.equal(r.deps.length, 0);
    const { entries } = r.engine.plan(r.detection, tree, {}, { launchTemplate });
    const mkxp = JSON.parse(new TextDecoder().decode(entries.get("Data/ports/testhouse/mkxp.json")));
    assert.ok(!("RTP" in mkxp));
    ok("detect VX, RTP disabled → no dependency, no RTP in config");
}

// --- 3: modern game shipping its own mkxp.json (self-sufficient) -------------
{
    const ini = "[Game]\nRTP=RPGVXAce\nLibrary=RGSS300.dll\nTitle=Modern Game\n";
    const tree = [
        { path: "Modern/Game.ini", bytes: b(ini) },
        { path: "Modern/mkxp.json", bytes: b('{"rgssVersion":3,"defScreenW":640}') },
        { path: "Modern/Data/Scripts.rvdata2", bytes: b("x") },
    ];
    const r = analyze(tree, engines);
    assert.equal(r.detection.ownConfig, true);
    assert.equal(r.deps.length, 0, "own config → no RTP dependency");
    const { entries } = r.engine.plan(r.detection, tree, {}, { launchTemplate });
    const kept = new TextDecoder().decode(entries.get("Data/ports/moderngame/mkxp.json"));
    assert.ok(kept.includes("defScreenW"), "keeps the game's own mkxp.json verbatim");
    ok("self-contained game keeps its own config, no deps");
}

// --- 4: an Inno installer (must be extracted first) --------------------------
{
    const exe = new Uint8Array(400);
    exe.set(b("Inno Setup Setup Data (5.4.2)"), 100);
    const r = analyze([{ path: "Setup.exe", bytes: exe }], engines);
    assert.equal(r.engine, null);
    assert.equal(r.issue, "inno");
    ok("recognizes an Inno installer → extract-first");
}

// --- 5 & 6: legacy vs modern RGSS routing via script fingerprint -------------
// Build a minimal Ruby-1.8 Marshal Scripts.rxdata: [[id, "Main", zlib(code)]].
function encLong(n) {
    if (n === 0) return [0];
    if (n <= 122) return [n + 5];
    if (n <= 255) return [1, n & 0xff];
    return [2, n & 0xff, (n >> 8) & 0xff];
}
function scriptsRxdata(code) {
    const deflated = zlib.deflateSync(Buffer.from(code, "latin1"));
    const name = Buffer.from("Main", "latin1");
    return new Uint8Array([
        0x04, 0x08, 0x5b, ...encLong(1), 0x5b, ...encLong(3),
        0x69, 0x00,
        0x22, ...encLong(name.length), ...name,
        0x22, ...encLong(deflated.length), ...deflated,
    ]);
}

{
    const tree = [
        { path: "OldQuest/Game.ini", bytes: b("[Game]\nRTP=\nLibrary=RGSS104E.dll\nTitle=Old Quest\n") },
        { path: "OldQuest/Data/Scripts.rxdata", bytes: scriptsRxdata("class Foo\n Thread.critical = true\n k = GetAsyncKeyState(0x0D)\nend\n") },
    ];
    const sources = scriptSources(tree, zlib.inflateSync);
    assert.ok(sources.includes("Thread.critical"), "inflated the marshalled script");
    assert.equal(isLegacyRgss(sources), true);

    const r = analyze(tree, engines, { legacy: true });
    assert.equal(r.engine.id, "rgss-legacy");
    assert.equal(r.engine.runtime, "falcon-mkxp");
    const falconTmpl = readFileSync(here + "../assets/launch-falcon.sh.tmpl", "utf8");
    const { entries } = r.engine.plan(r.detection, tree, {}, { launchTemplate: falconTmpl });
    const paths = [...entries.keys()];
    assert.ok(paths.includes("Data/ports/oldquest/mkxp.conf"), "legacy writes mkxp.conf");
    assert.ok(!paths.some((p) => p.endsWith("mkxp.json")), "legacy does NOT write mkxp.json");
    const conf = new TextDecoder().decode(entries.get("Data/ports/oldquest/mkxp.conf"));
    assert.ok(conf.includes("preloadScript=Falcon_preload/win32_wrap.rb"));
    ok("legacy scripts → falcon-mkxp, mkxp.conf + Win32API preload");
}

{
    const tree = [
        { path: "NewQuest/Game.ini", bytes: b("[Game]\nRTP=\nLibrary=RGSS104E.dll\nTitle=New Quest\n") },
        { path: "NewQuest/Data/Scripts.rxdata", bytes: scriptsRxdata("class Foo\n puts 'hello world'\nend\n") },
    ];
    const ctx = { legacy: isLegacyRgss(scriptSources(tree, zlib.inflateSync)) };
    assert.equal(ctx.legacy, false);
    const r = analyze(tree, engines, ctx);
    assert.equal(r.engine.id, "rgss");
    assert.equal(r.engine.runtime, "mkxp-z");
    ok("modern scripts → mkxp-z (catch-all)");
}

// --- 7: scripts packed in an RGSSAD v1 archive (the Witch's House case) -------
// Encrypt a Scripts blob into a v1 archive (XOR cipher is symmetric).
function makeRgssadV1(scriptsBlob) {
    const name = "Data/Scripts.rvdata";
    const adv = (k) => (Math.imul(k, 7) + 3) >>> 0;
    let key = 0xdeadcafe >>> 0;
    const out = [0x52, 0x47, 0x53, 0x53, 0x41, 0x44, 0x00, 0x01];
    const wU32 = (v, k) => { const e = (v ^ k) >>> 0; return [e & 0xff, (e >>> 8) & 0xff, (e >>> 16) & 0xff, (e >>> 24) & 0xff]; };
    out.push(...wU32(name.length, key)); key = adv(key);
    for (let i = 0; i < name.length; i++) { out.push((name.charCodeAt(i) ^ (key & 0xff)) & 0xff); key = adv(key); }
    out.push(...wU32(scriptsBlob.length, key)); key = adv(key);
    let dk = key;
    for (let i = 0; i < scriptsBlob.length; i++) { out.push((scriptsBlob[i] ^ ((dk >>> (8 * (i & 3))) & 0xff)) & 0xff); if ((i & 3) === 3) dk = adv(dk); }
    return new Uint8Array(out);
}

{
    const scriptsBlob = scriptsRxdata("class Scene_File\n api = Win32API.new('Kernel32','x','x','x')\nend\n");
    const tree = [
        { path: "Packed/Game.ini", bytes: b("[Game]\nRTP=\nLibrary=RGSS202E.dll\nTitle=Packed VX\n") },
        { path: "Packed/Game.rgss2a", bytes: makeRgssadV1(scriptsBlob) },
    ];
    const src = scriptSources(tree, zlib.inflateSync);
    assert.ok(/Win32API/.test(src), "decrypted Scripts out of the rgss2a archive");
    assert.equal(isLegacyRgss(src), true);
    const r = analyze(tree, engines, { legacy: isLegacyRgss(src) });
    assert.equal(r.engine.id, "rgss-legacy");
    ok("packed .rgss2a scripts decrypted → legacy → falcon");
}

// --- 8: native gem (.so) → "won't run" warning ------------------------------
{
    const tree = [
        { path: "Rich/Game.ini", bytes: b("[Game]\nRTP=\nLibrary=RGSS104E.dll\nTitle=Rich Game\n") },
        { path: "Rich/mkxp.json", bytes: b('{"rgssVersion":1}') },
        { path: "Rich/gems/discord.so", bytes: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]) },
        // bundled Ruby/SDL runtime libs must NOT trip the warning
        { path: "Rich/lib64/libruby.so.3.1", bytes: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]) },
        { path: "Rich/lib64/libcrypt.so.1", bytes: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]) },
    ];
    const r = analyze(tree, engines, {});
    const warn = (r.detection.warnings || []).find((w) => /native/i.test(w.title));
    assert.ok(warn, "flags the native gem");
    assert.deepEqual(warn.items, ["gems/discord.so"], "only the gem, not lib64 runtime libs");
    ok("native gem flagged; bundled runtime libs are NOT (false-positive fixed)");
}

// --- 9: split-asset game (MotW format) — sibling Audio/ merged into the port -
{
    const tree = [
        { path: "Parent/game/Game.ini", bytes: b("[Game]\nRTP=\nLibrary=RGSS102E.dll\nScripts=Data\\Scripts.rxdata\nTitle=Split Quest\n") },
        { path: "Parent/game/Game.rgssad", bytes: b("packed") },
        { path: "Parent/Audio/BGM/song.ogg", bytes: b("music") }, // sibling audio, outside the game folder
        { path: "Parent/Audio/SE/click.wav", bytes: b("sfx") },
    ];
    const r = analyze(tree, engines, {});
    const { entries } = r.engine.plan(r.detection, tree, {}, { launchTemplate });
    const paths = [...entries.keys()];
    const slug = r.detection.slug;
    assert.ok(paths.includes(`Data/ports/${slug}/Audio/BGM/song.ogg`), "sibling Audio merged into port");
    assert.ok(paths.includes(`Data/ports/${slug}/Audio/SE/click.wav`));
    ok("split-asset (MotW format): sibling Audio/ merged into the port");
}

// --- 10: EasyRPG (RPG Maker 2000/2003) detected & routed by RPG_RT.ldb --------
{
    const tree = [
        { path: "MyGame/RPG_RT.ldb", bytes: b("database") },
        { path: "MyGame/RPG_RT.lmt", bytes: b("maptree") },
        { path: "MyGame/RPG_RT.ini", bytes: b("[RPG_RT]\nGameTitle=Space Trip\nFullPackageFlag=1\n") },
        { path: "MyGame/RPG_RT.exe", bytes: b("MZwindows") },
        { path: "MyGame/CharSet/hero.png", bytes: png(24, 32) },
        { path: "MyGame/Title/title.png", bytes: png(320, 240) },
    ];
    const r = analyze(tree, engines, {});
    assert.equal(r.engine.id, "easyrpg", "RPG_RT.ldb → EasyRPG engine");
    assert.equal(r.detection.title, "Space Trip", "title from RPG_RT.ini GameTitle");
    assert.equal(r.detection.slug, "spacetrip");
    assert.equal(r.detection.safe, "Space Trip");
    assert.equal(r.deps.length, 0, "runtime bundles the free RTP → no user deps");
    // must NOT be misrouted to the RGSS engines (no RGSS ini/scripts present)
    assert.notEqual(r.engine.id, "rgss");
    assert.notEqual(r.engine.id, "rgss-legacy");
    ok("EasyRPG: RPG_RT.ldb routes to easyrpg, title from RPG_RT.ini, no deps");
}

// --- 11: EasyRPG plan — game data kept, Windows player stripped, port layout --
{
    const tree = [
        { path: "MyGame/RPG_RT.ldb", bytes: b("database") },
        { path: "MyGame/RPG_RT.ini", bytes: b("[RPG_RT]\nGameTitle=Space Trip\n") },
        { path: "MyGame/RPG_RT.exe", bytes: b("MZwindows") },
        { path: "MyGame/harmony.dll", bytes: b("dll") },
        { path: "MyGame/CharSet/hero.png", bytes: png(24, 32) },
        { path: "MyGame/Title/title.png", bytes: png(320, 240) },
    ];
    const r = analyze(tree, engines, {});
    const { entries } = r.engine.plan(r.detection, tree, {}, { launchTemplate });
    const paths = [...entries.keys()];
    const P = "Data/ports/spacetrip";
    assert.ok(paths.includes(`${P}/RPG_RT.ldb`), "database kept");
    assert.ok(paths.includes(`${P}/RPG_RT.ini`), "ini kept");
    assert.ok(paths.includes(`${P}/CharSet/hero.png`), "assets kept");
    assert.ok(!paths.includes(`${P}/RPG_RT.exe`), "Windows player stripped");
    assert.ok(!paths.includes(`${P}/harmony.dll`), "Windows dll stripped");
    assert.ok(paths.includes(`${P}/spacetrip.gptk`), "gptk emitted");
    assert.ok(paths.includes("Roms/Ports (PORTS)/Space Trip.sh"), "launch script emitted");
    assert.ok(paths.includes("Roms/Ports (PORTS)/.media/Space Trip.png"), "boxart from Title/");
    const mf = JSON.parse(Buffer.from(entries.get("portforge.json")).toString());
    assert.equal(mf.format, "portforge-port");
    assert.equal(mf.slug, "spacetrip");
    assert.equal(mf.script, "Space Trip.sh");
    assert.equal(mf.boxart, "Space Trip.png");
    assert.deepEqual(mf.shared, [], "no shared deps (RTP is in the runtime)");
    ok("EasyRPG: plan keeps game data, strips Windows player, emits engine-agnostic port");
}

// --- 12: Ren'Py detected & routed by a game/ dir with .rpa/.rpyc ------------
{
    const tree = [
        { path: "MyVN/game/script.rpyc", bytes: b("compiled") },
        { path: "MyVN/game/options.rpy", bytes: b('define config.name = _("Test Novel")\n') },
        { path: "MyVN/game/scripts.rpa", bytes: b("archive") },
        { path: "MyVN/game/gui/main_menu.png", bytes: png(800, 600) },
        { path: "MyVN/renpy/__init__.py", bytes: b("engine") },   // runtime provides this
        { path: "MyVN/lib/py3-linux/renpy", bytes: b("bin") },    // stripped
        { path: "MyVN/MyVN.exe", bytes: b("MZ") },                // stripped
    ];
    const r = analyze(tree, engines, {});
    assert.equal(r.engine.id, "renpy", "game/ with .rpa/.rpyc → Ren'Py engine");
    assert.equal(r.detection.title, "Test Novel", "title from options.rpy config.name");
    assert.equal(r.detection.slug, "testnovel");
    assert.equal(r.deps.length, 0, "runtime bundles the engine → no user deps");
    assert.notEqual(r.engine.id, "easyrpg");
    assert.notEqual(r.engine.id, "rgss");
    ok("Ren'Py: game/ routes to renpy, title from options.rpy, no deps");
}

// --- 13: Ren'Py plan — ships only game/, strips the bundled engine ----------
{
    const tree = [
        { path: "MyVN/game/script.rpyc", bytes: b("compiled") },
        { path: "MyVN/game/options.rpy", bytes: b('define config.name = _("Test Novel")\n') },
        { path: "MyVN/game/gui/main_menu.png", bytes: png(800, 600) },
        { path: "MyVN/renpy/__init__.py", bytes: b("engine") },
        { path: "MyVN/lib/py3-linux/renpy", bytes: b("bin") },
        { path: "MyVN/MyVN.exe", bytes: b("MZ") },
    ];
    const r = analyze(tree, engines, {});
    const { entries } = r.engine.plan(r.detection, tree, {}, { launchTemplate });
    const paths = [...entries.keys()];
    const P = "Data/ports/testnovel";
    assert.ok(paths.includes(`${P}/game/script.rpyc`), "game scripts kept");
    assert.ok(paths.includes(`${P}/game/gui/main_menu.png`), "game assets kept");
    assert.ok(!paths.some((p) => p.includes("/renpy/__init__.py")), "bundled engine stripped");
    assert.ok(!paths.some((p) => p.includes("/lib/")), "bundled lib stripped");
    assert.ok(!paths.some((p) => p.endsWith(".exe")), "Windows launcher stripped");
    assert.ok(paths.includes("Roms/Ports (PORTS)/Test Novel.sh"), "launch script emitted");
    assert.ok(paths.includes("Roms/Ports (PORTS)/.media/Test Novel.png"), "boxart from game/gui/");
    const mf = JSON.parse(Buffer.from(entries.get("portforge.json")).toString());
    assert.equal(mf.slug, "testnovel");
    assert.equal(mf.script, "Test Novel.sh");
    assert.deepEqual(mf.shared, []);
    ok("Ren'Py: plan ships only game/, strips the bundled engine, engine-agnostic port");
}

// --- 14: classic Ren'Py 6.x → modern engine WITH an "unsupported" warning ---
{
    const tree = [
        { path: "OldVN/game/script.rpyc", bytes: b("compiled") },
        { path: "OldVN/game/script_version.rpy", bytes: b("config.script_version = (6, 10, 2)\n") },
        { path: "OldVN/game/options.rpy", bytes: b('define config.name = _("Old Novel")\n') },
    ];
    const r = analyze(tree, engines, {});
    assert.equal(r.engine.id, "renpy", "only modern renpy engine exists now");
    assert.equal(r.detection.title, "Old Novel");
    const w = (r.detection.warnings || []).find((x) => /classic ren'py/i.test(x.title));
    assert.ok(w, "classic 6.x is flagged unsupported");
    ok("Ren'Py classic: 6.x detected → warned as unsupported (modern-only)");
}

// --- 15: modern Ren'Py (game/gui/, no old script_version) stays on renpy ----
{
    const tree = [
        { path: "NewVN/game/script.rpyc", bytes: b("compiled") },
        { path: "NewVN/game/gui/main_menu.png", bytes: png(1280, 720) },
    ];
    const r = analyze(tree, engines, {});
    assert.equal(r.engine.id, "renpy", "game/gui/ + no 6.x version → modern renpy");
    assert.equal(r.engine.runtime, "renpy");
    ok("Ren'Py modern: game/gui/ routes to renpy (8.3.4)");
}

// --- 16: modern game that PACKS gui/ (no loose game/gui/) — lib/py3- is the tell
{
    const tree = [
        { path: "SF-win/game/scripts.rpa", bytes: b("packed") },
        { path: "SF-win/game/images.rpa", bytes: b("packed") },
        { path: "SF-win/lib/py3-windows-x86_64/renpy.exe", bytes: b("bin") },
        { path: "SF-win/SF.exe", bytes: b("MZ") },
    ];
    const r = analyze(tree, engines, {});
    assert.equal(r.engine.id, "renpy", "packed-gui modern game routes to modern renpy via lib/py3-");
    assert.equal(r.engine.runtime, "renpy");
    ok("Ren'Py modern: packed gui/ but lib/py3- → modern (not mis-routed to legacy)");
}

// --- 17: unsupported engines are NAMED, not a vague "unknown" ---------------
{
    const godot = [{ path: "MyGame/project.godot", bytes: b("[application]") },
                   { path: "MyGame/game.pck", bytes: b("GDPC") }];
    let r = analyze(godot, engines, {});
    assert.equal(r.engine, null);
    assert.equal(r.issue, "unsupported");
    assert.equal(r.unsupported, "Godot");

    const gm = [{ path: "MyGame/data.win", bytes: b("FORM") }, { path: "MyGame/MyGame.exe", bytes: b("MZ") }];
    r = analyze(gm, engines, {});
    assert.equal(r.unsupported, "GameMaker");

    const mv = [{ path: "MyGame/www/js/rpg_core.js", bytes: b("//") }, { path: "MyGame/www/data/Map001.json", bytes: b("{}") }];
    r = analyze(mv, engines, {});
    assert.equal(r.unsupported, "RPG Maker MV/MZ");

    // a truly unknown drop is still "unknown", not a false-positive engine
    r = analyze([{ path: "MyGame/readme.txt", bytes: b("hi") }], engines, {});
    assert.equal(r.issue, "unknown");
    ok("unsupported engines named (Godot/GameMaker/RM MV-MZ); unknown stays unknown");
}

// --- 18: Solarus .solarus package routes to solarus -------------------------
{
    const tree = [{ path: "Mystery of Solarus DX/zsdx-v1.12.3.solarus", bytes: b("PKquestdata") }];
    const r = analyze(tree, engines, {});
    assert.equal(r.engine.id, "solarus", ".solarus → solarus engine");
    assert.equal(r.detection.title, "Mystery of Solarus DX");
    assert.equal(r.detection.questKind, "package");
    const { entries } = r.engine.plan(r.detection, tree, {}, { launchTemplate });
    const paths = [...entries.keys()];
    assert.ok(paths.includes("Data/ports/mysteryofsolarusdx/mysteryofsolarusdx.solarus"), "ships .solarus as <slug>.solarus");
    assert.ok(paths.includes("Roms/Ports (PORTS)/Mystery of Solarus DX.sh"));
    ok("Solarus: .solarus package routes to solarus, shipped as <slug>.solarus");
}

// --- 19: Solarus extracted quest dir (data/project_db.dat) ------------------
{
    const tree = [
        { path: "MyQuest/data/project_db.dat", bytes: b("db") },
        { path: "MyQuest/data/maps/1.dat", bytes: b("map") },
    ];
    const r = analyze(tree, engines, {});
    assert.equal(r.engine.id, "solarus", "extracted quest → solarus");
    assert.equal(r.detection.questKind, "dir");
    const { entries } = r.engine.plan(r.detection, tree, {}, { launchTemplate });
    assert.ok([...entries.keys()].includes("Data/ports/myquest/data/project_db.dat"), "ships the data/ quest tree");
    ok("Solarus: extracted quest dir routes to solarus, ships data/");
}

console.log(`\n${pass} checks passed.`);
