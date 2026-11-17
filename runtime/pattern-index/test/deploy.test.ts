import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  compileAndSavePattern,
  computeEntryIdentity,
  ensureCompilerStack,
  Runtime,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  PatternIndexClient,
  PatternIndexError,
  type PatternIndexPattern,
} from "@commonfabric/pattern-index/client";
import {
  compileIndexedPattern,
  composeProgram,
  IndexedPatternError,
  materializeComposedPatterns,
  MAX_COMPOSED_PATTERNS,
  PatternCompositionError,
  prepareIndexedProgram,
} from "@commonfabric/pattern-index/deploy";

const signer = await Identity.fromPassphrase("pattern-index deploy");

const DOUBLING_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "interface Input { n: number; }",
  "interface Output { doubled: number; }",
  "export default pattern<Input, Output>(({ n }) => ({",
  "  doubled: computed(() => n * 2),",
  "}));",
  "",
].join("\n");

/** Source whose compile fails on a line quoting a marker the caller never wrote. */
const BROKEN_SOURCE = "const SECRET_MARKER: number = 'not a number';\n";

/** A pattern record as `getPattern` answers it, carrying `source` as its entry. */
const recordFor = (
  patternId: string,
  source: string,
  dependencies: readonly string[] = [],
): PatternIndexPattern => ({
  patternId,
  ownerDid: signer.did(),
  createdAt: "2026-11-14T00:00:00.000Z",
  description: "doubles n",
  dependencies: [...dependencies],
  program: {
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: source }],
  },
} as unknown as PatternIndexPattern);

/** A client factory whose `getPattern` answers through `answer`. */
const clientAnswering = (
  answer: (patternId: string) => Promise<PatternIndexPattern>,
) =>
() =>
  Promise.resolve(
    {
      getPattern: ({ patternId }: { patternId: string }) => answer(patternId),
    } as unknown as PatternIndexClient,
  );

