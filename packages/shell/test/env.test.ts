import { expect } from "@std/expect";
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";

type ShellEnvGlobals = typeof globalThis & Record<string, string | undefined>;

function importFreshEnvModule() {
  return import(
    new URL(`../src/lib/env.ts?case=${crypto.randomUUID()}`, import.meta.url)
      .href
  );
}

function withPatchedGlobals<T>(
  globals: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const env = globalThis as ShellEnvGlobals;
  const original = Object.fromEntries(
    Object.keys(globals).map((key) => [key, env[key]]),
  );
  for (const [key, value] of Object.entries(globals)) {
    env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(original)) {
      env[key] = value;
    }
  });
}

Deno.test({
  name: "shell env reads the modern experimental globals",
  permissions: { read: true },
  async fn() {
    const mod = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_MODERN_CELL_REP: "true",
      $EXPERIMENTAL_CONTENT_ADDRESSED_SCHEMAS: "true",
    }, importFreshEnvModule);

    expect(mod.EXPERIMENTAL).toEqual({
      modernCellRep: true,
      // Server-execution v2: the first-party default (the landed-dark
      // constant) when the build define is unset.
      serverExecution: SERVER_EXECUTION_DEFAULT_ENABLED,
      contentAddressedSchemas: true,
    });
  },
});

Deno.test({
  name: "shell env preserves the agent builtin rollback override",
  permissions: { read: true },
  async fn() {
    const off = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_AGENT_BUILTIN: "false",
    }, importFreshEnvModule);
    expect(off.EXPERIMENTAL.agentBuiltin).toBe(false);

    const unset = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_AGENT_BUILTIN: undefined,
    }, importFreshEnvModule);
    expect(unset.EXPERIMENTAL.agentBuiltin).toBeUndefined();
  },
});

Deno.test({
  name: "shell env rejects a non-WebSocket presence service URL",
  permissions: { read: true },
  async fn() {
    await expect(withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $PRESENCE_URL: "https://presence.test",
    }, importFreshEnvModule)).rejects.toThrow("WebSocket URL");
  },
});

Deno.test({
  name: "shell env reads the optional presence service URL",
  permissions: { read: true },
  async fn() {
    const configured = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $PRESENCE_URL: "wss://presence.test/socket",
    }, importFreshEnvModule);
    expect(configured.PRESENCE_URL?.href).toBe(
      "wss://presence.test/socket",
    );

    const disabled = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $PRESENCE_URL: undefined,
    }, importFreshEnvModule);
    expect(disabled.PRESENCE_URL).toBeUndefined();
  },
});

Deno.test({
  name:
    "serverExecution: the build define selects the OFF arm (rollback lever) or forces ON",
  permissions: { read: true },
  async fn() {
    const off = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_SERVER_EXECUTION: "false",
    }, importFreshEnvModule);
    expect(off.EXPERIMENTAL.serverExecution).toBe(false);
    const on = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_SERVER_EXECUTION: "true",
    }, importFreshEnvModule);
    expect(on.EXPERIMENTAL.serverExecution).toBe(true);
    const unset = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_SERVER_EXECUTION: undefined,
    }, importFreshEnvModule);
    expect(unset.EXPERIMENTAL.serverExecution).toBe(
      SERVER_EXECUTION_DEFAULT_ENABLED,
    );
  },
});
