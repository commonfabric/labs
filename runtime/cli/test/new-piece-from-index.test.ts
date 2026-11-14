import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { ValidationError } from "@cliffy/command";
import { newPieceFromCommand, piece } from "../commands/piece.ts";
import { newPiece } from "../lib/piece.ts";
import { captureStderr } from "./utils.ts";

const CONFIG = {
  apiUrl: "https://cf.dev",
  space: "from-index",
  identity: "/unused/test.key",
  quiet: true,
};
const INDEX_URL = "https://index.example";
const PROGRAM = {
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents: "export default 1;\n" }],
};

describe("piece new --from-index", () => {
  describe("newPieceFromCommand()", () => {
    /** Runs the action, answering what it handed `newPiece`, or the refusal. */
    const run = async (
      options: Record<string, unknown>,
      main: string | undefined,
    ) => {
      let entry: unknown;
      let created = false;
      const error = await captureStderr(() =>
        newPieceFromCommand({ ...CONFIG, ...options }, main, {
          newPiece: (_config, received) => {
            created = true;
            entry = received;
            return Promise.resolve("fid1:created");
          },
        })
      ).then(() => undefined, (e) => e);
      return { entry, created, error };
    };

    it("hands newPiece the pattern id and the index URL in place of a file", async () => {
      const { entry, error } = await run(
        { fromIndex: " pat-1 ", patternIndexUrl: INDEX_URL },
        undefined,
      );

      expect(error).toBeUndefined();
      expect(entry).toEqual({ patternId: "pat-1", patternIndexUrl: INDEX_URL });
    });

    for (
      const [name, options, main, message] of [
        [
          "no index URL",
          { fromIndex: "pat-1" },
          undefined,
          "--from-index needs the pattern index to read from",
        ],
        [
          "an index URL that does not parse",
          { fromIndex: "pat-1", patternIndexUrl: "not a url" },
          undefined,
          "--pattern-index-url must be a valid URL",
        ],
        [
          "a blank pattern id",
          { fromIndex: " ", patternIndexUrl: INDEX_URL },
          undefined,
          "--from-index requires a non-blank pattern id",
        ],
        [
          "a source file as well",
          { fromIndex: "pat-1", patternIndexUrl: INDEX_URL },
          "/repo/main.tsx",
          'drop the source file "/repo/main.tsx"',
        ],
        [
          "neither a source file nor a pattern id",
          {},
          undefined,
          "Missing a pattern",
        ],
      ] as const
    ) {
      it(`throws a ValidationError for ${name}, before creating a piece`, async () => {
        const { created, error } = await run(options, main);

        expect(error).toBeInstanceOf(ValidationError);
        expect(error.message).toContain(message);
        expect(created).toBe(false);
      });
    }
  });

  it("declares --from-index as conflicting with the local-source options", () => {
    const option = piece.getCommand("new")?.getOption("from-index");

    expect(option?.conflicts).toEqual([
      "main-export",
      "root",
      "repository",
      "test",
      "datafile",
    ]);
  });

  describe("newPiece()", () => {
    for (const served of [false, true]) {
      it(
        `creates the piece from the indexed program during ${
          served ? "served" : "client"
        } creation`,
        async () => {
          const reads: unknown[] = [];
          let received: unknown;
          const dependencies: NonNullable<Parameters<typeof newPiece>[3]> = {
            loadPieces: () =>
              Promise.resolve({
                runtime: { experimental: { serverExecution: served } },
                getSpace: () => "did:key:test-space",
                ensureDefaultPattern: () => Promise.resolve(),
                create: (program: unknown, options: unknown) => {
                  received = { program, options };
                  return Promise.resolve({
                    id: "fid1:created",
                    getCell: () => ({}),
                  });
                },
                add: () => Promise.resolve(),
                getPieceCell: () => Promise.resolve({}),
              } as never),
            getPinnedProgramFromFile: () => {
              reads.push("file");
              return Promise.reject(new Error("no file is read"));
            },
            getProgramFromIndex: (_pieces, _config, entry) => {
              reads.push(entry);
              return Promise.resolve(PROGRAM);
            },
            loadIdentity: () => Promise.resolve({} as never),
            instantiatePieceOnServer: (_config, request) => {
              received = request;
              return Promise.resolve({
                pieceId: "fid1:created",
                pattern: { identity: "pattern", symbol: "default" },
                requestKey: "deploy",
                registration: { status: "handled" },
              });
            },
          };

          const id = await newPiece(
            CONFIG,
            { patternId: "pat-1", patternIndexUrl: INDEX_URL },
            { start: false, ...(served ? { requestKey: "deploy" } : {}) },
            dependencies,
          );

          expect(id).toBe("fid1:created");
          expect(reads).toEqual([
            { patternId: "pat-1", patternIndexUrl: INDEX_URL },
          ]);
          expect(received).toMatchObject(
            served
              ? { program: PROGRAM, requestKey: "deploy" }
              : { program: PROGRAM, options: { repository: undefined } },
          );
        },
      );
    }
  });
});
