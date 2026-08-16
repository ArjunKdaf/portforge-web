// Engine registry — tried in order, first match wins. Specific engines go
// first; the catch-all (modern mkxp-z) goes last. Add a module here to teach
// the site a new engine; nothing else changes.
import rgssLegacy from "./rgss-legacy.js";
import easyrpg from "./easyrpg.js";
import renpy from "./renpy.js";
import solarus from "./solarus.js";
import thextech from "./thextech.js";
import rgss from "./rgss.js";

// rgss is the RGSS catch-all (last). easyrpg (RPG_RT.ldb), renpy (game/ with
// .rpa/.rpyc — modern only), solarus (.solarus / data/project_db.dat), and
// thextech (gameinfo.ini + graphics/) are their own families with distinct
// fingerprints — they never collide with RGSS.
export const engines = [rgssLegacy, easyrpg, renpy, solarus, thextech, rgss];
