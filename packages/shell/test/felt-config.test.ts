import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

type EnvValues = Record<string, string | undefined>;

const FELT_CONFIG_URL = new URL("../felt.config.ts", import.meta.url);

async function withEnv<T>(
  values: EnvValues,
  run: () => Promise<T>,
): Promise<T> {
  const original = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    original.set(key, Deno.env.get(key));
    if (value === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, value);
    }
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of original.entries()) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }
}

async function importFreshConfig() {
  const url = new URL(FELT_CONFIG_URL.href);
  url.searchParams.set("test", crypto.randomUUID());
  const module = await import(url.href);
  return module.default;
}

describe("shell felt config", () => {
  it("wires modern experimental env vars into build-time defines", async () => {
    const config = await withEnv({
      PRESENCE_URL: "wss://presence.test",
      EXPERIMENTAL_MODERN_CELL_REP: "true",
      EXPERIMENTAL_AGENT_BUILTIN: "false",
      EXPERIMENTAL_CONTENT_ADDRESSED_SCHEMAS: "true",
    }, importFreshConfig);

    expect(config.esbuild?.define).toMatchObject({
      $PRESENCE_URL: "wss://presence.test/",
      $EXPERIMENTAL_MODERN_CELL_REP: "true",
      $EXPERIMENTAL_AGENT_BUILTIN: "false",
      $EXPERIMENTAL_CONTENT_ADDRESSED_SCHEMAS: "true",
    });
    const compileCacheVersion = config.esbuild?.define[
      "globalThis.__cfCompileCacheRuntimeVersion"
    ];
    expect(compileCacheVersion?.startsWith("cf/esm-compile/")).toBe(true);
    expect(compileCacheVersion).not.toBe("cf/esm-compile/source");
  });

  it("rejects an invalid presence URL before building", async () => {
    for (
      const value of [
        "https://presence.test",
        "wss://user:secret@presence.test",
        "wss://presence.test?room=shared",
        "wss://presence.test#fragment",
      ]
    ) {
      await expect(withEnv({
        PRESENCE_URL: value,
      }, importFreshConfig)).rejects.toThrow("PRESENCE_URL");
    }
  });
});
