import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
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

/**
 * Runs `fn` with a page at `http://shell.test` whose deployment element
 * carries `tag` (none when undefined), its `fetch` returning `responses` in
 * turn and counting requests, and `console.warn` counted. Hands `fn` a fresh
 * env module built with `defines`, the counts, and a promise that settles at
 * the first warning.
 */
async function withShellPage(
  tag: string | undefined,
  responses: (() => Response)[],
  fn: (
    mod: Awaited<ReturnType<typeof importFreshEnvModule>>,
    counts: { pageReads: number; fetches: number; warnings: number },
    warned: Promise<void>,
  ) => Promise<void>,
  defines: Record<string, string | undefined> = {},
) {
  const env = globalThis as unknown as Record<string, unknown>;
  const originals = ["document", "location", "fetch"].map((name) =>
    [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const
  );
  const originalWarn = console.warn;
  const counts = { pageReads: 0, fetches: 0, warnings: 0 };
  const firstWarning = Promise.withResolvers<void>();
  env.document = {
    querySelector: (selector: string) => {
      counts.pageReads++;
      return tag !== undefined && selector === 'meta[name="cf-deployment"]'
        ? {
          getAttribute: (name: string) => name === "content" ? tag : null,
        }
        : null;
    },
  };
  env.location = { origin: "http://shell.test" };
  env.fetch = () => Promise.resolve(responses[counts.fetches++]());
  console.warn = () => {
    counts.warnings++;
    firstWarning.resolve();
  };
  try {
    const mod = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      ...defines,
    }, importFreshEnvModule);
    await fn(mod, counts, firstWarning.promise);
  } finally {
    console.warn = originalWarn;
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete env[name];
    }
  }
}

/** The element a toolshed with a router and sharing on writes. */
const SHARING_PAGE = JSON.stringify({
  memoryUrl: "https://router.test",
  experimental: { sharedMemoryConnection: true },
});
const ROUTED = {
  memoryUrl: new URL("https://router.test/"),
  experimental: { sharedMemoryConnection: true },
};
const NOTHING = { memoryUrl: undefined, experimental: {} };

const unreadable = () => new Response(null, { status: 500 });
const unavailable = () => new Response(null, { status: 503 });
const publishing = () =>
  Response.json({
    memoryUrl: "https://router.test",
    experimental: { sharedMemoryConnection: true },
  });

Deno.test({
  name: "shellDeployment reads the page it runs in, once",
  permissions: { read: true },
  async fn() {
    await withShellPage(SHARING_PAGE, [], async (mod, counts) => {
      mod.shellDeployment.prefetch();
      expect(await mod.shellDeployment.get()).toEqual(ROUTED);
      expect(await mod.shellDeployment.get()).toEqual(ROUTED);
      expect(counts.pageReads).toBe(1);
      expect(counts.fetches).toBe(0);
    });
  },
});

Deno.test({
  name:
    "shellDeployment gives the first runtime the read the page started, even one that failed",
  permissions: { read: true },
  async fn() {
    await withShellPage(
      undefined,
      [unreadable, unreadable],
      async (mod, counts, warned) => {
        mod.shellDeployment.prefetch();
        // The read has failed and settled before the first runtime asks.
        await warned;
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(await mod.shellDeployment.get()).toEqual(NOTHING);
        expect(counts.fetches).toBe(1);
        expect(counts.warnings).toBe(1);
      },
    );
  },
});

Deno.test({
  name:
    "shellDeployment keeps a failure that would come out the same, and warns once",
  permissions: { read: true },
  async fn() {
    await withShellPage(
      undefined,
      [unreadable, publishing],
      async (mod, counts) => {
        mod.shellDeployment.prefetch();
        expect(await mod.shellDeployment.get()).toEqual(NOTHING);
        expect(await mod.shellDeployment.get()).toEqual(NOTHING);
        expect(counts.fetches).toBe(1);
        expect(counts.warnings).toBe(1);
      },
    );
  },
});

