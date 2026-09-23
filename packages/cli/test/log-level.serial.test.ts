import { assertEquals } from "@std/assert";
import {
  getGlobalLogFloor,
  setGlobalLogFloor,
} from "@commonfabric/utils/logger";
import { applyLogLevel, extractLogLevel } from "../lib/log-level.ts";

// applyLogLevel mutates the global log floor and the CF_LOG_LEVEL env var;
// snapshot and restore both so the cases don't leak into each other or the
// rest of the suite.
function withCleanLogEnv(fn: () => void): void {
  const prevEnv = Deno.env.get("CF_LOG_LEVEL");
  const prevFloor = getGlobalLogFloor();
  Deno.env.delete("CF_LOG_LEVEL");
  setGlobalLogFloor(undefined);
  try {
    fn();
  } finally {
    if (prevEnv === undefined) Deno.env.delete("CF_LOG_LEVEL");
    else Deno.env.set("CF_LOG_LEVEL", prevEnv);
    setGlobalLogFloor(prevFloor);
  }
}

Deno.test("applyLogLevel defaults the floor to warn", () => {
  withCleanLogEnv(() => {
    const cleanArgs = applyLogLevel(["check", "./p.tsx"]);
    assertEquals(getGlobalLogFloor(), "warn");
    assertEquals(Deno.env.get("CF_LOG_LEVEL"), "warn");
    assertEquals(cleanArgs, ["check", "./p.tsx"]);
  });
});

Deno.test("applyLogLevel honors an explicit --log-level and strips it", () => {
  withCleanLogEnv(() => {
    const cleanArgs = applyLogLevel([
      "--log-level",
      "error",
      "check",
      "./p.tsx",
    ]);
    assertEquals(getGlobalLogFloor(), "error");
    assertEquals(Deno.env.get("CF_LOG_LEVEL"), "error");
    assertEquals(cleanArgs, ["check", "./p.tsx"]);
  });
});

Deno.test("applyLogLevel leaves a preset CF_LOG_LEVEL untouched", () => {
  withCleanLogEnv(() => {
    Deno.env.set("CF_LOG_LEVEL", "debug");
    setGlobalLogFloor("debug");
    const cleanArgs = applyLogLevel(["piece", "ls"]);
    assertEquals(Deno.env.get("CF_LOG_LEVEL"), "debug");
    assertEquals(getGlobalLogFloor(), "debug");
    assertEquals(cleanArgs, ["piece", "ls"]);
  });
});

Deno.test("extractLogLevel ignores an invalid --log-level value", () => {
  // A non-level value is not consumed; it stays in the args and no level is
  // returned, so applyLogLevel falls through to the warn default.
  const { level, args } = extractLogLevel(["--log-level", "bogus", "check"]);
  assertEquals(level, undefined);
  assertEquals(args, ["--log-level", "bogus", "check"]);
});

Deno.test("extractLogLevel leaves payload args after -- untouched", () => {
  // `--log-level error` after `--` is a schema-derived flag for the target
  // handler, not a CLI directive; eating it would silently drop handler input.
  const { level, args } = extractLogLevel([
    "call",
    "h",
    "--",
    "--log-level",
    "error",
  ]);
  assertEquals(level, undefined);
  assertEquals(args, ["call", "h", "--", "--log-level", "error"]);
});

Deno.test("extractLogLevel consumes the leading flag and keeps the payload one", () => {
  const { level, args } = extractLogLevel([
    "--log-level",
    "debug",
    "call",
    "h",
    "--",
    "--log-level",
    "error",
  ]);
  assertEquals(level, "debug");
  assertEquals(args, ["call", "h", "--", "--log-level", "error"]);
});

Deno.test("extractLogLevel does not pair a flag with a value across --", () => {
  // `--log-level` as the last token before `--` has no in-bounds value; it
  // stays put rather than consuming the payload boundary.
  const { level, args } = extractLogLevel(["--log-level", "--", "error"]);
  assertEquals(level, undefined);
  assertEquals(args, ["--log-level", "--", "error"]);
});
