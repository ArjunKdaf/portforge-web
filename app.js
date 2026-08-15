// Port Forge (web) — browser layer: ingest (drag OR browse, folders/zips),
// show the dependency checklist, collect the user-supplied dependencies, and
// assemble the port zip. All pure logic lives in core.js / engines/*.
import { analyze, scriptSources, isLegacyRgss } from "./core.js";
import { engines } from "./engines/index.js";

const fflate = window.fflate;
const $ = (id) => document.getElementById(id);
const state = { tree: null, result: null, provided: {} };
const launchCache = {}; // engine launch template text, by asset path

// ---------------------------------------------------------------- ingest -----

// A dropped/selected FOLDER becomes a flat [{ path, bytes }] tree, keeping each
// file's relative path. Folders only — in-browser unzip froze big games, so
// archives are extracted by the user first (see ingestGame).
async function toTree(files) {
    return Promise.all(
        files.map(async (f) => ({
            path: f.webkitRelativePath || f.name,
            bytes: new Uint8Array(await f.arrayBuffer()),
        }))
    );
}

// Walk a drag-drop that may contain directories (needs the entry API).
function filesFromDataTransfer(dt) {
    const items = [...(dt.items || [])];
    const entries = items.map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    if (!entries.length) return Promise.resolve([...dt.files]);
    const out = [];
    const walk = (entry, prefix) =>
        new Promise((resolve) => {
            if (entry.isFile) {
                entry.file((file) => {
                    // stamp the relative path so toTree/detect see the tree
                    Object.defineProperty(file, "webkitRelativePath", { value: prefix + entry.name });
                    out.push(file);
                    resolve();
                });
            } else {
                const reader = entry.createReader();
                const readAll = () =>
                    reader.readEntries(async (batch) => {
                        if (!batch.length) return resolve();
                        await Promise.all(batch.map((e) => walk(e, prefix + entry.name + "/")));
                        readAll(); // readEntries returns in chunks
                    });
                readAll();
            }
        });
    return Promise.all(entries.map((e) => walk(e, ""))).then(() => out);
}

// ------------------------------------------------------------- dep re-root ---

// The user drops the extracted RTP folder; innoextract wraps assets in app/, so
// re-root at the shallowest dir that directly holds Graphics/ and Audio/.
function rerootToAssets(tree) {
    const dirs = new Map(); // dir -> set of child names (lowercased)
    for (const f of tree) {
        const parts = f.path.split("/");
        for (let i = 0; i < parts.length; i++) {
            const dir = parts.slice(0, i).join("/");
            if (!dirs.has(dir)) dirs.set(dir, new Set());
            dirs.get(dir).add(parts[i].toLowerCase());
        }
    }
    let bestDir = null;
    for (const [dir, kids] of dirs) {
        if (kids.has("graphics") && kids.has("audio")) {
            if (bestDir === null || dir.length < bestDir.length) bestDir = dir;
        }
    }
    if (bestDir === null) return tree; // let it through; user may know better
    const prefix = bestDir ? bestDir + "/" : "";
    return tree
        .filter((f) => f.path.startsWith(prefix) && f.path.length > prefix.length)
        .map((f) => ({ path: f.path.slice(prefix.length), bytes: f.bytes }));
}

// ----------------------------------------------------------------- wiring ----

// Drag-and-drop on a zone (folders or files or a .zip).
function enableDrag(zone, onFiles) {
    ["dragover", "dragenter"].forEach((ev) =>
        zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("over"); })
    );
    ["dragleave", "drop"].forEach((ev) =>
        zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove("over"); })
    );
    zone.addEventListener("drop", async (e) => onFiles(await filesFromDataTransfer(e.dataTransfer)));
}

// A browse button feeding the same handler.
function enableBrowse(button, input, onFiles) {
    button.addEventListener("click", () => input.click());
    input.addEventListener("change", () => input.files.length && onFiles([...input.files]));
}

// Convenience for the dep zones: click-anywhere folder browse + drag.
function wireDrop(zone, input, onFiles) {
    enableDrag(zone, onFiles);
    enableBrowse(zone, input, onFiles);
}

function log(msg) {
    const el = $("log");
    el.textContent += msg + "\n";
    el.scrollTop = el.scrollHeight;
}

