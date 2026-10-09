// Entry point for running workspace code under Node:
//
//   node --import ./nodejs/register.mjs <module.ts> [args...]
//
// Installs the loader hooks that resolve and compile the Deno workspace's
// modules, and the `Deno` global those modules use.

import { register } from "node:module";

register("./lib/hooks.mjs", import.meta.url);
await import("./lib/deno-global.mjs");