describe("deploy", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      // A composed import resolves from the content-addressed source cache,
      // which only a CFC-enforcing runtime writes.
      cfcEnforcementMode: "enforce-explicit",
    });
    pieces = new PiecesController(
      createSession({
        identity: signer,
        spaceDid: (await Identity.generate()).did(),
      }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const deployOptions = (
    getClient: ReturnType<typeof clientAnswering>,
    patternId = "doubler",
  ) => ({
    runtime,
    space: pieces.getSpace(),
    patternId,
    getClient,
  });

  describe("compileIndexedPattern()", () => {
    it("answers the indexed program and the pattern it compiled to", async () => {
      const { program, pattern } = await compileIndexedPattern(
        deployOptions(
          clientAnswering((id) =>
            Promise.resolve(recordFor(id, DOUBLING_SOURCE))
          ),
        ),
      );

      expect(program.files).toEqual([
        { name: "/main.tsx", contents: DOUBLING_SOURCE },
      ]);
      expect(pattern.argumentSchema).toMatchObject({
        properties: { n: { type: "number" } },
      });
    });

    it("answers the index's display name with the program, when it has one", async () => {
      const named = await compileIndexedPattern(
        deployOptions(
          clientAnswering((id) =>
            Promise.resolve({
              ...recordFor(id, DOUBLING_SOURCE),
              name: "Doubler",
            })
          ),
        ),
      );
      const unnamed = await compileIndexedPattern(
        deployOptions(
          clientAnswering((id) =>
            Promise.resolve(recordFor(id, DOUBLING_SOURCE))
          ),
        ),
      );

      expect(named.name).toBe("Doubler");
      expect(unnamed).not.toHaveProperty("name");
    });

    it("compiles the published patterns the program imports into the space first", async () => {
      await ensureCompilerStack();
      const doublerId = await computeEntryIdentity("/main.tsx", [
        { name: "/main.tsx", contents: DOUBLING_SOURCE },
      ]);
      const composing = [
        "import { pattern } from 'commonfabric';",
        `import doubler from "cf:pattern:${doublerId}";`,
        "interface Input { n: number; }",
        "export default pattern<Input, { half: { doubled: number } }>(",
        "  ({ n }) => ({ half: doubler({ n }) }),",
        ");",
        "",
      ].join("\n");
      const asked: string[] = [];

      const { pattern } = await compileIndexedPattern(
        deployOptions(
          clientAnswering((id) => {
            asked.push(id);
            return Promise.resolve(
              recordFor(id, id === doublerId ? DOUBLING_SOURCE : composing),
            );
          }),
          "composer",
        ),
      );

      expect(asked).toEqual(["composer", doublerId]);
      expect(pattern.argumentSchema).toMatchObject({
        properties: { n: { type: "number" } },
      });
    });

    it("throws a compile-stage error that withholds the diagnostic from its message", async () => {
      const error = await compileIndexedPattern(
        deployOptions(
          clientAnswering((id) =>
            Promise.resolve(recordFor(id, BROKEN_SOURCE))
          ),
        ),
      ).then(() => undefined, (e) => e);

      expect(error).toBeInstanceOf(IndexedPatternError);
      expect(error.stage).toBe("compile");
      expect(error.message).toContain('the indexed pattern "doubler"');
      expect(error.message).not.toContain("SECRET_MARKER");
      expect(error.rawCauseMessage).toContain("SECRET_MARKER");
    });
  });

  describe("prepareIndexedProgram()", () => {
    it("throws a lookup-stage error that keeps the service body out of its message", async () => {
      const error = await prepareIndexedProgram(
        deployOptions(
          clientAnswering(() =>
            Promise.reject(
              new PatternIndexError("getPattern", 500, "SECRET_MARKER body"),
            )
          ),
        ),
      ).then(() => undefined, (e) => e);

      expect(error).toBeInstanceOf(IndexedPatternError);
      expect(error.stage).toBe("lookup");
      expect(error.message).toBe(
        'pattern index lookup failed for "doubler": pattern index getPattern failed (500)',
      );
      expect(error.rawCauseMessage).toBe("SECRET_MARKER body");
    });

    it("throws a lookup-stage error for a record without a program", async () => {
      const error = await prepareIndexedProgram(
        deployOptions(
          clientAnswering((id) =>
            Promise.resolve(
              { ...recordFor(id, DOUBLING_SOURCE), program: undefined },
            )
          ),
        ),
      ).then(() => undefined, (e) => e);

      expect(error).toBeInstanceOf(IndexedPatternError);
      expect(error.stage).toBe("lookup");
      expect(error.message).toBe(
        'the pattern index returned no program for "doubler"',
      );
    });

    it("throws a lookup-stage error naming what the index's program lacks, and quoting none of it", async () => {
      // Through the real client, which refuses the answer before deploy
      // reads it.
      const client = new PatternIndexClient({
        baseUrl: "https://index.test",
        signer,
        fetchFn: () =>
          Promise.resolve(
            new Response(JSON.stringify({
              ...recordFor("doubler", DOUBLING_SOURCE),
              program: { main: "/SECRET_MARKER.tsx" },
            })),
          ),
      });
      const error = await prepareIndexedProgram(
        deployOptions(() => Promise.resolve(client)),
      ).then(() => undefined, (e) => e);

      expect(error).toBeInstanceOf(IndexedPatternError);
      expect(error.stage).toBe("lookup");
      expect(error.message).toBe(
        'pattern index lookup failed for "doubler": pattern index getPattern answer is malformed: program.files is not an array',
      );
      expect(error.rawCauseMessage).toBeUndefined();
    });

    it("throws a compose-stage error for a recorded dependency that cannot be read", async () => {
      const error = await prepareIndexedProgram(
        deployOptions(
          clientAnswering((id) =>
            id === "doubler"
              ? Promise.resolve(recordFor(id, DOUBLING_SOURCE, ["missing"]))
              : Promise.reject(new PatternIndexError("getPattern", 404))
          ),
        ),
      ).then(() => undefined, (e) => e);

      expect(error).toBeInstanceOf(IndexedPatternError);
      expect(error.stage).toBe("compose");
      expect(error.message).toContain('the imported pattern "missing"');
    });
  });

  describe("materializeComposedPatterns()", () => {
    /** Materializes `patternIds`, answering what it threw. */
    const failureOf = (
      patternIds: readonly string[],
      getClient: ReturnType<typeof clientAnswering> | undefined,
      on: Runtime = runtime,
    ) =>
      materializeComposedPatterns({
        runtime: on,
        space: pieces.getSpace(),
        patternIds,
        getClient,
      }).then(() => undefined, (e) => e);

    /** A record composing nothing, whose recorded dependencies are `deps`. */
    const chained = (deps: (id: string) => string[]) =>
      clientAnswering((id) =>
        Promise.resolve(recordFor(id, DOUBLING_SOURCE, deps(id)))
      );

    it("answers nothing, and reads nothing, for a program that composes nothing", async () => {
      expect(
        await materializeComposedPatterns({
          runtime,
          space: pieces.getSpace(),
          patternIds: [],
          getClient: undefined,
        }),
      ).toEqual([]);
    });

    it("throws naming the ids when there is no index to read them from", async () => {
      const error = await failureOf(["a", "b"], undefined);

      expect(error).toBeInstanceOf(PatternCompositionError);
      expect(error.name).toBe("PatternCompositionError");
      expect(error.message).toContain('"a", "b"');
      expect(error.message).toContain("requires a pattern index");
    });

    it("throws for a runtime with CFC enforcement disabled", async () => {
      const disabled = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
        cfcEnforcementMode: "disabled",
      });
      try {
        const error = await failureOf(["a"], chained(() => []), disabled);

        expect(error.message).toContain("requires a CFC-enabled runtime");
      } finally {
        await disabled.dispose();
      }
    });

    it("throws keeping the index's body apart when the client cannot be built", async () => {
      const error = await failureOf(
        ["a"],
        () => Promise.reject(new PatternIndexError("health", 503, "BODY")),
      );

      expect(error.message).toBe(
        "pattern index unavailable: pattern index health failed (503)",
      );
      expect(error.rawCauseMessage).toBe("BODY");
    });

    it("throws naming the cycle when recorded dependencies loop", async () => {
      const error = await failureOf(
        ["a"],
        chained((id) => [id === "a" ? "b" : "a"]),
      );

      expect(error.message).toContain('"a", "b", "a"');
      expect(error.message).toContain("in a cycle");
    });

    it("throws past the cap on how many patterns one program draws in", async () => {
      const error = await failureOf(
        ["p0"],
        chained((id) => [`p${Number(id.slice(1)) + 1}`]),
      );

      expect(error.message).toContain(
        `more than ${MAX_COMPOSED_PATTERNS} published patterns`,
      );
    });

    it("throws when the index answers an import with no program", async () => {
      const error = await failureOf(
        ["a"],
        clientAnswering((id) =>
          Promise.resolve({
            ...recordFor(id, DOUBLING_SOURCE),
            program: undefined,
          })
        ),
      );

      expect(error.message).toBe(
        'the pattern index returned no program for the imported pattern "a"',
      );
    });

    it("throws withholding an import's compile diagnostic", async () => {
      const error = await failureOf(
        ["a"],
        clientAnswering((id) => Promise.resolve(recordFor(id, BROKEN_SOURCE))),
      );

      expect(error.message).toContain(
        'the imported pattern "a" did not compile',
      );
      expect(error.message).not.toContain("SECRET_MARKER");
      expect(error.rawCauseMessage).toContain("SECRET_MARKER");
    });

    it("throws when an import compiles to an identity other than its id", async () => {
      const error = await failureOf(
        ["not-its-identity"],
        clientAnswering((id) =>
          Promise.resolve(recordFor(id, DOUBLING_SOURCE))
        ),
      );

      expect(error.message).toContain(
        'stores the imported pattern under "not-its-identity"',
      );
    });

    it("answers each id once, and nothing for one the space already holds", async () => {
      await ensureCompilerStack();
      const doublerId = await computeEntryIdentity("/main.tsx", [
        { name: "/main.tsx", contents: DOUBLING_SOURCE },
      ]);
      const getClient = chained(() => []);

      const first = await materializeComposedPatterns({
        runtime,
        space: pieces.getSpace(),
        patternIds: [doublerId, doublerId],
        getClient,
      });
      const again = await materializeComposedPatterns({
        runtime,
        space: pieces.getSpace(),
        patternIds: [doublerId],
        getClient,
      });

      expect(first).toEqual([doublerId]);
      expect(again).toEqual([]);
    });
    it("draws in an import's own imports before the import itself", async () => {
      await ensureCompilerStack();
      const doublerId = await computeEntryIdentity("/main.tsx", [
        { name: "/main.tsx", contents: DOUBLING_SOURCE },
      ]);
      const composing = [
        "import { pattern } from 'commonfabric';",
        `import doubler from "cf:pattern:${doublerId}";`,
        "interface Input { n: number; }",
        "export default pattern<Input, { half: { doubled: number } }>(",
        "  ({ n }) => ({ half: doubler({ n }) }),",
        ");",
        "",
      ].join("\n");
      const answer = clientAnswering((id) =>
        Promise.resolve(
          id === doublerId
            ? recordFor(id, DOUBLING_SOURCE)
            : recordFor(id, composing, [doublerId]),
        )
      );
      // An import's identity is only known by compiling it, so the composer's
      // is read off a compile in a space of its own.
      const scratch = (await Identity.generate()).did();
      const program = {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: composing }],
      };
      await composeProgram({
        runtime,
        space: scratch,
        program,
        getClient: answer,
      });
      const composerId = runtime.patternManager.getArtifactEntryRef(
        await compileAndSavePattern(runtime, program, { space: scratch }),
      )!.identity;

      const drawn = await materializeComposedPatterns({
        runtime,
        space: pieces.getSpace(),
        patternIds: [composerId],
        getClient: answer,
      });

      expect(drawn).toEqual([doublerId, composerId]);
    });
  });

  describe("composeProgram()", () => {
    it("throws a compose-stage error withholding a failure that is not a composition error", async () => {
      const error = await composeProgram({
        runtime,
        space: pieces.getSpace(),
        program: {
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: 'import a from "cf:pattern:a";\n',
          }],
        },
        getClient: clientAnswering((id) =>
          Promise.resolve({
            ...recordFor(id, DOUBLING_SOURCE),
            program: { main: "/main.tsx" },
          } as unknown as PatternIndexPattern)
        ),
      }).then(() => undefined, (e) => e);

      expect(error).toBeInstanceOf(IndexedPatternError);
      expect(error.name).toBe("IndexedPatternError");
      expect(error.stage).toBe("compose");
      expect(error.message).toContain("could not be made available");
      expect(error.rawCauseMessage).toBeDefined();
    });
  });
});
