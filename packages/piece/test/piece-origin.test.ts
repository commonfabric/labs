import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { FabricInstance } from "@commonfabric/data-model";
import { createSession, Identity } from "@commonfabric/identity";
import {
  applyPieceSourceTransition,
  type Cell,
  classifyPieceOriginString,
  getPatternIdentityRef,
  getPieceSourceRevisions,
  getPieceSourceSnapshot,
  type MemorySpace,
  parseLinkOrThrow,
  preparePieceSourceTransitionBaseline,
  resolveSystemPatternSource,
  Runtime,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { patchableCell } from "../../runner/test/support/patchable-cell.ts";
import {
  preloadCloneValue,
  snapshotCloneValue,
} from "../src/ops/clone-data-snapshot.ts";
import { PieceController } from "../src/ops/piece-controller.ts";
import {
  classifyOrigin,
  PieceOriginError,
  readPieceOrigin,
  readPieceSourceState,
  resolvePieceOriginSource,
} from "../src/ops/piece-origin.ts";
import {
  DEFAULT_APP_PATTERN_SOURCE,
  PiecesController,
} from "../src/ops/pieces-controller.ts";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";

// The route that ref resolves to.
const DEFAULT_APP_PATTERN_PATH = resolveSystemPatternSource(
  DEFAULT_APP_PATTERN_SOURCE,
)!;

const signer = await Identity.fromPassphrase("piece origin");

const COUNTER_SOURCE = [
  "import { pattern, Writable, NAME } from 'commonfabric';",
  "export default pattern<{ label: string }>(({ label }) => {",
  "  const count = new Writable(0).for('count');",
  "  return { [NAME]: 'Counter', label, count };",
  "});",
  "",
].join("\n");

const DEFAULT_APP_SOURCE = [
  "import { pattern } from 'commonfabric';",
  "export default pattern<{ items: string[] }>(({ items }) => ({ items }));",
  "",
].join("\n");

const FOLLOW_SOURCE = [
  "import { pattern } from 'commonfabric';",
  "export default pattern<{ value?: number }>(() => ({ marker: 1 + 0 }));",
  "",
].join("\n");

const CONFIDENTIAL_SOURCE = [
  "import { pattern, type Confidential } from 'commonfabric';",
  "const SECRET = {",
  "  type: 'https://commonfabric.org/cfc/atom/Resource',",
  "  class: 'CloneTestSecret',",
  "  subject: 'did:example:clone-test',",
  "} as const;",
  "type Input = { secret: Confidential<string, readonly [typeof SECRET]> };",
  "export default pattern<Input>(({ secret }) => ({ secret }));",
  "",
].join("\n");

const CONFIDENTIAL_WRITABLE_SOURCE = [
  "import { Confidential, pattern, Writable } from 'commonfabric';",
  "const SECRET = {",
  "  type: 'https://commonfabric.org/cfc/atom/Resource',",
  "  class: 'CloneTestLinkedSecret',",
  "  subject: 'did:example:clone-test-linked',",
  "} as const;",
  "type Output = {",
  "  secret: Confidential<Writable<string>, readonly [typeof SECRET]>;",
  "};",
  "export default pattern<Record<string, never>, Output>(() => ({",
  "  secret: new Writable('classified').for('secret'),",
  "}));",
  "",
].join("\n");

const LINK_INPUT_SOURCE = [
  "import { pattern, Writable } from 'commonfabric';",
  "type Input = { nested: { secret: Writable<string> } };",
  "export default pattern<Input>(({ nested }) => ({ secret: nested.secret }));",
  "",
].join("\n");

const WRITABLE_SOURCE = [
  "import { pattern, Writable } from 'commonfabric';",
  "export default pattern(() => ({",
  "  value: new Writable('shared').for('value'),",
  "}));",
  "",
].join("\n");

const UNKNOWN_INPUT_SOURCE = [
  "import { pattern } from 'commonfabric';",
  "export default pattern<{ value: unknown }, { marker: number }>(() => ({",
  "  marker: 1,",
  "}));",
  "",
].join("\n");

const ARRAY_INPUT_SOURCE = [
  "import { pattern } from 'commonfabric';",
  "type Item = number | { nested: number[] };",
  "export default pattern<{ value: Item[] }, { marker: number }>(() => ({",
  "  marker: 1,",
  "}));",
  "",
].join("\n");

const DERIVED_AND_STREAM_SOURCE = [
  "import { action, computed, pattern, Writable } from 'commonfabric';",
  "export default pattern<{ value: number }>(({ value }) => {",
  "  const count = new Writable(0).for('count');",
  "  return {",
  "    count,",
  "    doubled: computed(() => value * 2),",
  "    increment: action(() => count.set(count.get() + 1)),",
  "  };",
  "});",
  "",
].join("\n");

class CloneTestInstance extends FabricInstance {
  deepClone(): FabricInstance {
    return this;
  }

  shallowClone(): FabricInstance {
    return this;
  }
}

/**
 * Serve pattern source from memory, so the resolver and runtime.fetch need no
 * network. Mirrors the stub in pattern-source-provenance.test.ts.
 */
function installFetchStub(sources: Record<string, string>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url,
    );
    const source = sources[url.pathname];
    if (source === undefined) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    return Promise.resolve(
      new Response(source, {
        headers: { "content-type": "text/typescript-jsx" },
      }),
    );
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const HASH = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SPACE = "did:key:z6MkspaceAAAA" as MemorySpace;

describe("classifyOrigin", () => {
  const runtime = {
    hostForSpace: () => new URL("https://toolshed.test"),
  } as unknown as Runtime;

  it("resolves a toolshed-relative path against the space's host", () => {
    expect(classifyOrigin(runtime, SPACE, "/api/patterns/system/home.tsx"))
      .toEqual({
        url: "https://toolshed.test/api/patterns/system/home.tsx",
        kind: "system",
        recorded: "/api/patterns/system/home.tsx",
      });
  });

  it("rejects an absolute external endpoint", () => {
    expect(() => classifyOrigin(runtime, SPACE, "https://example.test/p.tsx"))
      .toThrow("is an external endpoint");
  });

  it("rejects the patterns route spelled against another host", () => {
    // It names the same file this deployment serves, but on somebody else's
    // host, and following it would be following them rather than us.
    expect(() =>
      classifyOrigin(
        runtime,
        SPACE,
        "https://other.test/api/patterns/system/home.tsx",
      )
    ).toThrow("is an external endpoint");
  });

  it("reads an unpinned entity reference as a mutable piece origin", () => {
    expect(classifyOrigin(runtime, SPACE, `cf:/${SPACE}/of:fid1:${HASH}`))
      .toEqual({ url: `cf:/${SPACE}/of:fid1:${HASH}`, kind: "fabric-piece" });
  });

  it("reads a content-addressed pattern reference as immutable", () => {
    expect(classifyOrigin(runtime, SPACE, `cf:pattern:${HASH}`))
      .toEqual({ url: `cf:pattern:${HASH}`, kind: "fabric-pattern" });
  });

  it("reads a pinned entity reference as immutable", () => {
    const url = `cf:/${SPACE}/of:fid1:${HASH}@${HASH}`;
    expect(classifyOrigin(runtime, SPACE, url))
      .toEqual({ url, kind: "fabric-pattern" });
  });

  it("rejects a string that names no place source can be fetched from", () => {
    expect(() => classifyOrigin(runtime, SPACE, "")).toThrow(PieceOriginError);
    expect(() => classifyOrigin(runtime, SPACE, "counter.tsx")).toThrow(
      PieceOriginError,
    );
    expect(() => classifyOrigin(runtime, SPACE, "file:///tmp/p.tsx")).toThrow(
      PieceOriginError,
    );
  });

  it("reports a malformed fabric URL as an unusable origin", () => {
    // The parser's own error is a layer below; callers see one kind of failure.
    expect(() => classifyOrigin(runtime, SPACE, "cf:of:fid1:short")).toThrow(
      PieceOriginError,
    );
    expect(() => classifyOrigin(runtime, SPACE, "cf:module/x")).toThrow(
      PieceOriginError,
    );
  });
});

describe("resolvePieceOriginSource", () => {
  it("rejects a fabric source subpath before resolving its entry", async () => {
    const runtime = {
      hostForSpace: () => new URL("https://toolshed.test"),
    } as unknown as Runtime;
    await expect(
      resolvePieceOriginSource(
        runtime,
        SPACE,
        `cf:pattern:${HASH}/schemas`,
        "default",
      ),
    ).rejects.toThrow("piece source subpaths are not supported");
  });

  it("rejects a mutable fabric alias as lifecycle authority", async () => {
    const runtime = {
      hostForSpace: () => new URL("https://toolshed.test"),
    } as unknown as Runtime;
    await expect(
      resolvePieceOriginSource(
        runtime,
        SPACE,
        `cf:/${SPACE}/friendly-name`,
        "default",
      ),
    ).rejects.toThrow(
      "piece origins require a stable fabric entity or pattern reference",
    );
  });

  it("reads a mutable piece's source from its explicit space", async () => {
    const otherSpace = "did:key:z6MkspaceBBBB" as MemorySpace;
    const reads: string[] = [];
    const runtime = {
      hostForSpace: () => new URL("https://toolshed.test"),
      getCellFromEntityId: (space: string) => {
        reads.push(`piece:${space}`);
        return {
          sync: () => Promise.resolve(),
          getMetaRaw: (name: string) =>
            name === "patternIdentity"
              ? { identity: HASH, symbol: "upstream" }
              : undefined,
        };
      },
      patternManager: {
        getPatternSourceProgramByIdentity: (
          _identity: string,
          space: string,
        ) => {
          reads.push(`source:${space}`);
          return Promise.resolve({
            main: "/main.tsx",
            files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
          });
        },
      },
    } as unknown as Runtime;
    const resolved = await resolvePieceOriginSource(
      runtime,
      SPACE,
      `cf:/${otherSpace}/of:fid1:${HASH}`,
      "default",
    );

    expect(resolved.pattern).toEqual({ identity: HASH, symbol: "upstream" });
    expect(resolved.program.mainExport).toBe("upstream");
    expect(reads).toEqual([`piece:${otherSpace}`, `source:${otherSpace}`]);
  });

  it("refuses a self-reference before it registers the host it names", async () => {
    const registrations: unknown[] = [];
    const runtime = {
      mappedHostFor: () => undefined,
      hostForSpace: () => new URL("https://toolshed.test"),
      registerSpaceHost: (...args: unknown[]) => {
        registrations.push(args);
        return true;
      },
    } as unknown as Runtime;

    await expect(resolvePieceOriginSource(
      runtime,
      SPACE,
      `cf://other.test/${SPACE}/of:fid1:${HASH}`,
      "default",
      { self: { space: SPACE, pieceId: `of:fid1:${HASH}` } },
    )).rejects.toThrow("a piece cannot follow itself");
    // Registering a host changes the route the space resolves through, and a
    // reference this call refuses must not leave that behind.
    expect(registrations).toEqual([]);
  });

  it("does not register an unaccepted host while resolving another space", async () => {
    const otherSpace = "did:key:z6MkspaceBBBB" as MemorySpace;
    const registrations: unknown[] = [];
    const runtime = {
      mappedHostFor: () => undefined,
      hostForSpace: () => new URL("https://toolshed.test"),
      registerSpaceHost: (...args: unknown[]) => {
        registrations.push(args);
        return true;
      },
    } as unknown as Runtime;

    await expect(resolvePieceOriginSource(
      runtime,
      SPACE,
      `cf://other.test/${otherSpace}/of:fid1:${HASH}`,
      "default",
    )).rejects.toThrow(
      `the cross-space host other.test is not an accepted route for ${otherSpace}`,
    );
    expect(registrations).toEqual([]);
  });

  it("rejects a named space without resolving or registering it", async () => {
    let resolvedName = false;
    const runtime = {
      hostForSpace: () => new URL("https://toolshed.test"),
      resolveSpaceName: () => {
        resolvedName = true;
        return Promise.resolve(SPACE);
      },
    } as unknown as Runtime;
    await expect(
      resolvePieceOriginSource(
        runtime,
        SPACE,
        `cf:/friendly-space/of:fid1:${HASH}`,
        "default",
      ),
    ).rejects.toThrow("piece origins require an explicit space DID");
    expect(resolvedName).toBe(false);
  });

  it("accepts the effective default host after the space provider opens", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    try {
      const controller = new PiecesController(
        await createSession({
          identity: signer,
          spaceName: `same-host-origin-${crypto.randomUUID()}`,
        }),
        runtime,
      );
      await controller.synced();
      const piece = await controller.create({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
      }, { input: { label: "same host" } });
      const state = await readPieceSourceState(runtime, piece.getCell());

      for (const host of ["toolshed.test", "TOOLSHED.TEST:80"]) {
        const resolved = await resolvePieceOriginSource(
          runtime,
          controller.getSpace(),
          `cf://${host}/${controller.getSpace()}/pattern:${
            state.pattern!.identity
          }`,
          state.pattern!.symbol,
        );

        expect(resolved.pattern).toEqual(state.pattern);
        expect(resolved.program.main).toBe("/main.tsx");
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("compares a fabric authority with a default base URL by origin", async () => {
    const registrations: string[] = [];
    const runtime = {
      hostForSpace: () => new URL("https://toolshed.test/api/"),
      mappedHostFor: () => undefined,
      registerSpaceHost: (_space: MemorySpace, host: string) => {
        registrations.push(host);
        return true;
      },
      patternManager: {
        getPatternSourceProgramByIdentity: () =>
          Promise.resolve({ main: "/main.tsx", files: [] }),
      },
    } as unknown as Runtime;

    const resolved = await resolvePieceOriginSource(
      runtime,
      SPACE,
      `cf://toolshed.test/${SPACE}/pattern:${HASH}`,
      "named",
    );

    expect(resolved.pattern).toEqual({ identity: HASH, symbol: "named" });
    expect(registrations).toEqual([]);
  });

  it("registers a fabric authority when the default has no HTTP origin", async () => {
    const registrations: string[] = [];
    const runtime = {
      hostForSpace: () => new URL("file:///tmp/toolshed"),
      mappedHostFor: () => undefined,
      registerSpaceHost: (_space: MemorySpace, host: string) => {
        registrations.push(host);
        return true;
      },
      patternManager: {
        getPatternSourceProgramByIdentity: () =>
          Promise.resolve({ main: "/main.tsx", files: [] }),
      },
    } as unknown as Runtime;

    const resolved = await resolvePieceOriginSource(
      runtime,
      SPACE,
      `cf://source.test/${SPACE}/pattern:${HASH}`,
      "named",
    );

    expect(resolved.pattern).toEqual({ identity: HASH, symbol: "named" });
    expect(registrations).toEqual(["https://source.test/"]);
  });

  it("registers an explicit source host using the runtime transport policy", async () => {
    const registrations: string[] = [];
    const runtime = {
      hostForSpace: () => new URL("http://toolshed.test"),
      mappedHostFor: () => undefined,
      registerSpaceHost: (_space: MemorySpace, host: string) => {
        registrations.push(host);
        return true;
      },
      patternManager: {
        getPatternSourceProgramByIdentity: () =>
          Promise.resolve({ main: "/main.tsx", files: [] }),
      },
    } as unknown as Runtime;

    for (
      const [host, registered] of [
        ["source.test", "https://source.test/"],
        ["localhost:8787", "http://localhost:8787/"],
        ["127.0.0.1:8787", "http://127.0.0.1:8787/"],
      ]
    ) {
      const resolved = await resolvePieceOriginSource(
        runtime,
        SPACE,
        `cf://${host}/${SPACE}/pattern:${HASH}`,
        "named",
      );
      expect(resolved.pattern).toEqual({ identity: HASH, symbol: "named" });
      expect(registrations.at(-1)).toBe(registered);
    }
  });

  it("defaults a loopback source authority to HTTPS", async () => {
    const registrations: string[] = [];
    const runtime = {
      hostForSpace: () => new URL("https://toolshed.test"),
      mappedHostFor: () => undefined,
      registerSpaceHost: (_space: MemorySpace, host: string) => {
        registrations.push(host);
        return true;
      },
      patternManager: {
        getPatternSourceProgramByIdentity: () =>
          Promise.resolve({ main: "/main.tsx", files: [] }),
      },
    } as unknown as Runtime;

    await resolvePieceOriginSource(
      runtime,
      SPACE,
      `cf://localhost:8787/${SPACE}/pattern:${HASH}`,
      "named",
    );
    expect(registrations).toEqual(["https://localhost:8787/"]);
  });

  it("rejects an explicit source host the runtime cannot register", async () => {
    const runtime = {
      hostForSpace: () => new URL("https://toolshed.test"),
      mappedHostFor: () => undefined,
      registerSpaceHost: () => false,
    } as unknown as Runtime;

    await expect(
      resolvePieceOriginSource(
        runtime,
        SPACE,
        `cf://source.test/${SPACE}/pattern:${HASH}`,
        "default",
      ),
    ).rejects.toThrow(`the host source.test is not available for ${SPACE}`);
  });

  it("rejects a mutable piece that does not currently name a pattern", async () => {
    const runtime = {
      hostForSpace: () => new URL("https://toolshed.test"),
      getCellFromEntityId: () => ({
        sync: () => Promise.resolve(),
        getMetaRaw: () => undefined,
      }),
    } as unknown as Runtime;

    await expect(
      resolvePieceOriginSource(
        runtime,
        SPACE,
        `cf:/${SPACE}/of:fid1:${HASH}`,
        "default",
      ),
    ).rejects.toThrow("does not currently resolve to a piece pattern");
  });

  it("rejects a fabric pattern whose retained source is unavailable", async () => {
    const runtime = {
      hostForSpace: () => new URL("https://toolshed.test"),
      patternManager: {
        getPatternSourceProgramByIdentity: () => Promise.resolve(undefined),
      },
    } as unknown as Runtime;

    await expect(
      resolvePieceOriginSource(
        runtime,
        SPACE,
        `cf:pattern:${HASH}`,
        "default",
      ),
    ).rejects.toThrow(`source for ${HASH} is not available`);
  });
});

/**
 * A piece stands in for its recorded metadata here: these cases are about what
 * the reader makes of metadata combinations, and a real piece cannot be given a
 * displaced-pattern record or a repository locator without the operations that
 * write them.
 */
function pieceWith(
  { meta = {}, name, files = [], entry }: {
    meta?: Record<string, unknown>;
    name?: string;
    files?: { name: string; contents: string }[];
    entry?: string;
  },
): { piece: Cell<unknown>; runtime: Runtime } {
  const piece = {
    space: SPACE,
    sync: () => Promise.resolve(),
    getMetaRaw: (field: string) => meta[field],
    getAsNormalizedFullLink: () => ({ id: `of:fid1:${HASH}` }),
    asSchema: () => ({
      get: () => (name === undefined ? {} : { $NAME: name }),
    }),
  } as unknown as Cell<unknown>;
  const runtime = {
    hostForSpace: () => new URL("https://toolshed.test"),
    patternManager: {
      getPatternSourceProgramByIdentity: () =>
        Promise.resolve(
          entry === undefined ? undefined : { main: entry, files },
        ),
    },
  } as unknown as Runtime;
  return { piece, runtime };
}

describe("the two classifiers a recorded origin meets", () => {
  it("agree on which strings can be followed at all", () => {
    // `classifyOrigin` decides what the source panel shows and what an
    // entered origin is allowed to become. `classifyPieceOriginString`
    // decides what reconciliation will follow. They answer different
    // questions and use different words for the kinds, but they have to
    // agree on the boundary: a string one accepts and the other calls
    // unusable would be stored as an origin that nothing follows, and
    // reported by the panel as an origin that is fine.
    const host = "https://toolshed.test";
    const runtime = { hostForSpace: () => new URL(host) } as unknown as Runtime;
    const hash = "b".repeat(43);
    const strings: string[] = [
      "system:system/home.tsx",
      "/api/patterns/system/home.tsx",
      `${host}/api/patterns/system/home.tsx`,
      "https://example.test/p.tsx",
      "http://example.test/p.tsx",
      "ftp://example.test/p.tsx",
      "not a url",
      "",
      "   ",
      `cf:pattern:${hash}`,
      `cf:/did:key:z6Mkabc/of:fid1:${hash}`,
      `cf://host.test/did:key:z6Mkabc/of:fid1:${hash}`,
      "cf:/did:key:z6Mkabc/some-slug",
      `cf:of:fid1:${hash}`,
      `cf:/did:key:z6Mkabc/of:fid1:${hash}@${"c".repeat(43)}`,
      "../relative.tsx",
      "data:text/plain,x",
      "cf:!!malformed",
      // A protocol-relative string looks like a rooted path and is not one:
      // resolved against the host it names a different authority entirely.
      "//evil.example/x",
      "//evil.example",
      "/\\evil.example/x",
      "\\\\evil.example\\x",
    ];

    // Rooted paths on this host that name nothing under the patterns route.
    // Both sides refuse them: the path names no file this deployment serves,
    // so nothing resolves it.
    strings.push("/", "/nope.tsx", "/api/patterns/../../etc/passwd");

    for (const recorded of strings) {
      const kind = classifyPieceOriginString(recorded, host);
      // A rooted path carrying no ref names nothing under the patterns route,
      // and reconciliation reports it unusable rather than following it, so
      // that is what "followable" has to mean here.
      const followable = kind.kind !== "unusable" &&
        !(kind.kind === "legacy-path" && kind.ref === undefined);
      let usable: boolean;
      try {
        classifyOrigin(runtime, SPACE, recorded);
        usable = true;
      } catch {
        usable = false;
      }
      expect({ recorded, usable }).toEqual({ recorded, usable: followable });
    }
  });

  it("refuses a rooted path that resolves to another host", () => {
    const host = "https://toolshed.test";
    const runtime = { hostForSpace: () => new URL(host) } as unknown as Runtime;
    // Both begin with a slash and neither names this host: the URL parser
    // reads `//` as an authority and a backslash as a separator. A guard
    // written against the spellings would need one arm per such trick, so
    // what decides it is where the string actually resolved.
    for (const recorded of ["//evil.example/x", "/\\evil.example/x"]) {
      expect(() => classifyOrigin(runtime, SPACE, recorded)).toThrow(
        "resolves to https://evil.example",
      );
    }
    // A rooted path on this host is still an ordinary origin.
    expect(classifyOrigin(runtime, SPACE, "/api/patterns/x.tsx").url).toBe(
      "https://toolshed.test/api/patterns/x.tsx",
    );
  });
});

describe("readPieceOrigin", () => {
  it("reads a piece with no recorded source as detached", () => {
    const { piece, runtime } = pieceWith({});
    expect(readPieceOrigin(runtime, piece)).toBeUndefined();
  });

  it("reads an unclassifiable recorded source as detached", () => {
    // The string names no place the source could be resolved from, so it is no
    // more an origin than an absent one.
    const { piece, runtime } = pieceWith({
      meta: { patternSource: "not a url" },
    });
    expect(readPieceOrigin(runtime, piece)).toBeUndefined();
  });
});

describe("readPieceSourceState collects every recorded fact", () => {
  it("reports the setup, displaced, and repository metadata a piece carries", async () => {
    const { piece, runtime } = pieceWith({
      name: "Recipe",
      entry: "/main.tsx",
      files: [
        { name: "/helper.tsx", contents: "helper" },
        { name: "/main.tsx", contents: "main" },
        { name: "/aaa.tsx", contents: "aaa" },
      ],
      meta: {
        patternSource: "system:system/home.tsx",
        patternIdentity: { identity: "abc", symbol: "default" },
        patternSetupIdentity: { identity: "older", symbol: "default" },
        displacedPattern: {
          identity: "displaced",
          symbol: "default",
          displacedAt: 1_700_000_000_000,
        },
        patternRepository: "https://github.com/example/recipes",
      },
    });

    const state = await readPieceSourceState(runtime, piece);
    expect(state.name).toBe("Recipe");
    expect(state.pattern).toEqual({ identity: "abc", symbol: "default" });
    expect(state.setupPattern).toEqual({
      identity: "older",
      symbol: "default",
    });
    expect(state.displacedPattern).toEqual({
      identity: "displaced",
      symbol: "default",
      displacedAt: 1_700_000_000_000,
    });
    expect(state.repository).toBe("https://github.com/example/recipes");
    expect(state.origin).toEqual({
      url: "https://toolshed.test/api/patterns/system/home.tsx",
      kind: "system",
      recorded: "system:system/home.tsx",
    });
    // Entry file first, then the rest by name.
    expect(state.files.map((file) => file.name)).toEqual([
      "/main.tsx",
      "/aaa.tsx",
      "/helper.tsx",
    ]);
  });

  it("drops a displaced-pattern record with no timestamp", async () => {
    const { piece, runtime } = pieceWith({
      meta: {
        patternIdentity: { identity: "abc", symbol: "default" },
        displacedPattern: { identity: "displaced", symbol: "default" },
      },
    });
    const state = await readPieceSourceState(runtime, piece);
    expect(state.displacedPattern).toEqual({
      identity: "displaced",
      symbol: "default",
    });
  });

  it("ignores metadata that is not a pattern reference", async () => {
    const { piece, runtime } = pieceWith({
      meta: {
        patternIdentity: { identity: "abc", symbol: "default" },
        patternSetupIdentity: { nonsense: true },
        displacedPattern: "not a record",
        patternRepository: 42,
      },
    });
    const state = await readPieceSourceState(runtime, piece);
    expect(state.setupPattern).toBeUndefined();
    expect(state.displacedPattern).toBeUndefined();
    expect(state.repository).toBeUndefined();
  });

  it("reports no files when the source closure is unreadable", async () => {
    const { piece, runtime } = pieceWith({
      meta: { patternIdentity: { identity: "abc", symbol: "default" } },
    });
    const state = await readPieceSourceState(runtime, piece);
    expect(state.entry).toBeUndefined();
    expect(state.files).toEqual([]);
  });

  it("separates a string nothing can follow from detachment", async () => {
    const { piece, runtime } = pieceWith({
      meta: {
        patternIdentity: { identity: "abc", symbol: "default" },
        patternSource: "not a url",
      },
    });
    const state = await readPieceSourceState(runtime, piece);
    expect(state.origin).toBeUndefined();
    expect(state.unusableOrigin).toEqual({
      recorded: "not a url",
      reason: "not a url is not an absolute URL",
    });

    const detached = pieceWith({
      meta: { patternIdentity: { identity: "abc", symbol: "default" } },
    });
    const detachedState = await readPieceSourceState(
      detached.runtime,
      detached.piece,
    );
    expect(detachedState.origin).toBeUndefined();
    expect(detachedState.unusableOrigin).toBeUndefined();
  });

  it("reports what following the origin last did", async () => {
    const { piece, runtime } = pieceWith({
      meta: {
        patternIdentity: { identity: "abc", symbol: "default" },
        patternSource: "https://example.test/recipe.tsx",
        pieceReconciliation: {
          outcome: "refused",
          at: 1_700_000_000_000,
          origin: "https://example.test/recipe.tsx",
          offered: { identity: "candidate", symbol: "default" },
          reason: "incompatible-schema",
          detail: "the contracts differ",
        },
      },
    });
    const state = await readPieceSourceState(runtime, piece);
    expect(state.reconciliation).toEqual({
      outcome: "refused",
      at: 1_700_000_000_000,
      origin: "https://example.test/recipe.tsx",
      offered: { identity: "candidate", symbol: "default" },
      reason: "incompatible-schema",
      detail: "the contracts differ",
    });
  });

  it("says nothing about a reconciliation record it cannot read", async () => {
    const { piece, runtime } = pieceWith({
      meta: {
        patternIdentity: { identity: "abc", symbol: "default" },
        patternSource: "system:system/home.tsx",
        pieceReconciliation: { outcome: "invented", at: "recently" },
      },
    });
    const state = await readPieceSourceState(runtime, piece);
    expect(state.reconciliation).toBeUndefined();
    // The rest of the piece's source facts still read.
    expect(state.origin?.url).toBe(
      "https://toolshed.test/api/patterns/system/home.tsx",
    );
  });
});

describe("reading a piece's source state", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let controller: PiecesController;
  let restoreFetch: () => void;

  beforeEach(async () => {
    restoreFetch = installFetchStub({
      [DEFAULT_APP_PATTERN_PATH]: DEFAULT_APP_SOURCE,
    });
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    controller = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `source-state-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await controller.synced();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager?.close();
    restoreFetch();
  });

  async function cloneDestination(label: string): Promise<PiecesController> {
    const destination = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `${label}-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await destination.synced();
    return destination;
  }

  async function setRawMeta(
    cell: Cell<unknown>,
    key: Parameters<Cell<unknown>["setMetaRaw"]>[0],
    value: unknown,
  ): Promise<void> {
    const tx = runtime.edit();
    cell.withTx(tx).setMetaRaw(key, value as never, rawMetaWriteAuthorization);
    runtime.prepareTxForCommit(tx);
    const result = await tx.commit();
    expect(result.error).toBeUndefined();
  }

  it("reports a directly-created piece as detached, with its source", async () => {
    const piece = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
    });

    const state = await readPieceSourceState(runtime, piece.getCell());
    // A piece pushed from local code records no origin: it is the only durable
    // reference to the source it runs.
    expect(state.origin).toBeUndefined();
    expect(state.name).toBe("Counter");
    expect(state.pattern?.symbol).toBe("default");
    expect(state.entry).toBe("/main.tsx");
    expect(state.files.map((file) => file.name)).toEqual(["/main.tsx"]);
    expect(state.space).toBe(controller.getSpace());
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toMatchObject({
      operation: "create",
      pattern: state.pattern,
    });
  });

  it("reports a space root's stamped ref as the route it addresses", async () => {
    const root = await controller.ensureDefaultPattern();

    const state = await readPieceSourceState(runtime, root.getCell());
    // The root is stamped with a `system:` ref; the origin that comes back is
    // the absolute route it resolves to, with the ref kept alongside it.
    expect(state.origin).toEqual({
      url: `http://toolshed.test${DEFAULT_APP_PATTERN_PATH}`,
      kind: "system",
      recorded: DEFAULT_APP_PATTERN_SOURCE,
    });
    expect(state.files.length).toBeGreaterThan(0);
    expect(state.files[0].name).toBe(state.entry);
  });

  it("keeps the recorded form on the active source revision", async () => {
    const piece = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
    });
    const cell = piece.getCell();
    const pattern = getPatternIdentityRef(cell)!;
    const expected = getPieceSourceSnapshot(cell)!;
    const baseline = await preparePieceSourceTransitionBaseline(
      runtime,
      cell,
      expected,
    );
    const tx = runtime.edit();
    applyPieceSourceTransition(runtime, cell, tx, pattern, {
      revisionId: "active-relative-origin",
      baseline,
      timestamp: 42,
      operation: "origin-update",
      origin: DEFAULT_APP_PATTERN_PATH,
      expected,
    });
    runtime.prepareTxForCommit(tx);
    await tx.commit();

    const state = await readPieceSourceState(runtime, cell);
    expect(state.origin).toEqual({
      url: `http://toolshed.test${DEFAULT_APP_PATTERN_PATH}`,
      kind: "system",
      recorded: DEFAULT_APP_PATTERN_PATH,
    });
    expect(state.history.at(-1)?.origin).toEqual(state.origin);
  });

  it("keeps an unclassifiable historical origin out of the source view", async () => {
    const piece = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
    });
    const cell = piece.getCell();
    const revision = getPieceSourceRevisions(cell)[0];
    const tx = runtime.edit();
    cell.withTx(tx).setMetaRaw("pieceSourceHistory", [{
      ...revision,
      origin: "not an origin",
    }] as never, rawMetaWriteAuthorization);
    await tx.commit();

    const state = await readPieceSourceState(runtime, cell);
    expect(state.history).toHaveLength(1);
    expect(state.history[0].origin).toBeUndefined();
  });

  it("clones into another space and follows the selected piece", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
    }, { input: { label: "before" } });
    const destination = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `source-clone-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await destination.synced();

    const clone = await source.cloneTo(destination);
    const sourceState = await readPieceSourceState(runtime, source.getCell());
    const cloneState = await readPieceSourceState(runtime, clone.getCell());

    expect(cloneState.space).toBe(destination.getSpace());
    expect(cloneState.pattern).toEqual(sourceState.pattern);
    expect(cloneState.origin).toEqual({
      url:
        `cf:/${controller.getSpace()}/${source.getCell().getAsNormalizedFullLink().id}`,
      kind: "fabric-piece",
    });

    const resolved = await resolvePieceOriginSource(
      runtime,
      destination.getSpace(),
      cloneState.origin!.url,
      cloneState.pattern!.symbol,
    );
    expect(resolved.pattern).toEqual(sourceState.pattern);
  });

  it("copies a snapshot of the selected piece's input data when requested", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
    }, { input: { label: "copied label" } });
    const destination = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `source-clone-data-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await destination.synced();

    await source.result.set(7, ["count"]);

    const startPiece = destination.startPiece.bind(destination);
    let countWhenStarted: unknown;
    destination.startPiece = async (
      piece: Parameters<typeof startPiece>[0],
    ) => {
      if (typeof piece === "string") throw new Error("expected clone cell");
      countWhenStarted = destination.getResult(piece).key("count").get();
      await startPiece(piece);
    };

    const clone = await source.cloneTo(destination, { copyData: true });

    expect(countWhenStarted).toBe(7);
    expect(await clone.input.get()).toEqual({ label: "copied label" });
    expect(await clone.result.get(["count"])).toBe(7);
    await source.input.set({ label: "changed later" });
    await source.result.set(9, ["count"]);
    expect(await clone.input.get()).toEqual({ label: "copied label" });
    expect(await clone.result.get(["count"])).toBe(7);
  });

  it("rejects a data snapshot that changes before validation", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
    }, { input: { label: "before" } });
    const destination = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `source-clone-conflict-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await destination.synced();

    const edit = runtime.edit.bind(runtime);
    let injectedChange = false;
    runtime.edit = () => {
      const tx = edit();
      const commit = tx.commit.bind(tx);
      tx.commit = async (options) => {
        const validatesSnapshot = tx.getCommitPreconditions?.(
          controller.getSpace(),
        )?.some((precondition) => precondition.kind === "entity-value-hash") ??
          false;
        if (validatesSnapshot && !injectedChange) {
          injectedChange = true;
          runtime.edit = edit;
          await source.input.set({ label: "changed during clone" });
        }
        return await commit(options);
      };
      return tx;
    };

    let rejected = false;
    try {
      await source.cloneTo(destination, { copyData: true });
    } catch {
      rejected = true;
    } finally {
      runtime.edit = edit;
    }

    expect(injectedChange).toBe(true);
    expect(rejected).toBe(true);
  });

  it("cleans up a fresh clone whose start fails", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
    });
    const destination = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `source-clone-start-failure-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await destination.synced();

    const remove = destination.remove.bind(destination);
    let cleanedUp = false;
    destination.startPiece = () => Promise.reject(new Error("start failed"));
    destination.remove = async (piece) => {
      cleanedUp = true;
      return await remove(piece);
    };

    await expect(source.cloneTo(destination)).rejects.toThrow("start failed");
    expect(cleanedUp).toBe(true);
  });

  it("rejects a piece whose pattern identity is missing", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
    });
    const destination = await cloneDestination("source-clone-no-pattern");
    await setRawMeta(source.getCell(), "patternIdentity", undefined);

    await expect(source.cloneTo(destination)).rejects.toThrow(
      "piece missing pattern identity",
    );
  });

  it("rejects a detached piece whose cell id is not a fabric URI", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
    });
    const destination = await cloneDestination("source-clone-no-uri");
    const cell = patchableCell(source.getCell());
    const originalLink = cell.getAsNormalizedFullLink.bind(cell);

    try {
      cell.getAsNormalizedFullLink = (() => ({
        ...originalLink(),
        id: "not-a-fabric-uri",
      })) as unknown as typeof cell.getAsNormalizedFullLink;
      await expect(new PieceController(controller, cell).cloneTo(destination))
        .rejects.toThrow(
          "piece has no fabric URI",
        );
    } finally {
      cell.getAsNormalizedFullLink = originalLink;
    }
  });

  it("rejects a piece whose source program is unavailable", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
    });
    const destination = await cloneDestination("source-clone-no-source");
    const manager = runtime.patternManager;
    const original = manager.getPatternSourceProgramByIdentity.bind(manager);

    try {
      manager.getPatternSourceProgramByIdentity = (() =>
        Promise.resolve(undefined)) as typeof original;
      await expect(source.cloneTo(destination)).rejects.toThrow(
        "piece source is not available",
      );
    } finally {
      manager.getPatternSourceProgramByIdentity = original;
    }
  });

  it("rejects malformed internal data metadata", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
    }, { input: { label: "before" } });
    const destination = await cloneDestination("source-clone-bad-internal");

    await setRawMeta(source.getCell(), "internal", "not a manifest");
    await expect(source.cloneTo(destination, { copyData: true })).rejects
      .toThrow("piece has invalid internal data metadata");

    await setRawMeta(source.getCell(), "internal", [null]);
    await expect(source.cloneTo(destination, { copyData: true })).rejects
      .toThrow("piece has invalid internal data metadata");
  });

  it("copies nested arrays when a piece has no stateful internals", async () => {
    const input = { value: [1, { nested: [2, 3] }] };
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: ARRAY_INPUT_SOURCE }],
    }, { input });
    const destination = await cloneDestination("source-clone-array-input");

    const clone = await source.cloneTo(destination, { copyData: true });

    expect(await clone.input.get()).toEqual({
      value: [1, { nested: [2, 3] }],
    });
  });

  it("rejects cells that appeared after clone data was preloaded", () => {
    const cell = patchableCell(runtime.getImmutableCell(
      controller.getSpace(),
      { value: 1 },
    ));

    const get = cell.get.bind(cell);
    let read = false;
    try {
      cell.get = (() => {
        read = true;
        return get();
      }) as typeof cell.get;
      expect(() =>
        snapshotCloneValue(
          cell,
          undefined,
          new WeakMap(),
          new Map(),
          new Set(),
        )
      ).toThrow("piece data changed while it was being cloned");
      expect(read).toBe(false);
    } finally {
      cell.get = get;
    }
    expect(() =>
      snapshotCloneValue(
        cell.get(),
        cell,
        new WeakMap(),
        new Map(),
        new Set(),
      )
    ).toThrow("piece data changed while it was being cloned");
  });

  it("snapshots cycles and rejects unsupported materialized values", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const snapshot = snapshotCloneValue(cycle) as { self: unknown };
    expect(snapshot.self).toBe(snapshot);

    expect(() => snapshotCloneValue(new Date(0))).toThrow(
      "piece data containing unsupported object values cannot be copied",
    );

    const cell = patchableCell(
      runtime.getImmutableCell(controller.getSpace(), "safe"),
    );
    const getRawUntyped = cell.getRawUntyped.bind(cell);
    try {
      cell.getRawUntyped = (() =>
        new CloneTestInstance()) as typeof cell.getRawUntyped;
      expect(() => snapshotCloneValue("safe", cell)).toThrow(
        "piece data containing FabricInstance values cannot be copied",
      );
    } finally {
      cell.getRawUntyped = getRawUntyped;
    }
  });

  it("preloads each entity once and rejects stream inputs", async () => {
    const cell = runtime.getImmutableCell(
      controller.getSpace(),
      { first: 1, second: 2 },
    );
    const first = patchableCell(cell.key("first"));
    const second = patchableCell(cell.key("second"));
    const cells = new Map<string, Cell<unknown>>();
    const firstPull = first.pull.bind(first);
    const secondPull = second.pull.bind(second);
    let pulls = 0;
    first.pull = (async () => {
      pulls++;
      return await firstPull();
    }) as typeof first.pull;
    second.pull = (async () => {
      pulls++;
      return await secondPull();
    }) as typeof first.pull;
    try {
      await preloadCloneValue(
        [first, second, first],
        undefined,
        cells,
      );
    } finally {
      first.pull = firstPull;
      second.pull = secondPull;
    }
    expect(pulls).toBe(1);
    expect(cells.size).toBe(2);

    const stream = runtime.getImmutableCell(
      controller.getSpace(),
      { $stream: true },
    );
    await expect(preloadCloneValue(stream, undefined, new Map())).rejects
      .toThrow("piece input containing streams cannot be copied");
  });

  it("recreates computed values and streams instead of copying them", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: DERIVED_AND_STREAM_SOURCE }],
    }, { input: { value: 4 } });
    const destination = await cloneDestination("source-clone-derived-stream");
    const create = destination.create.bind(destination);
    const startPiece = destination.startPiece.bind(destination);
    const getCellFromLink = runtime.getCellFromLink.bind(runtime);
    const linkKey = (cell: Cell<unknown>) =>
      JSON.stringify(cell.getAsNormalizedFullLink());
    const sourceManifest = source.getCell().getMetaRaw("internal") as {
      kind?: unknown;
      link: unknown;
    }[];
    const sourceComputed = sourceManifest.find((entry) =>
      entry.kind === "computed"
    );
    expect(sourceComputed).toBeDefined();
    const sourceComputedKey = linkKey(getCellFromLink(
      parseLinkOrThrow(sourceComputed!.link, source.getCell()),
    ));
    let destinationComputedKey: string | undefined;
    let sourceAccessesBeforeStart: number | undefined;
    let destinationAccessesBeforeStart: number | undefined;
    let sourceAccesses = 0;
    let destinationAccesses = 0;
    runtime.getCellFromLink = ((
      ...linkArgs: Parameters<typeof getCellFromLink>
    ) => {
      const cell = getCellFromLink(...linkArgs);
      const key = linkKey(cell);
      if (key === sourceComputedKey) sourceAccesses++;
      if (key === destinationComputedKey) destinationAccesses++;
      return cell;
    }) as typeof runtime.getCellFromLink;
    destination.create = (async (...args) => {
      const clone = await create(...args);
      const manifest = clone.getCell().getMetaRaw("internal") as {
        kind?: unknown;
        link: unknown;
      }[];
      const computed = manifest.find((entry) => entry.kind === "computed");
      expect(computed).toBeDefined();
      destinationComputedKey = linkKey(getCellFromLink(
        parseLinkOrThrow(computed!.link, clone.getCell()),
      ));
      return clone;
    }) as typeof destination.create;
    destination.startPiece = async (...args) => {
      sourceAccessesBeforeStart = sourceAccesses;
      destinationAccessesBeforeStart = destinationAccesses;
      runtime.getCellFromLink = getCellFromLink;
      return await startPiece(...args);
    };

    let clone: Awaited<ReturnType<typeof source.cloneTo>>;
    try {
      clone = await source.cloneTo(destination, { copyData: true });
    } finally {
      runtime.getCellFromLink = getCellFromLink;
    }

    expect(sourceAccessesBeforeStart).toBe(0);
    expect(destinationAccessesBeforeStart).toBe(0);
    expect(await clone.input.get()).toEqual({ value: 4 });
    expect(await clone.result.get(["doubled"])).toBe(8);
    await clone.input.set({ value: 6 });
    await runtime.idle();
    expect(await clone.result.get(["doubled"])).toBe(12);
    (await clone.result.getCell()).key("increment").send(undefined);
    await runtime.idle();
    expect(await clone.result.get(["count"])).toBe(1);
    expect(await source.result.get(["count"])).toBe(0);
  });

  it("rejects a source change visible to the snapshot transaction", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
    }, { input: { label: "before" } });
    const destination = await cloneDestination("source-clone-tx-source-change");
    const cell = patchableCell(source.getCell());
    const withTx = cell.withTx.bind(cell);

    try {
      cell.withTx = ((tx) => {
        const txCell = patchableCell(withTx(tx));
        const getMetaRaw = txCell.getMetaRaw.bind(txCell);
        txCell.getMetaRaw = ((key) =>
          key === "patternIdentity"
            ? undefined
            : getMetaRaw(key)) as typeof txCell.getMetaRaw;
        return txCell;
      }) as typeof cell.withTx;
      await expect(
        new PieceController(controller, cell).cloneTo(destination, {
          copyData: true,
        }),
      ).rejects.toThrow("piece source changed while it was being cloned");
    } finally {
      cell.withTx = withTx;
    }
  });

  it("rejects an internal manifest changed during snapshotting", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
    }, { input: { label: "before" } });
    const destination = await cloneDestination("source-clone-manifest-change");
    const cell = patchableCell(source.getCell());
    const withTx = cell.withTx.bind(cell);

    try {
      cell.withTx = ((tx) => {
        const txCell = patchableCell(withTx(tx));
        const getMetaRaw = txCell.getMetaRaw.bind(txCell);
        txCell.getMetaRaw = ((key) =>
          key === "internal"
            ? []
            : getMetaRaw(key)) as typeof txCell.getMetaRaw;
        return txCell;
      }) as typeof cell.withTx;
      await expect(
        new PieceController(controller, cell).cloneTo(destination, {
          copyData: true,
        }),
      ).rejects.toThrow("piece data changed while it was being cloned");
    } finally {
      cell.withTx = withTx;
    }
  });

  it("surfaces a snapshot transaction rejection reason", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
    }, { input: { label: "before" } });
    const destination = await cloneDestination("source-clone-snapshot-reject");
    const edit = runtime.edit.bind(runtime);
    let rejectNextCommit = true;

    try {
      runtime.edit = () => {
        const tx = edit();
        const commit = tx.commit.bind(tx);
        tx.commit = (options) => {
          const validatesSnapshot = tx.getCommitPreconditions?.(
            controller.getSpace(),
          )?.some((precondition) =>
            precondition.kind === "entity-value-hash"
          ) ?? false;
          if (!rejectNextCommit || !validatesSnapshot) return commit(options);
          rejectNextCommit = false;
          return Promise.resolve({
            error: {
              name: "StorageTransactionAborted" as const,
              message: "snapshot rejected",
              reason: new Error("snapshot commit rejected"),
            },
          });
        };
        return tx;
      };
      await expect(source.cloneTo(destination, { copyData: true })).rejects
        .toThrow("snapshot commit rejected");
      expect(rejectNextCommit).toBe(false);
    } finally {
      runtime.edit = edit;
    }
  });

  it("rejects a destination missing a copied internal cell", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
    }, { input: { label: "before" } });
    await source.result.set(3, ["count"]);
    const destination = await cloneDestination("source-clone-missing-internal");
    const create = destination.create.bind(destination);
    destination.create = (async (...args) => {
      const clone = await create(...args);
      await setRawMeta(clone.getCell(), "internal", []);
      return clone;
    }) as typeof destination.create;

    await expect(source.cloneTo(destination, { copyData: true })).rejects
      .toThrow("cloned piece is missing a source data cell");
  });

  it("surfaces destination restore transaction failures", async () => {
    const failures = [
      {
        error: {
          name: "StorageTransactionAborted" as const,
          message: "restore rejected",
          reason: new Error("restore commit rejected"),
        },
        expected: "restore commit rejected",
      },
      {
        error: new Error("restore storage failed"),
        expected: "restore storage failed",
      },
    ];

    for (const [index, failure] of failures.entries()) {
      const source = await controller.create({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
      }, { input: { label: "before" } });
      await source.result.set(index + 1, ["count"]);
      const destination = await cloneDestination(
        `source-clone-restore-reject-${index}`,
      );
      const create = destination.create.bind(destination);
      const edit = runtime.edit.bind(runtime);
      let rejectRestore = false;
      destination.create = (async (...args) => {
        const clone = await create(...args);
        rejectRestore = true;
        return clone;
      }) as typeof destination.create;
      runtime.edit = () => {
        const tx = edit();
        if (rejectRestore) {
          rejectRestore = false;
          tx.commit = (() =>
            Promise.resolve({ error: failure.error })) as typeof tx.commit;
        }
        return tx;
      };

      try {
        await expect(source.cloneTo(destination, { copyData: true })).rejects
          .toThrow(failure.expected);
      } finally {
        runtime.edit = edit;
      }
    }
  });

  it("reports cleanup failures without hiding the clone failure", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
    });
    const destination = await cloneDestination("source-clone-cleanup-errors");
    destination.startPiece = () => Promise.reject(new Error("start failed"));
    destination.stopPiece = () => Promise.reject(new Error("stop failed"));
    destination.remove = () => Promise.reject(new Error("remove failed"));

    let failure: unknown;
    try {
      await source.cloneTo(destination);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map(String)).toEqual([
      "Error: start failed",
      "Error: stop failed",
      "Error: remove failed",
    ]);
  });

  it("reports a clone that cleanup leaves registered", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
    });
    const destination = await cloneDestination("source-clone-still-registered");
    const create = destination.create.bind(destination);
    let created: Awaited<ReturnType<typeof create>> | undefined;
    destination.create = (async (...args) => {
      created = await create(...args);
      return created;
    }) as typeof destination.create;
    destination.startPiece = () => Promise.reject(new Error("start failed"));
    destination.remove = () => Promise.resolve(false);
    destination.getRegisteredPieces = () => Promise.resolve([created!]);

    let failure: unknown;
    try {
      await source.cloneTo(destination);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map(String)).toEqual([
      "Error: start failed",
      "Error: the incomplete piece remained registered",
    ]);
  });

  it("rejects data copying when the snapshot carries CFC labels", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: CONFIDENTIAL_SOURCE }],
    }, { input: { secret: "classified" } });
    const destination = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `source-clone-labeled-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await destination.synced();

    await expect(source.cloneTo(destination, { copyData: true })).rejects
      .toThrow(
        "piece data with confidentiality or integrity labels cannot be copied",
      );
  });

  it("rejects labels reached through nested input links", async () => {
    const secret = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: CONFIDENTIAL_WRITABLE_SOURCE }],
    });
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: LINK_INPUT_SOURCE }],
    }, {
      input: { nested: { secret: secret.getCell().key("secret") } },
    });
    const destination = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `source-clone-linked-label-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await destination.synced();

    await expect(source.cloneTo(destination, { copyData: true })).rejects
      .toThrow(
        "piece data with confidentiality or integrity labels cannot be copied",
      );
  });

  it("rejects data linked from another space", async () => {
    const external = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `source-clone-external-data-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await external.synced();
    const linked = await external.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: WRITABLE_SOURCE }],
    });
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: LINK_INPUT_SOURCE }],
    }, {
      input: { nested: { secret: linked.getCell().key("value") } },
    });
    const destination = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `source-clone-external-destination-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await destination.synced();

    await expect(source.cloneTo(destination, { copyData: true })).rejects
      .toThrow(
        "piece data linked from another space cannot be copied consistently",
      );
  });

  it("rejects FabricInstance values instead of flattening them", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: UNKNOWN_INPUT_SOURCE }],
    }, { input: { value: new Error("not cloneable") } });
    const destination = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `source-clone-instance-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await destination.synced();

    await expect(source.cloneTo(destination, { copyData: true })).rejects
      .toThrow("piece data containing FabricInstance values cannot be copied");
  });

  it("passes an existing upstream origin through to a clone", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
    }, { origin: "system:system/home.tsx" });
    const destination = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `source-clone-origin-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await destination.synced();

    const clone = await source.cloneTo(destination);
    const state = await readPieceSourceState(runtime, clone.getCell());

    expect(state.origin).toMatchObject({
      kind: "system",
      recorded: "system:system/home.tsx",
    });
  });

  it("qualifies a relative fabric origin before copying it to another space", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
    }, { origin: `cf:of:fid1:${HASH}` });
    const destination = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `source-clone-relative-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await destination.synced();

    const clone = await source.cloneTo(destination);
    const state = await readPieceSourceState(runtime, clone.getCell());

    expect(state.origin?.url).toBe(
      `cf:/${controller.getSpace()}/of:fid1:${HASH}`,
    );
  });

  it("rejects a clone when the selected piece changes during source loading", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
    });
    const destination = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `source-clone-race-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await destination.synced();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const manager = runtime.patternManager;
    const original = manager.getPatternSourceProgramByIdentity.bind(manager);
    manager.getPatternSourceProgramByIdentity = (async (...args) => {
      entered.resolve();
      await release.promise;
      return await original(...args);
    }) as typeof manager.getPatternSourceProgramByIdentity;

    try {
      const cloning = source.cloneTo(destination);
      await entered.promise;
      const tx = runtime.edit();
      source.getCell().withTx(tx).setMetaRaw(
        "patternSource",
        "https://example.test/changed.tsx",
        rawMetaWriteAuthorization,
      );
      runtime.prepareTxForCommit(tx);
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
      release.resolve();
      await expect(cloning).rejects.toThrow(
        "piece source changed while it was being cloned",
      );
    } finally {
      release.resolve();
      manager.getPatternSourceProgramByIdentity = original;
    }
  });

  it("updates a running clone when the selected piece changes source", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: FOLLOW_SOURCE }],
    });
    const destination = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `source-clone-update-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await destination.synced();
    const clone = await source.cloneTo(destination);
    await runtime.sourceReconciler.idle();
    const updatedSource = FOLLOW_SOURCE.replace("1 + 0", "2 + 0");

    await source.setPattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: updatedSource }],
    });
    await runtime.idle();
    await runtime.sourceReconciler.idle();
    await runtime.idle();

    const sourceState = await readPieceSourceState(runtime, source.getCell());
    const cloneState = await readPieceSourceState(runtime, clone.getCell());
    expect(cloneState.pattern).toEqual(sourceState.pattern);
    expect(cloneState.history.at(-1)?.operation).toBe("origin-update");
  });

  it("converges on the newest source change while an update is loading", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: FOLLOW_SOURCE }],
    });
    const destination = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `source-clone-coalesce-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await destination.synced();
    const clone = await source.cloneTo(destination);
    await runtime.sourceReconciler.idle();

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const manager = runtime.patternManager;
    const original = manager.getPatternSourceProgramByIdentity.bind(manager);
    let held = false;
    manager.getPatternSourceProgramByIdentity = (async (...args) => {
      if (args[2] === destination.getSpace() && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return await original(...args);
    }) as typeof manager.getPatternSourceProgramByIdentity;

    try {
      await source.setPattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: FOLLOW_SOURCE.replace("1 + 0", "2 + 0"),
        }],
      });
      await entered.promise;
      await source.setPattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: FOLLOW_SOURCE.replace("1 + 0", "3 + 0"),
        }],
      });
      release.resolve();
      await runtime.sourceReconciler.idle();
      await runtime.idle();
      await runtime.sourceReconciler.idle();

      expect(getPatternIdentityRef(clone.getCell())).toEqual(
        getPatternIdentityRef(source.getCell()),
      );
    } finally {
      release.resolve();
      manager.getPatternSourceProgramByIdentity = original;
    }
  });

  it("detects an upstream change made before its source sink is installed", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: FOLLOW_SOURCE }],
    });
    const destination = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `source-clone-subscribe-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await destination.synced();

    const sourceCell = patchableCell(source.getCell());
    const sourceLink = sourceCell.getAsNormalizedFullLink();
    const runtimeWithMutableLookup = runtime as Runtime & {
      getCellFromEntityId: Runtime["getCellFromEntityId"];
    };
    const originalLookup = runtime.getCellFromEntityId.bind(runtime);
    runtimeWithMutableLookup.getCellFromEntityId = ((
      space: Parameters<Runtime["getCellFromEntityId"]>[0],
      id: Parameters<Runtime["getCellFromEntityId"]>[1],
    ) =>
      space === sourceLink.space && id === sourceLink.id
        ? sourceCell
        : originalLookup(space, id)) as Runtime["getCellFromEntityId"];
    const originalSinkMeta = sourceCell.sinkMeta.bind(sourceCell);
    const sinkCaptured = Promise.withResolvers<void>();
    let installCapturedSink: (() => void) | undefined;
    let cancelCapturedSink: (() => void) | undefined;
    sourceCell.sinkMeta = ((field, callback, options) => {
      if (field === "patternIdentity" && installCapturedSink === undefined) {
        installCapturedSink = () => {
          cancelCapturedSink = originalSinkMeta(field, callback, options);
        };
        sinkCaptured.resolve();
        return () => cancelCapturedSink?.();
      }
      return originalSinkMeta(field, callback, options);
    }) as typeof sourceCell.sinkMeta;

    try {
      const clone = await source.cloneTo(destination);
      await sinkCaptured.promise;
      await runtime.sourceReconciler.idle();
      await source.setPattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: FOLLOW_SOURCE.replace("1 + 0", "2 + 0"),
        }],
      });
      installCapturedSink!();
      await runtime.idle();
      await runtime.sourceReconciler.idle();
      await runtime.idle();

      expect(getPatternIdentityRef(clone.getCell())).toEqual(
        getPatternIdentityRef(source.getCell()),
      );
    } finally {
      cancelCapturedSink?.();
      sourceCell.sinkMeta = originalSinkMeta;
      runtimeWithMutableLookup.getCellFromEntityId = originalLookup;
    }
  });

  it("stops following upstream changes when the clone stops", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: FOLLOW_SOURCE }],
    });
    const destination = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `source-clone-stop-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await destination.synced();
    const clone = await source.cloneTo(destination);
    await runtime.sourceReconciler.idle();
    const stoppedPattern = getPatternIdentityRef(clone.getCell());

    runtime.runner.stop(clone.getCell());
    await source.setPattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: FOLLOW_SOURCE.replace("1 + 0", "2 + 0"),
      }],
    });
    await runtime.idle();
    await runtime.sourceReconciler.idle();

    expect(getPatternIdentityRef(clone.getCell())).toEqual(stoppedPattern);
  });

  it("cancels a source update already loading when the clone stops", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: FOLLOW_SOURCE }],
    });
    const destination = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `source-clone-stop-load-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await destination.synced();
    const clone = await source.cloneTo(destination);
    await runtime.sourceReconciler.idle();
    const stoppedPattern = getPatternIdentityRef(clone.getCell());

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const manager = runtime.patternManager;
    const original = manager.getPatternSourceProgramByIdentity.bind(manager);
    manager.getPatternSourceProgramByIdentity = (async (...args) => {
      if (args[2] === destination.getSpace()) {
        entered.resolve();
        await release.promise;
      }
      return await original(...args);
    }) as typeof manager.getPatternSourceProgramByIdentity;

    try {
      await source.setPattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: FOLLOW_SOURCE.replace("1 + 0", "2 + 0"),
        }],
      });
      await entered.promise;
      runtime.runner.stop(clone.getCell());
      release.resolve();
      await runtime.sourceReconciler.idle();
      await runtime.idle();

      expect(getPatternIdentityRef(clone.getCell())).toEqual(stoppedPattern);
    } finally {
      release.resolve();
      manager.getPatternSourceProgramByIdentity = original;
    }
  });

  it("re-subscribes when a clone restarts before its old check settles", async () => {
    const source = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: FOLLOW_SOURCE }],
    });
    const destination = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `source-clone-restart-load-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await destination.synced();
    const clone = await source.cloneTo(destination);
    await runtime.sourceReconciler.idle();

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const manager = runtime.patternManager;
    const original = manager.getPatternSourceProgramByIdentity.bind(manager);
    manager.getPatternSourceProgramByIdentity = (async (...args) => {
      if (args[2] === destination.getSpace()) {
        entered.resolve();
        await release.promise;
      }
      return await original(...args);
    }) as typeof manager.getPatternSourceProgramByIdentity;

    try {
      await source.setPattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: FOLLOW_SOURCE.replace("1 + 0", "2 + 0"),
        }],
      });
      await entered.promise;
      runtime.runner.stop(clone.getCell());
      // A stopped piece stops following. Opening it again is what resumes —
      // started here, while the check the stop aborted is still held.
      const reopened = destination.openPiece(clone.getCell());
      release.resolve();
      await reopened;
      await runtime.sourceReconciler.idle();
      await runtime.idle();
      await runtime.sourceReconciler.idle();
      await runtime.idle();

      expect(getPatternIdentityRef(clone.getCell())).toEqual(
        getPatternIdentityRef(source.getCell()),
      );
    } finally {
      release.resolve();
      manager.getPatternSourceProgramByIdentity = original;
    }
  });
});
