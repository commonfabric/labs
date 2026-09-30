import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";

import {
  getPatternIdentityRef,
  getPieceReconciliation,
  getPieceSourceRevisions,
  Runtime,
  type RuntimeFetch,
  type RuntimeProgram,
  setPatternSource,
  systemPatternSource,
} from "../src/index.ts";
import { PatternsRoute } from "../src/harness/patterns-route.deno.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("system source roots");
const MAIN = "/api/patterns/example/main.tsx";
const TEST = "/api/patterns/example/main.test.tsx";
const HELPER = "/api/patterns/example/helper.ts";

function program(marker: string, assertion = "v1"): RuntimeProgram {
  return {
    main: MAIN,
    sourceRoots: [TEST],
    files: [
      {
        name: MAIN,
        contents: `import { computed, pattern } from "commonfabric";
export default pattern<{ value: string }, { value: string; marker: string }>(
  ({ value }) => ({ value, marker: computed(() => "${marker}") }),
);
`,
      },
      {
        name: TEST,
        contents:
          'import "./main.tsx";\nexport { assertion } from "./helper.ts";\n',
      },
      { name: HELPER, contents: `export const assertion = "${assertion}";\n` },
    ],
  };
}

describe("system source reconciliation with attached roots", () => {
  let runtime: Runtime;
  let directory: string;
  let route: PatternsRoute;
  let requests: URL[];
  let hostFetch: RuntimeFetch;

  beforeEach(async () => {
    directory = await Deno.makeTempDir({ prefix: "system-source-roots-" });
    requests = [];
    hostFetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(new URL(request.url));
      return await route.serve(request) ?? new Response(null, { status: 404 });
    };
    runtime = new Runtime({
      apiUrl: new URL("https://toolshed.test"),
      storageManager: StorageManager.emulate({ as: signer }),
      fetch: (input, init) => hostFetch(input, init),
    });
    await serve(program("v1"));
  });

  afterEach(async () => {
    await runtime.sourceReconciler.idle();
    await runtime.patternManager.flushCompileCacheWrites();
    await runtime.dispose();
    await Deno.remove(directory, { recursive: true });
  });

  async function serve(source: RuntimeProgram) {
    for (const file of source.files) {
      const path = join(directory, file.name.slice("/api/patterns/".length));
      await Deno.mkdir(join(path, ".."), { recursive: true });
      await Deno.writeTextFile(path, file.contents);
    }
    // A deployed host's source files are fixed for its process lifetime.
    route = new PatternsRoute(directory);
  }

  async function preparePiece(source = program("v1")) {
    const initial = await runtime.patternManager.compilePattern(source, {
      space: signer.did(),
    });
    const piece = runtime.getCell<{ value: string; marker: string }>(
      signer.did(),
      "piece-with-attached-tests",
    );
    await runtime.setup(
      undefined,
      initial,
      { value: "keep this input" },
      piece,
    );
    const result = await runtime.editWithRetry((tx) => {
      setPatternSource(piece, tx, systemPatternSource("example/main.tsx"));
    });
    expect(result.error).toBeUndefined();
    return piece;
  }

  async function storedProgram(identity: string) {
    return await runtime.patternManager.getPatternSourceProgramByIdentity(
      identity,
      signer.did(),
    );
  }

  it("checks an unchanged entry without reading its stored source program", async () => {
    const source = program("v1");
    const piece = await preparePiece({ main: MAIN, files: [source.files[0]] });
    using sourceReads = spy(
      runtime.patternManager,
      "getPatternSourceProgramByIdentity",
    );

    expect(await runtime.sourceReconciler.reconcile(piece)).toBe("current");
    expect(sourceReads.calls).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.getAll("sourceRoot")).toEqual([]);
  });

  it("identifies noncanonical attached roots before requesting their identities", async () => {
    for (
      const name of [
        "name%20with%20spaces.ts",
        "caf%C3%A9.ts",
        "name:part.ts",
        "name..part.ts",
      ]
    ) {
      const root = `/api/patterns/${name}`;
      const source = program("v1");
      const piece = await preparePiece({
        main: MAIN,
        sourceRoots: [root],
        files: [source.files[0], {
          name: root,
          contents: "export const test = true;\n",
        }],
      });
      const original = getPatternIdentityRef(piece)!;
      requests.length = 0;

      expect(await runtime.sourceReconciler.reconcile(piece)).toBe(
        "unavailable",
      );
      expect(getPatternIdentityRef(piece)).toEqual(original);
      expect(getPieceReconciliation(piece)?.detail).toContain(
        "not a canonical patterns route path",
      );
      expect(
        requests.every((request) => !request.searchParams.has("sourceRoot")),
      ).toBe(true);
    }
  });

  it("keeps the complete source unchanged on first open against the same host version", async () => {
    const piece = await preparePiece();
    const original = getPatternIdentityRef(piece)!;

    expect(await runtime.sourceReconciler.reconcile(piece)).toBe("current");
    expect(getPatternIdentityRef(piece)).toEqual(original);
    expect((await storedProgram(original.identity))?.sourceRoots).toEqual([
      TEST,
    ]);
    expect(getPieceSourceRevisions(piece)).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests[0].searchParams.getAll("sourceRoot")).toEqual([]);
    expect(requests[1].searchParams.getAll("sourceRoot")).toEqual([
      "example/main.test.tsx",
    ]);
  });

  it("updates the host's entry and retains the attached closure and piece input", async () => {
    const piece = await preparePiece();
    const original = getPatternIdentityRef(piece)!;
    await serve(program("v2", "v2"));

    expect(await runtime.sourceReconciler.reconcile(piece)).toBe("updated");
    const updated = getPatternIdentityRef(piece)!;
    expect(updated.identity).not.toBe(original.identity);
    const stored = await storedProgram(updated.identity);
    expect(stored?.sourceRoots).toEqual([TEST]);
    expect(stored?.files).toEqual(
      expect.arrayContaining(program("v2", "v2").files),
    );
    expect(await runtime.start(piece)).toBe(true);
    await runtime.idle();
    expect(await piece.pull()).toEqual({
      value: "keep this input",
      marker: "v2",
    });
    expect(await runtime.sourceReconciler.reconcile(piece)).toBe("current");
  });

  it("adopts a change confined to an attached root's import closure", async () => {
    const piece = await preparePiece();
    const original = getPatternIdentityRef(piece)!;
    await serve(program("v1", "v2"));

    expect(await runtime.sourceReconciler.reconcile(piece)).toBe("updated");
    const updated = getPatternIdentityRef(piece)!;
    expect(updated.identity).not.toBe(original.identity);
    expect((await storedProgram(updated.identity))?.files).toEqual(
      expect.arrayContaining(program("v1", "v2").files),
    );
  });

  it("keeps its stored source when the host cannot serve an attached root", async () => {
    const piece = await preparePiece();
    const original = getPatternIdentityRef(piece)!;
    await Deno.remove(join(directory, "example/main.test.tsx"));

    expect(await runtime.sourceReconciler.reconcile(piece)).toBe("unavailable");
    expect(getPatternIdentityRef(piece)).toEqual(original);
    expect(getPieceSourceRevisions(piece)).toEqual([]);
  });

  it("keeps its stored source when an older host advertises only the entry", async () => {
    const piece = await preparePiece();
    const original = getPatternIdentityRef(piece)!;
    const serving = hostFetch;
    hostFetch = (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      url.searchParams.delete("sourceRoot");
      return serving(new Request(url, request));
    };

    expect(await runtime.sourceReconciler.reconcile(piece)).toBe("unavailable");
    expect(getPatternIdentityRef(piece)).toEqual(original);
    expect(getPieceSourceRevisions(piece)).toEqual([]);
  });

  it("refuses attached source that changes after its identity was advertised", async () => {
    const piece = await preparePiece();
    const original = getPatternIdentityRef(piece)!;
    await serve(program("v2", "v2"));
    const serving = hostFetch;
    hostFetch = async (input, init) => {
      const request = new Request(input, init);
      const response = await serving(request);
      if (new URL(request.url).searchParams.has("sourceRoot")) {
        await serve(program("v2", "v3"));
      }
      return response;
    };

    expect(await runtime.sourceReconciler.reconcile(piece)).toBe("unavailable");
    expect(getPatternIdentityRef(piece)).toEqual(original);
    expect(getPieceSourceRevisions(piece)).toEqual([]);
  });

  it("keeps an attached root outside the host's patterns route without fetching it", async () => {
    const source = program("v1");
    const localRoot = "/local.test.tsx";
    const piece = await preparePiece({
      ...source,
      sourceRoots: [localRoot],
      files: [
        source.files[0],
        { name: localRoot, contents: "export const test = true;\n" },
      ],
    });
    const original = getPatternIdentityRef(piece)!;

    expect(await runtime.sourceReconciler.reconcile(piece)).toBe("unavailable");
    expect(getPatternIdentityRef(piece)).toEqual(original);
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.getAll("sourceRoot")).toEqual([]);
  });
});