Deno.test({
  name:
    "shellDeployment reads again for the next runtime after a transient failure, and keeps what it then reads",
  permissions: { read: true },
  async fn() {
    await withShellPage(
      undefined,
      [unavailable, unavailable, unavailable, publishing],
      async (mod, counts) => {
        // The read waits between its three attempts.
        using time = new FakeTime();
        mod.shellDeployment.prefetch();
        const first = mod.shellDeployment.get();
        await time.runAllAsync();
        expect(await first).toEqual(NOTHING);
        expect(counts.fetches).toBe(3);
        expect(await mod.shellDeployment.get()).toEqual(ROUTED);
        expect(await mod.shellDeployment.get()).toEqual(ROUTED);
        expect(counts.fetches).toBe(4);
      },
    );
  },
});

Deno.test({
  name:
    "sharedMemoryConnection: the deployment's value governs where no define pins it",
  permissions: { read: true },
  async fn() {
    for (const sharedMemoryConnection of [true, false]) {
      await withShellPage(
        JSON.stringify({
          memoryUrl: null,
          experimental: { sharedMemoryConnection },
        }),
        [],
        async (mod) => {
          // The define is unset in a release build; the shell takes the
          // deployment's word, whichever way it goes.
          expect(mod.EXPERIMENTAL.sharedMemoryConnection).toBeUndefined();
          const deployment = await mod.shellDeployment.get();
          expect(
            mod.experimentalForDeployment(deployment.experimental)
              .sharedMemoryConnection,
          ).toBe(sharedMemoryConnection);
        },
      );
    }
  },
});

Deno.test({
  name:
    "sharedMemoryConnection: the shell's default governs where the deployment says nothing",
  permissions: { read: true },
  async fn() {
    // A page from a toolshed without a Runtime, one whose Runtime left the
    // flag unresolved, and a page that reads a meta document saying nothing.
    for (
      const [tag, responses] of [
        [JSON.stringify({ memoryUrl: null, experimental: null }), []],
        [JSON.stringify({ memoryUrl: null, experimental: {} }), []],
        [undefined, [() => Response.json({ memoryUrl: null })]],
      ] as const
    ) {
      await withShellPage(tag, [...responses], async (mod) => {
        const deployment = await mod.shellDeployment.get();
        expect(deployment.experimental).toEqual({});
        const resolved = mod.experimentalForDeployment(deployment.experimental);
        expect(resolved.sharedMemoryConnection).toBeUndefined();
        // Nothing else moved.
        expect(resolved).toEqual(mod.EXPERIMENTAL);
      });
    }
  },
});

Deno.test({
  name:
    "sharedMemoryConnection: an explicit define overrides the deployment either way",
  permissions: { read: true },
  async fn() {
    for (
      const [define, published] of [["false", true], ["true", false]] as const
    ) {
      await withShellPage(
        JSON.stringify({
          memoryUrl: null,
          experimental: { sharedMemoryConnection: published },
        }),
        [],
        async (mod) => {
          const deployment = await mod.shellDeployment.get();
          expect(deployment.experimental).toEqual({
            sharedMemoryConnection: published,
          });
          expect(
            mod.experimentalForDeployment(deployment.experimental)
              .sharedMemoryConnection,
          ).toBe(define === "true");
        },
        { $EXPERIMENTAL_SHARED_MEMORY_CONNECTION: define },
      );
    }
  },
});

Deno.test({
  name:
    "experimentalForDeployment adopts only the flags the deployment decides for the shell",
  permissions: { read: true },
  async fn() {
    const mod = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_SERVER_EXECUTION: "false",
    }, importFreshEnvModule);
    // A deployment's word on any other flag does not reach the runtime: the
    // read restricts what it hands over, and this takes what it is handed.
    expect(mod.experimentalForDeployment({ sharedMemoryConnection: true }))
      .toEqual({ ...mod.EXPERIMENTAL, sharedMemoryConnection: true });
    expect(mod.experimentalForDeployment({})).toEqual(mod.EXPERIMENTAL);
  },
});
