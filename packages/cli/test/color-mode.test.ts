import { assert, assertEquals, assertFalse } from "@std/assert";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

import {
  extractNoColor,
  resolveColorEnabled,
  safeEnvGet,
} from "../lib/color-mode.ts";
import type { ColorOutput } from "./fixtures/color-mode-output.ts";

const noEnv = () => undefined;

Deno.test("extractNoColor strips the flag and reports it", () => {
  assertEquals(extractNoColor(["--no-color", "piece", "ls"]), {
    noColor: true,
    args: ["piece", "ls"],
  });
  assertEquals(extractNoColor(["piece", "ls"]), {
    noColor: false,
    args: ["piece", "ls"],
  });
});

Deno.test("extractNoColor leaves payload args after -- untouched", () => {
  // `--no-color` after `--` is a schema-derived flag for the target handler,
  // not a color directive; eating it would silently drop handler input.
  assertEquals(
    extractNoColor(["call", "h", "--", "--no-color", "x"]),
    {
      noColor: false,
      args: ["call", "h", "--", "--no-color", "x"],
    },
  );
  // Both positions: the leading one is consumed, the payload one survives.
  assertEquals(
    extractNoColor(["--no-color", "call", "h", "--", "--no-color"]),
    {
      noColor: true,
      args: ["call", "h", "--", "--no-color"],
    },
  );
});

Deno.test("safeEnvGet returns undefined instead of throwing", () => {
  // A present var reads through.
  Deno.env.set("CF_COLOR_MODE_TEST", "x");
  try {
    assertEquals(safeEnvGet("CF_COLOR_MODE_TEST"), "x");
  } finally {
    Deno.env.delete("CF_COLOR_MODE_TEST");
  }
  // An unset var is undefined, not an error.
  assertEquals(safeEnvGet("CF_DEFINITELY_UNSET_VAR_XYZ"), undefined);
  // An invalid key (empty string) makes Deno.env.get throw — swallowed.
  assertEquals(safeEnvGet(""), undefined);
});

Deno.test("resolveColorEnabled follows a TTY by default", () => {
  assert(resolveColorEnabled({
    noColorFlag: false,
    denoNoColor: false,
    isTerminal: true,
    env: noEnv,
  }));
  assertFalse(resolveColorEnabled({
    noColorFlag: false,
    denoNoColor: false,
    isTerminal: false,
    env: noEnv,
  }));
});

Deno.test("resolveColorEnabled disable overrides win over everything", () => {
  const forceEnv = (key: string) => key === "FORCE_COLOR" ? "1" : undefined;
  assertFalse(resolveColorEnabled({
    noColorFlag: true,
    denoNoColor: false,
    isTerminal: true,
    env: forceEnv,
  }));
  assertFalse(resolveColorEnabled({
    noColorFlag: false,
    denoNoColor: true,
    isTerminal: true,
    env: forceEnv,
  }));
});

Deno.test("resolveColorEnabled: NO_COLOR wins over both force vars (raw env)", () => {
  // Reproduces the live bug at the env level: with NO_COLOR set, color must
  // stay off regardless of FORCE_COLOR/CLICOLOR_FORCE. denoNoColor is false
  // here because Deno pre-arbitrates FORCE_COLOR over NO_COLOR — the resolver
  // must consult the raw NO_COLOR var, not just the pre-arbitrated flag.
  assertFalse(resolveColorEnabled({
    noColorFlag: false,
    denoNoColor: false,
    isTerminal: true,
    env: (key) =>
      key === "NO_COLOR" ? "1" : key === "FORCE_COLOR" ? "1" : undefined,
  }));
  assertFalse(resolveColorEnabled({
    noColorFlag: false,
    denoNoColor: false,
    isTerminal: true,
    env: (key) =>
      key === "NO_COLOR" ? "1" : key === "CLICOLOR_FORCE" ? "1" : undefined,
  }));
  // An empty NO_COLOR is "unset" per the NO_COLOR spec — force still wins.
  assert(resolveColorEnabled({
    noColorFlag: false,
    denoNoColor: false,
    isTerminal: false,
    env: (key) =>
      key === "NO_COLOR" ? "" : key === "FORCE_COLOR" ? "1" : undefined,
  }));
});

Deno.test("resolveColorEnabled honors FORCE_COLOR / CLICOLOR_FORCE when piped", () => {
  assert(resolveColorEnabled({
    noColorFlag: false,
    denoNoColor: false,
    isTerminal: false,
    env: (key) => key === "FORCE_COLOR" ? "1" : undefined,
  }));
  assert(resolveColorEnabled({
    noColorFlag: false,
    denoNoColor: false,
    isTerminal: false,
    env: (key) => key === "CLICOLOR_FORCE" ? "1" : undefined,
  }));
  // "0" and "" do not force
  assertFalse(resolveColorEnabled({
    noColorFlag: false,
    denoNoColor: false,
    isTerminal: false,
    env: (key) => key === "FORCE_COLOR" ? "0" : undefined,
  }));
  assertFalse(resolveColorEnabled({
    noColorFlag: false,
    denoNoColor: false,
    isTerminal: false,
    env: (key) => key === "FORCE_COLOR" ? "" : undefined,
  }));
});

// The first rendering test starts the child; both tests share its output.
let colorOutputPromise: Promise<ColorOutput> | undefined;

/** Renders with color support established before Deno and its modules load. */
async function readColorOutput(): Promise<ColorOutput> {
  const output = await runDenoCommandWithTemporaryLock({
    root: fromFileUrl(new URL("../../../", import.meta.url)),
    args: (lock) => [
      "run",
      "--quiet",
      "--frozen",
      `--lock=${lock}`,
      "--allow-read",
      "--allow-env",
      "--allow-ffi",
      fromFileUrl(new URL("./fixtures/color-mode-output.ts", import.meta.url)),
    ],
    env: { NO_COLOR: "", FORCE_COLOR: "", CLICOLOR_FORCE: "" },
  });
  expect(output.code, new TextDecoder().decode(output.stderr)).toBe(0);
  return JSON.parse(new TextDecoder().decode(output.stdout)) as ColorOutput;
}

Deno.test("setColorEnabled controls Cliffy version output", async () => {
  // Guards the invariant behind the "@std/fmt/colors" import-map pin in
  // packages/cli/deno.jsonc: our setColorEnabled() must reach the same module
  // instance Cliffy styles version/error output with. If Cliffy's @std/fmt
  // dependency range drifts away from the pin, this test fails and the pin must
  // be updated.

  const output = await (colorOutputPromise ??= readColorOutput());
  expect(output.plainVersion).toMatch(/\S/);
  expect(output.plainVersion).not.toContain("\x1b[");
  expect(output.coloredVersion).toContain("\x1b[");
});

Deno.test("help colors follow the Cliffy help option", async () => {
  // Cliffy's HelpGenerator force-sets its own `colors` option while rendering,
  // so help output is controlled through Command.help(), not setColorEnabled —
  // mod.ts mirrors the resolved policy into main.help({ colors }).

  const output = await (colorOutputPromise ??= readColorOutput());
  expect(output.plainHelp).toMatch(/\S/);
  expect(output.plainHelp).not.toContain("\x1b[");
  expect(output.plainCellHelp).toMatch(/\S/);
  expect(output.plainCellHelp).not.toContain("\x1b[");
  expect(output.coloredHelp).toContain("\x1b[");
});