// The busy widget has two modes. Spinner mode (indeterminate) for reads/unzip;
// progress mode (a bar + a Cancel button) for the zip build, which we can
// measure and interrupt.
function setBusy(msg) {
    $("busyMsg").textContent = msg;
    $("busySpin").hidden = false;
    $("busyBar").hidden = true;
    $("busyCancel").hidden = true;
    $("busy").hidden = false;
}
function setProgress(label, frac) {
    const pct = Math.round(Math.min(Math.max(frac, 0), 1) * 100);
    $("busyMsg").textContent = `${label} ${pct}%`;
    $("busySpin").hidden = true;
    $("busyBar").hidden = false;
    $("busyFill").style.width = `${pct}%`;
    $("busyCancel").hidden = false;
    $("busy").hidden = false;
}
function clearBusy() {
    $("busy").hidden = true;
}

// ------------------------------------------------------------- game ingest ---

async function ingestGame(files) {
    $("checklist").innerHTML = "";
    $("assemble").disabled = true;
    state.provided = {};
    // Folder-only: a lone archive/installer can't be read here — extract first.
    if (files.length === 1 && /\.(zip|7z|rar|exe)$/i.test(files[0].name)) {
        const ext = files[0].name.split(".").pop().toUpperCase();
        $("checklist").innerHTML =
            `<p class="warn">That's a <b>${esc(ext)}</b> file. Extract it on your PC first, then drop the resulting <b>folder</b> here.</p>`;
        return;
    }
    setBusy("Reading folder…");
    log(`Reading ${files.length} file(s)…`);
    try {
        state.tree = await toTree(files);
        // classic vs modern RGSS: fingerprint the scripts once, route with it
        const ctx = { legacy: isLegacyRgss(scriptSources(state.tree, fflate.decompressSync)) };
        state.result = analyze(state.tree, engines, ctx);
        renderResult();
    } catch (e) {
        log("ERROR reading input: " + e.message);
        $("checklist").innerHTML = `<p class="warn">Couldn't read that: ${esc(e.message)}</p>`;
    } finally {
        clearBusy();
    }
}

function renderResult() {
    const { engine, detection, deps, issue } = state.result;
    const box = $("checklist");
    if (!engine) {
        box.innerHTML =
            issue === "inno"
                ? `<p class="warn">This looks like an <b>Inno Setup installer</b>. Extract it on your PC first (innoextract or 7-Zip), then drop the extracted game folder here.</p>`
                : `<p class="warn">No recognizable game found. If it's an archive or installer, extract it first and drop the folder.</p>`;
        return;
    }
    const d = detection;
    let html = `<div class="card">
        <h3>${esc(d.title)}</h3>
        <p>${engine.name} — <b>${esc(d.engineName)}</b> (RGSS${d.rgssVersion || "?"}) · runtime <b>${esc(engine.runtime)}</b>
        ${d.ownConfig ? '· <span class="ok">ships its own config → self-contained</span>' : ""}</p>
        <p class="dim">port slug <code>${esc(d.slug)}</code> · launcher <code>${esc(d.safe)}.sh</code></p>
    </div>`;

    for (const w of d.warnings || []) {
        html += `<div class="card block">
            <p class="warn"><b>⚠ ${esc(w.title)}</b></p>
            <p class="dim">${esc(w.detail)}</p>
            ${w.items && w.items.length ? `<p class="dim"><code>${w.items.map(esc).join("</code> <code>")}</code></p>` : ""}
        </div>`;
    }

    if (!deps.length) {
        html += `<p class="ok">No external dependencies. Ready to assemble.</p>`;
    } else {
        html += `<h4>Dependencies to provide</h4>`;
        for (const dep of deps) {
            const steps = (dep.extractSteps || []).map((s) => `<li>${esc(s)}</li>`).join("");
            html += `<div class="card dep" data-dep="${esc(dep.id)}">
                <p><b>${esc(dep.label)}</b> ${dep.verified ? "" : '<span class="warn">(link unverified)</span>'}</p>
                <p><a href="${esc(dep.url)}" target="_blank" rel="noopener">Official download ↗</a></p>
                ${steps ? `<ol class="steps">${steps}</ol>` : ""}
                ${dep.extractCmd ? `<pre class="cmd">${esc(dep.extractCmd)}</pre>` : ""}
                <div class="drop small" id="dep-${esc(dep.id)}"><span>Drop the extracted folder — or click to browse</span>
                    <input type="file" webkitdirectory hidden></div>
                <p class="status" id="depst-${esc(dep.id)}">waiting…</p>
            </div>`;
        }
    }
    box.innerHTML = html;

    for (const dep of deps) {
        const zone = $(`dep-${dep.id}`);
        wireDrop(zone, zone.querySelector("input"), async (files) => {
            setBusy(`Reading ${dep.label}…`);
            log(`Reading ${dep.label}…`);
            try {
                const t = rerootToAssets(await toTree(files));
                state.provided[dep.id] = t;
                $(`depst-${dep.id}`).innerHTML = `<span class="ok">✓ ${t.length} files</span>`;
                refreshAssemble();
            } catch (e) {
                log("ERROR reading dependency: " + e.message);
            } finally {
                clearBusy();
            }
        });
    }
    refreshAssemble();
}

