import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  computeEntryIdentity,
  ensureCompilerStack,
  Runtime,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  type PatternIndexClient,
  PatternIndexError,
  type PatternIndexPattern,
} from "@commonfabric/pattern-index/client";
import {
  compileIndexedPattern,
  IndexedPatternError,
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
});
