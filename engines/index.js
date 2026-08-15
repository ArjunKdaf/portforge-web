// Engine registry — tried in order, first match wins. Specific engines go
// first; the catch-all (modern mkxp-z) goes last. Add a module here to teach
// the site a new engine; nothing else changes.
import rgssLegacy from "./rgss-legacy.js";
import easyrpg from "./easyrpg.js";
import renpy from "./renpy.js";
import rgss from "./rgss.js";

// rgss is the RGSS catch-all (last). easyrpg (RPG_RT.ldb) and renpy (game/ with
// .rpa/.rpyc — MODERN only; classic 6.x is detected and warned, not routed to a
// separate engine) are their own families and never collide with RGSS.
export const engines = [rgssLegacy, easyrpg, renpy, rgss];
