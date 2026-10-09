// Entry point for running workspace code under Node:
//
//   node --disable-proto=delete --import ./nodejs/register.mjs <module.ts>
//
// `nodejs/bin/cfnode` supplies those flags. This installs the loader hooks
// that resolve and compile the Deno workspace's modules, and the globals
// (`Deno`, and the web APIs Deno has and Node lacks) those modules use.

import { registerHooks } from "node:module";
import * as hooks from "./lib/hooks.mjs";

registerHooks({ resolve: hooks.resolve, load: hooks.load });
await import("./lib/deno-global.mjs");
await import("./lib/web-globals.mjs");
