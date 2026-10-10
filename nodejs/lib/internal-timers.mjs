// Keeps Node's own internals on the real timers when code replaces the global
// timer functions (as a test's fake clock does).
//
// Node implements parts of the platform in JavaScript that calls the global
// `setTimeout()` and friends: `fetch()` and `WebSocket` (undici) arm timers for
// their deadlines and expect Node `Timeout` objects back. Deno implements the
// same APIs natively, so a replaced global never reaches them. To match, each
// global timer function here is an accessor: assigning it installs a
// replacement as usual, and a call whose immediate caller is a Node builtin
// (a `node:` frame) still goes to the real function. Clearing a Node
// `Timeout` object (which only the real functions return) goes to the real
// function too. A call the replacement itself makes to the function it
// replaced reaches the real one.

import { getCallSites } from "node:util";

const THIS_FILE_URL = import.meta.url;

const NAMES = ["setTimeout", "setInterval", "clearTimeout", "clearInterval"];

/**
 * Whether the immediate caller (outside this file) is a Node builtin. This
 * reads V8's call sites through `util.getCallSites()` rather than an error's
 * `stack`, which SES, once it locks down, empties and filters `node:` frames
 * from.
 */
function callerIsNodeBuiltin() {
  for (const site of getCallSites(4).slice(1)) {
    if (site.scriptName === THIS_FILE_URL) continue;
    return site.scriptName.startsWith("node:");
  }
  return false;
}

for (const name of NAMES) {
  const real = globalThis[name];
  const isClear = name.startsWith("clear");
  let installed = real;
  // Nonzero while the replacement runs: a replacement keeps the function it
  // replaced (this one) as its "real" timer, and its calls to it go to `real`.
  let depth = 0;
  const dispatch = {
    [name](...args) {
      if (installed === real || depth > 0) return real.apply(this, args);
      const useReal = isClear
        ? typeof args[0] === "object" && args[0] !== null
        : callerIsNodeBuiltin();
      if (useReal) return real.apply(this, args);
      depth++;
      try {
        return installed.apply(this, args);
      } finally {
        depth--;
      }
    },
  }[name];
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    get: () => dispatch,
    set: (value) => {
      installed = value === dispatch ? real : value;
    },
  });
}
