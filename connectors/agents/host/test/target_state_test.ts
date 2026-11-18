import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { join, resolve } from "@std/path";
import {
  defaultAgentsHostStateDirectory,
  defaultTargetLedgerPath,
  parseAgentFabricApiUrl,
} from "../src/target-state.ts";

Deno.test("target ledger paths use the canonical API and resolved space", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const first = await defaultTargetLedgerPath(
      "https://user:secret@FABRIC.example.test:443/",
      "did:key:space",
      "did:key:owner",
      directory,
    );
    const equivalent = await defaultTargetLedgerPath(
      "https://fabric.example.test/ignored-api-path",
      "did:key:space",
      "did:key:owner",
      directory,
    );
    const differentSpace = await defaultTargetLedgerPath(
      "https://fabric.example.test/",
      "did:key:other-space",
      "did:key:owner",
      directory,
    );
    const differentOwner = await defaultTargetLedgerPath(
      "https://fabric.example.test/",
      "did:key:space",
      "did:key:other-owner",
      directory,
    );

    assertEquals(first, equivalent);
    assertNotEquals(first, differentSpace);
    assertNotEquals(first, differentOwner);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("XDG_STATE_HOME selects the durable agent host state directory", () => {
  const directory = defaultAgentsHostStateDirectory((key) =>
    key === "XDG_STATE_HOME" ? "/state" : undefined
  );
  assertEquals(directory, join("/state", "commonfabric", "agents-host"));
});

Deno.test("HOME selects the platform agent host state directory", () => {
  const home = (key: string) => key === "HOME" ? "/users/operator" : undefined;
  assertEquals(
    defaultAgentsHostStateDirectory(home, "darwin"),
    join(
      "/users/operator",
      "Library",
      "Application Support",
      "CommonFabric",
      "agents-host",
    ),
  );
  assertEquals(
    defaultAgentsHostStateDirectory(home, "linux"),
    join("/users/operator", ".local", "state", "commonfabric", "agents-host"),
  );
  assertThrows(
    () => defaultAgentsHostStateDirectory(() => undefined, "linux"),
    Error,
    "HOME is required",
  );
});

Deno.test("LOCALAPPDATA selects the Windows agent host state directory", () => {
  assertEquals(
    defaultAgentsHostStateDirectory(
      (key) => key === "LOCALAPPDATA" ? " C:\\Users\\operator " : undefined,
      "windows",
    ),
    join(resolve("C:\\Users\\operator"), "CommonFabric", "agents-host"),
  );
  assertThrows(
    () =>
      defaultAgentsHostStateDirectory(
        (key) => key === "HOME" ? "/users/operator" : undefined,
        "windows",
      ),
    Error,
    "LOCALAPPDATA is required",
  );
});

Deno.test("API URL parsing removes the input from failures", () => {
  const secret = "credential-that-must-not-appear";
  const error = assertThrows(
    () => parseAgentFabricApiUrl(`https://operator:${secret}@[invalid`),
    Error,
    "Common Fabric API URL is not valid",
  );
  assertEquals(error.cause, undefined);
  assertEquals(String(error).includes(secret), false);
});
