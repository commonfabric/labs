import { expect } from "@std/expect";
import { join } from "@std/path";
import { ValidationError } from "@cliffy/command";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { FIRST_PARTY_HTTP_AUTH_HEADERS } from "@commonfabric/runner/toolshed-http-auth";
import {
  newPieceFromCommand,
  openIndexClient,
  piece,
  recordIndexedPiece,
} from "../commands/piece.ts";
import {
  PatternIndexClient,
  PatternIndexError,
  type PatternIndexGetRequest,
  type PatternIndexPattern,
} from "@commonfabric/pattern-index/client";
import {
  PatternIndexStore,
  patternIndexStoreDir,
} from "@commonfabric/pattern-index/store";
import { DEFAULT_PATTERN_INDEX_URL } from "@commonfabric/pattern-index/access";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { newPiece, newPieceWithReceipt } from "../lib/piece.ts";
import { captureStderr } from "./utils.ts";
import { FakePatternIndex } from "../../pattern-index/test/fake-pattern-index.ts";

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
      const recorded: string[][] = [];
      const error = await captureStderr(() =>
        newPieceFromCommand({ ...CONFIG, ...options }, main, {
          newPiece: (_config, received) => {
            created = true;
            entry = received;
            return Promise.resolve({ pieceId: "fid1:created" });
          },
          recordIndexedPiece: (url, pieceId, patternId) => {
            recorded.push([url, pieceId, patternId]);
            return Promise.resolve();
          },
        })
      ).then(() => undefined, (e) => e);
      return { entry, created, error, recorded };
    };

    it("hands newPiece the pattern id and the index URL in place of a file", async () => {
      const { entry, error } = await run(
        { fromIndex: " pat-1 ", patternIndexUrl: INDEX_URL },
        undefined,
      );

      expect(error).toBeUndefined();
      expect(entry).toEqual({ patternId: "pat-1", patternIndexUrl: INDEX_URL });
    });

    describe("its receipt", () => {
      /** Runs the action with `newPiece` answering `receipt`, capturing output. */
      const printed = async (
        options: Record<string, unknown>,
        receipt: { pieceId: string; name?: string },
      ) => {
        const out: { value: unknown; json?: boolean }[] = [];
        await captureStderr(() =>
          newPieceFromCommand(
            {
              ...CONFIG,
              fromIndex: "pat-1",
              patternIndexUrl: INDEX_URL,
              ...options,
            },
            undefined,
            {
              newPiece: () => Promise.resolve(receipt),
              recordIndexedPiece: () => Promise.resolve(),
              render: (value, flags) => {
                out.push({ value, ...(flags?.json ? { json: true } : {}) });
              },
            },
          )
        );
        return out;
      };

      it("prints the piece id and the index's name as one JSON object under --json", async () => {
        expect(
          await printed({ json: true }, { pieceId: "fid1:a", name: "Doubler" }),
        ).toEqual([
          { value: { pieceId: "fid1:a", name: "Doubler" }, json: true },
        ]);
      });

      it("prints no name key under --json when the index has none", async () => {
        expect(await printed({ json: true }, { pieceId: "fid1:a" })).toEqual([
          { value: { pieceId: "fid1:a" }, json: true },
        ]);
      });

      it("prints only the piece id without --json", async () => {
        expect(await printed({}, { pieceId: "fid1:a", name: "Doubler" }))
          .toEqual([{ value: "fid1:a" }]);
      });
    });

    it("records which published pattern the created piece came from", async () => {
      const { recorded } = await run(
        { fromIndex: "pat-1", patternIndexUrl: INDEX_URL },
        undefined,
      );

      expect(recorded).toEqual([[INDEX_URL, "fid1:created", "pat-1"]]);
    });

    it("reads the deployment's index when no index URL is given", async () => {
      for (const options of [{}, { patternIndexUrl: "  " }]) {
        const { recorded } = await run(
          { fromIndex: "pat-1", ...options },
          undefined,
        );

        expect(recorded).toEqual([
          [DEFAULT_PATTERN_INDEX_URL, "fid1:created", "pat-1"],
        ]);
      }
    });

    for (
      const [name, options, main, message] of [
        [
          "an index URL that does not parse",
          { fromIndex: "pat-1", patternIndexUrl: "not a url" },
          undefined,
          "--pattern-index-url must be an http(s) URL",
        ],
        [
          "an index URL that is not http(s)",
          { fromIndex: "pat-1", patternIndexUrl: "file:///index" },
          undefined,
          "--pattern-index-url must be an http(s) URL",
        ],
        [
          "an index URL with a query",
          { fromIndex: "pat-1", patternIndexUrl: `${INDEX_URL}?x=1` },
          undefined,
          "must not carry a query or fragment",
        ],
        [
          "an index URL with a fragment",
          { fromIndex: "pat-1", patternIndexUrl: `${INDEX_URL}#f` },
          undefined,
          "must not carry a query or fragment",
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

  describe("--from-link", () => {
    /** What the index answers for a ref: the link resolved, or a refusal. */
    const resolved = (request: PatternIndexGetRequest) =>
      Promise.resolve(pattern(`pat-for-${request.ref}`));

    const pattern = (
      patternId: string,
      link: PatternIndexPattern["link"] = {
        ref: "a-k3x9AbCdEf",
        channel: "stable",
        number: 3,
        stable: true,
      },
    ): PatternIndexPattern => ({
      patternId,
      createdAt: "2026-11-20T00:00:00Z",
      description: "",
      hashtags: [],
      dependencies: [],
      ...(link === undefined ? {} : { link }),
    });

    /** Runs the action against an index answering `answer`. */
    const run = async (
      options: Record<string, unknown>,
      main: string | undefined = undefined,
      answer: (
        request: PatternIndexGetRequest,
      ) => Promise<PatternIndexPattern> = resolved,
    ) => {
      let entry: unknown;
      const opened: string[][] = [];
      const asked: PatternIndexGetRequest[] = [];
      const recorded: string[][] = [];
      const error = await captureStderr(() =>
        newPieceFromCommand({ ...CONFIG, ...options }, main, {
          newPiece: (_config, received) => {
            entry = received;
            return Promise.resolve({ pieceId: "fid1:created" });
          },
          openIndexClient: (url, identity) => {
            opened.push([url, identity]);
            return Promise.resolve({
              getPattern: (request) => {
                asked.push(request);
                return answer(request);
              },
            });
          },
          recordIndexedPiece: (url, pieceId, patternId) => {
            recorded.push([url, pieceId, patternId]);
            return Promise.resolve();
          },
        })
      ).then(() => undefined, (e) => e);
      return { entry, opened, asked, recorded, error };
    };

    it("deploys and records the pattern id the link names, asked as the space's identity", async () => {
      const { entry, opened, asked, recorded, error } = await run({
        fromLink: " a-k3x9AbCdEf@beta ",
        patternIndexUrl: INDEX_URL,
      });

      expect(error).toBeUndefined();
      expect(opened).toEqual([[INDEX_URL, CONFIG.identity]]);
      expect(asked).toEqual([{ ref: "a-k3x9AbCdEf@beta" }]);
      expect(entry).toEqual({
        patternId: "pat-for-a-k3x9AbCdEf@beta",
        patternIndexUrl: INDEX_URL,
      });
      expect(recorded).toEqual([
        [INDEX_URL, "fid1:created", "pat-for-a-k3x9AbCdEf@beta"],
      ]);
    });

    it("never asks the index under --from-index", async () => {
      const { opened, entry } = await run({
        fromIndex: "pat-1",
        patternIndexUrl: INDEX_URL,
      });

      expect(opened).toEqual([]);
      expect(entry).toEqual({ patternId: "pat-1", patternIndexUrl: INDEX_URL });
    });

    for (
      const [name, link, answer, kind, message] of [
        [
          "the index has nothing under a bare link, naming its beta",
          "a-k3x9AbCdEf",
          () => Promise.reject(new PatternIndexError("getPattern", 404)),
          ValidationError,
          "No shared pattern answers to the link a-k3x9AbCdEf: it may be mistyped, withdrawn, or not shared on that channel yet (a-k3x9AbCdEf@beta names its beta).",
        ],
        [
          "the index has nothing under a channel link",
          "a-k3x9AbCdEf@beta",
          () => Promise.reject(new PatternIndexError("getPattern", 404)),
          ValidationError,
          "No shared pattern answers to the link a-k3x9AbCdEf@beta: it may be mistyped, withdrawn, or not shared on that channel yet.",
        ],
        [
          "the index fails otherwise",
          "a-k3x9AbCdEf",
          () => Promise.reject(new PatternIndexError("getPattern", 503)),
          Error,
          "pattern index lookup failed for the link a-k3x9AbCdEf",
        ],
        [
          "the index answers without resolving a link",
          "a-k3x9AbCdEf",
          () => {
            const { link: _link, ...bare } = pattern("pat-1");
            return Promise.resolve(bare);
          },
          Error,
          "did not resolve a-k3x9AbCdEf as a link",
        ],
      ] as const
    ) {
      it(`creates nothing when ${name}`, async () => {
        const { entry, recorded, error } = await run(
          { fromLink: link, patternIndexUrl: INDEX_URL },
          undefined,
          answer,
        );

        expect(error).toBeInstanceOf(kind);
        expect(error.message).toContain(message);
        expect(entry).toBeUndefined();
        expect(recorded).toEqual([]);
      });
    }

    for (
      const [name, options, main, message] of [
        [
          "a blank link",
          { fromLink: "  ", patternIndexUrl: INDEX_URL },
          undefined,
          "--from-link requires a non-blank link",
        ],
        [
          "a source file as well",
          { fromLink: "a-k3x9AbCdEf", patternIndexUrl: INDEX_URL },
          "/repo/main.tsx",
          "drop --from-link",
        ],
        [
          "--from-index as well",
          { fromLink: "a-k3x9AbCdEf", fromIndex: "pat-1" },
          undefined,
          "Pass --from-index or --from-link, not both",
        ],
        [
          "a request key, which replays one fixed version",
          { fromLink: "a-k3x9AbCdEf", requestKey: "k1" },
          undefined,
          "pass --from-index <patternId> instead",
        ],
        [
          "an index URL that does not parse",
          { fromLink: "a-k3x9AbCdEf", patternIndexUrl: "not a url" },
          undefined,
          "--pattern-index-url must be an http(s) URL",
        ],
        [
          "version facts, which a piece from the index keeps none of",
          { fromLink: "a-k3x9AbCdEf", versionOrigin: "agent" },
          undefined,
          "a piece from the index keeps none",
        ],
      ] as const
    ) {
      it(`throws a ValidationError for ${name}, before asking the index`, async () => {
        const { opened, entry, error } = await run(options, main);

        expect(error).toBeInstanceOf(ValidationError);
        expect(error.message).toContain(message);
        expect(opened).toEqual([]);
        expect(entry).toBeUndefined();
      });
    }
  });

  it("declares --from-index as conflicting with the local-source options", () => {
    const option = piece.getCommand("new")?.getOption("from-index");

    expect(option?.conflicts).toEqual([
      "version-entry",
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
            readServedInstantiateReceipt: () => Promise.resolve(undefined),
            getProgramFromIndex: (_pieces, _config, entry) => {
              reads.push(entry);
              return Promise.resolve({ program: PROGRAM });
            },
            loadIdentity: () =>
              Promise.resolve({ did: () => "did:key:zActor" } as never),
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

    it("replays a served creation by its receipt's pattern, reading no index", async () => {
      // The serving side answers a request key it has seen from its receipt,
      // so the replay names the pattern the receipt holds instead of
      // fetching and compiling the program again.
      const sent: unknown[] = [];
      const pattern = { identity: "zPattern", symbol: "default" };
      const { pieceId } = await newPieceWithReceipt(
        CONFIG,
        { patternId: "pat-1", patternIndexUrl: INDEX_URL },
        { requestKey: "deploy" },
        {
          loadPieces: () =>
            Promise.resolve({
              runtime: { experimental: { serverExecution: true } },
              getSpace: () => "did:key:test-space",
            } as never),
          loadIdentity: () =>
            Promise.resolve({ did: () => "did:key:zActor" } as never),
          readServedInstantiateReceipt: (_pieces, requestKey, actingUser) =>
            Promise.resolve(
              requestKey === "deploy" && actingUser === "did:key:zActor"
                ? {
                  requestKey,
                  pieceId: "fid1:created",
                  pattern,
                  registration: { status: "handled" },
                }
                : undefined,
            ),
          getProgramFromIndex: () =>
            Promise.reject(new Error("the index is read")),
          instantiatePieceOnServer: (_config, request) => {
            sent.push(request);
            return Promise.resolve({
              pieceId: "fid1:created",
              pattern,
              requestKey: "deploy",
              registration: { status: "handled" },
            });
          },
        },
      );

      expect(pieceId).toBe("fid1:created");
      expect(sent).toEqual([
        expect.objectContaining({ requestKey: "deploy", pattern }),
      ]);
      expect(sent[0]).not.toHaveProperty("program");
    });

    describe("against the index", () => {
      // Only the HTTP is faked here: the identity, the signed client, and the
      // shared deploy path all run as they do for an operator.

      const SOURCE = [
        "import { computed, pattern } from 'commonfabric';",
        "interface Input { n: number; }",
        "export default pattern<Input, { doubled: number }>(({ n }) => ({",
        "  doubled: computed(() => n * 2),",
        "}));",
        "",
      ].join("\n");

      let signer: Identity;
      let storageManager: ReturnType<typeof StorageManager.emulate>;
      let runtime: Runtime;

      beforeEach(async () => {
        signer = await Identity.generate();
        storageManager = StorageManager.emulate({ as: signer });
        runtime = new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager,
        });
      });

      afterEach(async () => {
        await runtime?.dispose();
        await storageManager?.close();
      });

      /** Creates `pat-1` from an index answering `getPattern` with `answer`. */
      const createFrom = async (answer: Response) => {
        const requests: { url: string; as: string | null }[] = [];
        let created: unknown;
        let receipt: unknown;
        const error = await newPieceWithReceipt(
          CONFIG,
          { patternId: "pat-1", patternIndexUrl: INDEX_URL },
          { start: false },
          {
            loadPieces: () =>
              Promise.resolve({
                runtime,
                getSpace: () => signer.did(),
                ensureDefaultPattern: () => Promise.resolve(),
                create: (program: unknown) => {
                  created = program;
                  return Promise.resolve({
                    id: "fid1:created",
                    getCell: () => ({}),
                  });
                },
                add: () => Promise.resolve(),
              } as never),
            loadIdentity: () => Promise.resolve(signer),
            // An empty store, so the user's own index membership never
            // reaches the request.
            patternIndexStore: new PatternIndexStore(
              `${Deno.makeTempDirSync()}/pattern-index`,
            ),
            patternIndexFetch: (input, init) => {
              requests.push({
                url: String(input),
                as: new Headers(init?.headers).get(
                  FIRST_PARTY_HTTP_AUTH_HEADERS.userDid,
                ),
              });
              return Promise.resolve(answer);
            },
          },
        ).then((answered) => {
          receipt = answered;
        }, (e) => e);
        return { requests, created, receipt, error };
      };

      /** A `getPattern` answer for `pat-1`, carrying `name` when given one. */
      const record = (name?: string) =>
        Response.json({
          patternId: "pat-1",
          ...(name === undefined ? {} : { name }),
          ownerDid: signer.did(),
          createdAt: "2026-11-14T00:00:00.000Z",
          description: "doubles n",
          dependencies: [],
          program: {
            main: "/main.tsx",
            files: [{ name: "/main.tsx", contents: SOURCE }],
          },
        });

      it("creates the piece from the program the index served", async () => {
        const { requests, created, receipt, error } = await createFrom(
          record(),
        );

        expect(error).toBeUndefined();
        expect(receipt).toEqual({ pieceId: "fid1:created" });
        expect(requests).toEqual([
          { url: `${INDEX_URL}/getPattern`, as: signer.did() },
        ]);
        expect(created).toEqual({
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: SOURCE }],
        });
      });

      it("answers the index's display name beside the piece id", async () => {
        const { receipt, error } = await createFrom(record("Doubler"));

        expect(error).toBeUndefined();
        expect(receipt).toEqual({ pieceId: "fid1:created", name: "Doubler" });
      });

      it("throws an IndexedPatternError naming the id when the index fails", async () => {
        const { created, error } = await createFrom(
          Response.json({ error: "no such pattern" }, { status: 404 }),
        );

        expect(error?.name).toBe("IndexedPatternError");
        expect(error.message).toBe(
          'pattern index lookup failed for "pat-1": pattern index getPattern failed (404)',
        );
        expect(error.rawCauseMessage).toBe("no such pattern");
        expect(created).toBeUndefined();
      });
    });
  });

  describe("recordIndexedPiece()", () => {
    it("records the pattern a piece came from in the store for that index", async () => {
      const home = await Deno.makeTempDir();
      try {
        const warnings = await captureStderr(() =>
          recordIndexedPiece(
            INDEX_URL,
            "fid1:created",
            "pat-1",
            (key) => key === "CF_PATTERN_INDEX_HOME" ? home : undefined,
          )
        );

        expect(warnings).toEqual([]);
        expect(
          await new PatternIndexStore(`${home}/index.example`).indexedPiece(
            "fid1:created",
          ),
        ).toBe("pat-1");
      } finally {
        await Deno.remove(home, { recursive: true });
      }
    });

    it("warns, rather than throwing, when there is no place to keep the record", async () => {
      const warnings = await captureStderr(() =>
        recordIndexedPiece(INDEX_URL, "fid1:created", "pat-1", () => undefined)
      );

      expect(warnings).toEqual([
        expect.stringContaining(
          "Could not record that fid1:created came from pat-1: ",
        ),
      ]);
      expect(warnings[0]).toContain(
        "No place to keep pattern index membership",
      );
    });
  });

  describe("openIndexClient()", () => {
    let dir: string;
    let keyPath: string;
    let signer: Identity;
    let index: FakePatternIndex;
    let server: Deno.HttpServer<Deno.NetAddr>;
    let baseUrl: string;
    const env = (key: string) =>
      key === "CF_PATTERN_INDEX_HOME" ? join(dir, "index-home") : undefined;

    beforeEach(async () => {
      dir = await Deno.makeTempDir();
      keyPath = join(dir, "space.key");
      const pkcs8 = await Identity.generatePkcs8();
      await Deno.writeFile(keyPath, pkcs8);
      signer = await Identity.fromPkcs8(pkcs8);
      index = new FakePatternIndex();
      server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen: () => {} },
        async (request) =>
          await index.fetchFn(request.url, {
            method: request.method,
            headers: request.headers,
            body: await request.text(),
          }),
      );
      baseUrl = `http://127.0.0.1:${server.addr.port}`;
    });

    afterEach(async () => {
      await server.shutdown();
      await Deno.remove(dir, { recursive: true });
    });

    /** Admits a fresh root to the index and publishes `pat-1` as it. */
    const admitRoot = async (root: Identity) => {
      index.admit(root.did(), "p-1");
      await new PatternIndexClient({
        baseUrl,
        signer: root,
        fetchFn: index.fetchFn,
      }).publishPattern({
        patternId: "pat-1",
        description: "doubles n",
        hashtags: [],
        program: { main: "/main.tsx", files: [] },
      });
    };

    it("asks the index as the key file's identity, presenting the chain kept for that index", async () => {
      const store = new PatternIndexStore(patternIndexStoreDir(baseUrl, env));
      const root = await store.createRootKey();
      await store.recordMembership({
        handle: "p-1",
        role: "user",
        root: root.did(),
      });
      await admitRoot(root);

      const client = await openIndexClient(baseUrl, keyPath, env);

      expect(await client.getPattern({ patternId: "pat-1" })).toMatchObject({
        patternId: "pat-1",
        handle: "p-1",
        mine: true,
      });
      expect(index.calls.at(-1)).toMatchObject({
        fn: "getPattern",
        signer: signer.did(),
      });
    });

    it("is refused as a stranger when no membership is kept for that index", async () => {
      await admitRoot(await Identity.generate());

      const client = await openIndexClient(baseUrl, keyPath, env);
      const error = await client.getPattern({ patternId: "pat-1" }).then(
        () => undefined,
        (e) => e,
      );

      expect(error).toBeInstanceOf(PatternIndexError);
      expect(error.status).toBe(403);
      expect(index.calls.at(-1)).toMatchObject({
        fn: "getPattern",
        signer: signer.did(),
      });
    });
  });
});
