// Engine registry — tried in order, first match wins. Specific engines go
// first; the catch-all (modern mkxp-z) goes last. Add a module here to teach
// the site a new engine; nothing else changes.
import rgssLegacy from "./rgss-legacy.js";
import rgss from "./rgss.js";

export const engines = [rgssLegacy, rgss];
