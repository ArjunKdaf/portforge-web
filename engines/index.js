// Engine registry — tried in order, first match wins. Specific engines go
// first; the catch-all (modern mkxp-z) goes last. Add a module here to teach
// the site a new engine; nothing else changes.
import rgssLegacy from "./rgss-legacy.js";
import easyrpg from "./easyrpg.js";
import rgss from "./rgss.js";

// rgss is the RGSS catch-all (last); easyrpg is its own family (RPG_RT.ldb, no
// RGSS ini) so it never collides — order among the others is cosmetic.
export const engines = [rgssLegacy, easyrpg, rgss];