function refreshAssemble() {
    const { deps } = state.result;
    const ready = deps.every((d) => state.provided[d.id]);
    $("assemble").disabled = !ready;
}

// ---------------------------------------------------------------- assemble ---

let cancelBuild = false;

async function launchTemplateFor(engine) {
    const path = engine.launchAsset;
    if (!launchCache[path]) launchCache[path] = await (await fetch(path)).text();
    return launchCache[path];
}

async function assemble() {
    const { engine, detection } = state.result;
    log("Assembling port…");
    const launchTemplate = await launchTemplateFor(engine);
    const { entries } = engine.plan(detection, state.tree, state.provided, { launchTemplate });
    const files = [...entries]; // [path, Uint8Array]
    const totalBytes = files.reduce((n, [, b]) => n + b.length, 0) || 1;

    cancelBuild = false;
    $("assemble").disabled = true;
    setProgress("Building port .zip…", 0);

    // Stream the zip file-by-file (store, level 0 — assets are already
    // compressed) so we can measure progress and bail out. Output chunks land
    // in `chunks` as each file is pushed.
    const chunks = [];
    let zipErr = null, finalized = false;
    const zip = new fflate.Zip((err, chunk, final) => {
        if (err) zipErr = err;
        else {
            if (chunk && chunk.length) chunks.push(chunk);
            if (final) finalized = true;
        }
    });

    const breathe = () => new Promise((r) => setTimeout(r)); // let UI paint + cancel register
    let bytesDone = 0, lastYield = performance.now();
    try {
        for (const [path, bytes] of files) {
            const f = new fflate.ZipPassThrough(path);
            zip.add(f);
            f.push(bytes, true);
            bytesDone += bytes.length;
            // yield on a ~16ms budget: smooth bar without a setTimeout per file
            if (performance.now() - lastYield > 16) {
                setProgress("Building port .zip…", bytesDone / totalBytes);
                await breathe();
                lastYield = performance.now();
                if (cancelBuild) { log("Build cancelled."); return; }
            }
        }
        zip.end();
        while (!finalized && !zipErr) {
            await breathe();
            if (cancelBuild) { log("Build cancelled."); return; }
        }
        if (zipErr) { log("ERROR: " + zipErr.message); return; }
        setProgress("Building port .zip…", 1);
        const blob = new Blob(chunks, { type: "application/zip" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `port-${detection.slug}.zip`;
        a.click();
        URL.revokeObjectURL(a.href);
        log(`Done — ${files.length} files, ${(blob.size / 1048576).toFixed(1)} MB.`);
    } catch (e) {
        log("ERROR building zip: " + e.message);
    } finally {
        clearBusy();
        $("assemble").disabled = false;
    }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ------------------------------------------------------------------- boot ----

// The Supported-engines section is driven by the registry, so it can never
// drift from what the site actually handles.
function renderEngines() {
    $("engines").innerHTML =
        `<ul class="engine-list">` +
        engines
            .map((e) => `<li>${esc(e.name)}${e.runtime ? ` — ${esc(e.runtime)}` : ""}</li>`)
            .join("") +
        `</ul>`;
}

(async function () {
    renderEngines();
    // Launch templates are fetched per-engine on demand (see launchTemplateFor).
    enableDrag($("game"), ingestGame);
    enableBrowse($("browseFolder"), $("gameFolderInput"), ingestGame);
    $("assemble").addEventListener("click", assemble);
    $("busyCancel").addEventListener("click", () => { cancelBuild = true; });
    log("Ready. Drop a game folder or .zip to begin.");
})();
