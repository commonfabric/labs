import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { valueEqual } from "@commonfabric/data-model";
import {
  FabricBytes,
  FabricEpochNsec,
} from "@commonfabric/data-model/fabric-primitives";
import { type Cell, Runtime } from "@commonfabric/runner";
import {
  cfcLabelViewForCell,
  readStoredCfcMetadata,
} from "@commonfabric/runner/cfc";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  getCellCfcLabel,
  parseCellCfcLabelUpdate,
  setCellCfcLabel,
} from "../lib/piece.ts";
import {
  getCellCfcLabelFromCommand,
  setCellCfcLabelFromCommand,
  setQuietMode,
} from "../commands/piece.ts";
import { CellImpl } from "../../runner/src/cell.ts";
import { interceptTransaction } from "../../runner/test/support/intercept-transaction.ts";
import { cell } from "../commands/cell.ts";
import { argv, cf, stripAnsi } from "./utils.ts";

const signer = await Identity.fromPassphrase("cf-piece-label");
const pieceConfig = {
  apiUrl: "https://example.com",
  identity: "/unused.key",
  space: signer.did(),
  piece: "piece",
};

describe("cf piece CFC labels", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let root: Cell<{ body: string }>;
  let deps: {
    loadPieces: () => Promise<unknown>;
    resolvePieceAddress: (_pieces: unknown, token: string) => Promise<string>;
  };

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    root = runtime.getCell<{ body: string }>(
      signer.did(),
      "cf-piece-label-root",
      {
        type: "object",
        properties: { body: { type: "string" } },
        required: ["body"],
      },
    );
    const tx = runtime.edit();
    root.withTx(tx).set({ body: "hello" });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();

    const piece = {
      input: { getCell: () => Promise.resolve(root) },
      result: { getCell: () => Promise.resolve(root) },
    };
    const pieces = {
      runtime,
      get: () => Promise.resolve(piece),
      synced: () => Promise.resolve(),
    };
    deps = {
      loadPieces: () => Promise.resolve(pieces),
      resolvePieceAddress: (_pieces, token) => Promise.resolve(token),
    };
  });

  afterEach(async () => {
    setQuietMode(false);
    await runtime.dispose();
    await storageManager.close();
  });

  it("validates the declared-label JSON shape", () => {
    expect(parseCellCfcLabelUpdate({
      confidentiality: ["team"],
      integrity: [],
      observes: "value",
    })).toEqual({
      confidentiality: ["team"],
      integrity: [],
      observes: "value",
    });
    expect(() => parseCellCfcLabelUpdate(null)).toThrow(
      "must be a JSON object",
    );
    expect(() => parseCellCfcLabelUpdate({ observes: "value" })).toThrow(
      "must include confidentiality or integrity",
    );
    expect(() => parseCellCfcLabelUpdate({ confidentiality: "team" })).toThrow(
      "confidentiality must be a JSON array",
    );
    expect(() => parseCellCfcLabelUpdate({ integrity: "reviewed" })).toThrow(
      "integrity must be a JSON array",
    );
    expect(() => parseCellCfcLabelUpdate({ integrity: [], extra: true }))
      .toThrow("Unknown CFC label field: extra");
    expect(() =>
      parseCellCfcLabelUpdate({ integrity: [], observes: "content" })
    ).toThrow("value, shape, enumerate, or followRef");
  });

  it("routes both command actions through their JSON boundaries", async () => {
    const actionHandler = (
      // deno-lint-ignore no-explicit-any
      parent: any,
      name: string,
    ): unknown =>
      (parent.getCommand(name, true) as unknown as
        | { actionHandler?: unknown }
        | undefined)?.actionHandler;
    expect(actionHandler(cell, "get-label")).toBe(getCellCfcLabelFromCommand);
    expect(actionHandler(cell, "set-label")).toBe(setCellCfcLabelFromCommand);

    const options = {
      apiUrl: "https://example.com",
      identity: "/identity.key",
      space: signer.did(),
      cell: "piece",
      input: true,
      quiet: true,
    };
    const rendered: Array<{ value: unknown; json: boolean | undefined }> = [];
    const getCalls: unknown[][] = [];
    const setCalls: unknown[][] = [];
    const label = { version: 1 as const, entries: [] };
    const renderOutput = (value: unknown, config?: { json?: boolean }) => {
      rendered.push({ value, json: config?.json });
    };

    await getCellCfcLabelFromCommand(options, "messages/0/body", {
      getCellCfcLabel: ((...args: unknown[]) => {
        getCalls.push(args);
        return Promise.resolve(label);
      }) as never,
      render: renderOutput,
    });
    await setCellCfcLabelFromCommand(options, undefined, {
      drainStdin: () => Promise.resolve({ integrity: [] }),
      setCellCfcLabel: ((...args: unknown[]) => {
        setCalls.push(args);
        return Promise.resolve(null);
      }) as never,
      render: renderOutput,
    });

    expect(getCalls[0]?.[0]).toEqual({
      apiUrl: "https://example.com",
      identity: "/identity.key",
      space: signer.did(),
      piece: "piece",
      pieceInput: true,
      jsonOutput: true,
    });
    expect(getCalls[0]?.slice(1)).toEqual([
      ["messages", 0, "body"],
      { input: true },
    ]);
    expect(setCalls[0]?.[0]).toEqual(getCalls[0]?.[0]);
    expect(setCalls[0]?.slice(1)).toEqual([
      [],
      { integrity: [] },
      { input: true },
    ]);
    expect(rendered).toEqual([
      { value: label, json: true },
      { value: null, json: true },
    ]);
  });

  it("sets a declared label and returns its effective view", async () => {
    const updated = await setCellCfcLabel(
      pieceConfig,
      ["body"],
      {
        confidentiality: ["team"],
        integrity: ["reviewed", "authored"],
        observes: "value",
      },
      {},
      deps as never,
    );

    expect(updated).toEqual({
      version: 1,
      entries: [{
        path: [],
        label: {
          confidentiality: ["team"],
          integrity: ["reviewed", "authored"],
        },
        observes: "value",
      }],
    });
    expect(
      await getCellCfcLabel(pieceConfig, ["body"], {}, deps as never),
    ).toEqual(updated);
  });

  it("returns labels declared only by the selected cell schema", async () => {
    const schemaOnlyRoot = root.asSchema({
      type: "object",
      ifc: {
        confidentiality: ["workspace"],
        observes: "shape",
      },
      properties: {
        body: {
          type: "string",
          ifc: { integrity: ["reviewed"] },
        },
      },
      required: ["body"],
    });
    const schemaOnlyDeps = {
      ...deps,
      loadPieces: () =>
        Promise.resolve({
          runtime,
          get: () =>
            Promise.resolve({
              input: { getCell: () => Promise.resolve(schemaOnlyRoot) },
              result: { getCell: () => Promise.resolve(schemaOnlyRoot) },
            }),
          synced: () => Promise.resolve(),
        }),
    };

    expect(
      await getCellCfcLabel(pieceConfig, [], {}, schemaOnlyDeps as never),
    ).toEqual({
      version: 1,
      entries: [
        {
          path: [],
          label: { confidentiality: ["workspace"] },
          observes: "shape",
        },
        {
          path: ["body"],
          label: { integrity: ["reviewed"] },
        },
      ],
    });
  });

  it("requires a transaction and an existing value for a CFC schema update", async () => {
    expect(() =>
      root.key("body").asSchema({
        ifc: { confidentiality: ["team"] },
      }).applyCfcSchemaToExistingValue()
    ).toThrow("Transaction required");

    const absent = runtime.getCell<string>(
      signer.did(),
      "cf-piece-label-absent-schema-target",
      { type: "string" },
    );
    await absent.pull();
    const tx = runtime.edit();
    expect(() =>
      absent.withTx(tx).asSchema({
        ifc: { confidentiality: ["team"] },
      }).applyCfcSchemaToExistingValue()
    ).toThrow("absent value");
    tx.abort();
  });

  it("labels a link slot without moving the label to its target", async () => {
    const linked = runtime.getCell<string>(
      signer.did(),
      "cf-piece-label-linked-target",
      { type: "string" },
    );
    const seed = runtime.edit();
    linked.withTx(seed).set("linked value");
    const storedLink = linked.getAsLink();
    root.withTx(seed).key("body").setRawUntyped(storedLink);
    runtime.prepareTxForCommit(seed);
    expect((await seed.commit().settled).error).toBeUndefined();

    const updated = await setCellCfcLabel(
      pieceConfig,
      ["body"],
      { confidentiality: ["team"] },
      {},
      deps as never,
    );

    await root.pull();
    await linked.pull();
    expect(root.key("body").getRaw()).toEqual(storedLink);
    expect(linked.getRaw()).toBe("linked value");
    expect(cfcLabelViewForCell(linked)).toBeUndefined();
    expect(updated?.entries[0].label.confidentiality).toEqual(["team"]);
  });

  it("applies a label through a schema-bearing write redirect", async () => {
    const linked = runtime.getCell<string>(
      signer.did(),
      "cf-piece-label-write-redirect-target",
      { type: "string" },
    );
    const seed = runtime.edit();
    linked.withTx(seed).set("redirected value");
    const storedRedirect = linked.getAsWriteRedirectLink({
      includeSchema: true,
    });
    root.withTx(seed).key("body").setRawUntyped(storedRedirect);
    runtime.prepareTxForCommit(seed);
    expect((await seed.commit().settled).error).toBeUndefined();

    const updated = await setCellCfcLabel(
      pieceConfig,
      ["body"],
      { confidentiality: ["team"] },
      {},
      deps as never,
    );

    await root.pull();
    await linked.pull();
    expect(root.key("body").getRaw()).toEqual(storedRedirect);
    expect(linked.getRaw()).toBe("redirected value");
    expect(cfcLabelViewForCell(linked)?.entries[0].label.confidentiality)
      .toEqual(["team"]);
    expect(updated?.entries[0].label.confidentiality).toEqual(["team"]);
  });

  it("preserves raw `FabricValue`s while adding a label", async () => {
    const original = {
      bytes: new FabricBytes(new Uint8Array([1, 2, 3])),
      timestamp: new FabricEpochNsec(1_725_000_000_000_000_000n),
    };
    const fabricRoot = runtime.getCell<{ body: typeof original }>(
      signer.did(),
      "cf-piece-label-fabric-root",
      {
        type: "object",
        properties: {
          body: {
            type: "object",
            properties: {
              bytes: { type: "FabricBytes" },
              timestamp: { type: "FabricEpochNsec" },
            },
            required: ["bytes", "timestamp"],
          },
        },
        required: ["body"],
      },
    );
    const seed = runtime.edit();
    fabricRoot.withTx(seed).set({ body: original });
    runtime.prepareTxForCommit(seed);
    expect((await seed.commit().settled).error).toBeUndefined();
    await fabricRoot.pull();
    const before = fabricRoot.key("body").getRawUntyped();
    const piece = {
      input: { getCell: () => Promise.resolve(fabricRoot) },
      result: { getCell: () => Promise.resolve(fabricRoot) },
    };
    const fabricDeps = {
      ...deps,
      loadPieces: () =>
        Promise.resolve({
          runtime,
          get: () => Promise.resolve(piece),
          synced: () => Promise.resolve(),
        }),
    };

    const updated = await setCellCfcLabel(
      pieceConfig,
      ["body"],
      { confidentiality: ["team"] },
      {},
      fabricDeps as never,
    );

    await fabricRoot.pull();
    const after = fabricRoot.key("body").getRawUntyped() as typeof original;
    expect(valueEqual(after, before)).toBe(true);
    expect(after.bytes).toBeInstanceOf(FabricBytes);
    expect(Array.from(after.bytes.slice())).toEqual([1, 2, 3]);
    expect(after.timestamp).toBeInstanceOf(FabricEpochNsec);
    expect(after.timestamp.value).toBe(1_725_000_000_000_000_000n);
    expect(updated?.entries[0].label.confidentiality).toEqual(["team"]);
  });

  it("allows integrity to become less trusted", async () => {
    await setCellCfcLabel(
      pieceConfig,
      ["body"],
      { integrity: ["reviewed", "authored"] },
      {},
      deps as never,
    );
    const updated = await setCellCfcLabel(
      pieceConfig,
      ["body"],
      { integrity: ["reviewed"] },
      {},
      deps as never,
    );

    expect(updated?.entries[0].label.integrity).toEqual(["reviewed"]);

    const cleared = await setCellCfcLabel(
      pieceConfig,
      ["body"],
      { integrity: [] },
      {},
      deps as never,
    );
    expect(cleared).toBeNull();
  });

  it("rejects weaker confidentiality", async () => {
    await setCellCfcLabel(
      pieceConfig,
      ["body"],
      { confidentiality: ["team"] },
      {},
      deps as never,
    );

    await expect(setCellCfcLabel(
      pieceConfig,
      ["body"],
      { confidentiality: [] },
      {},
      deps as never,
    )).rejects.toThrow("confidentiality cannot be weakened");
  });

  it("rejects a conflicting observation class", async () => {
    await setCellCfcLabel(
      pieceConfig,
      ["body"],
      { confidentiality: ["team"], observes: "value" },
      {},
      deps as never,
    );

    await expect(setCellCfcLabel(
      pieceConfig,
      ["body"],
      { confidentiality: ["team"], observes: "shape" },
      {},
      deps as never,
    )).rejects.toThrow("effective label already uses a different");
    expect(
      await getCellCfcLabel(pieceConfig, ["body"], {}, deps as never),
    ).toEqual({
      version: 1,
      entries: [{
        path: [],
        label: { confidentiality: ["team"] },
        observes: "value",
      }],
    });
  });

  it("preserves an observation class when a later update omits it", async () => {
    await setCellCfcLabel(
      pieceConfig,
      ["body"],
      { confidentiality: ["team"], observes: "value" },
      {},
      deps as never,
    );

    const updated = await setCellCfcLabel(
      pieceConfig,
      ["body"],
      { confidentiality: ["team", "legal"] },
      {},
      deps as never,
    );
    expect(updated).toEqual({
      version: 1,
      entries: [{
        path: [],
        label: { confidentiality: ["team", "legal"] },
        observes: "value",
      }],
    });
  });

  it("preserves an observation class declared by the stored schema", async () => {
    const schemaRoot = runtime.getCell<{ body: string }>(
      signer.did(),
      "cf-piece-label-schema-observes",
      {
        type: "object",
        properties: {
          body: {
            type: "string",
            ifc: {
              confidentiality: ["team"],
              observes: "value",
            },
          },
        },
        required: ["body"],
      },
    );
    const tx = runtime.edit();
    schemaRoot.withTx(tx).set({ body: "hello" });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();

    const schemaDeps = {
      ...deps,
      loadPieces: () =>
        Promise.resolve({
          runtime,
          get: () =>
            Promise.resolve({
              input: { getCell: () => Promise.resolve(schemaRoot) },
              result: { getCell: () => Promise.resolve(schemaRoot) },
            }),
          synced: () => Promise.resolve(),
        }),
    };
    const updated = await setCellCfcLabel(
      pieceConfig,
      ["body"],
      { confidentiality: ["team", "legal"] },
      {},
      schemaDeps as never,
    );

    expect(updated).toEqual({
      version: 1,
      entries: [{
        path: [],
        label: { confidentiality: ["team", "legal"] },
        observes: "value",
      }],
    });
  });

  it("rejects an ambiguous observation class instead of choosing one", async () => {
    // The root, carrying a view whose `body` has entries of two observation
    // classes.
    const ambiguousCell = new CellImpl(
      runtime,
      undefined,
      root.getAsNormalizedFullLink(),
      false,
      undefined,
      "cell",
      {
        version: 1,
        entries: [
          {
            path: ["body"],
            label: { confidentiality: ["team"] },
            observes: "value",
          },
          {
            path: ["body"],
            label: { integrity: ["reviewed"] },
            observes: "shape",
          },
        ],
      },
    );
    const ambiguousDeps = {
      ...deps,
      loadPieces: () =>
        Promise.resolve({
          runtime,
          get: () =>
            Promise.resolve({
              input: { getCell: () => Promise.resolve(ambiguousCell) },
              result: { getCell: () => Promise.resolve(ambiguousCell) },
            }),
          synced: () => Promise.resolve(),
        }),
    };

    await expect(setCellCfcLabel(
      pieceConfig,
      ["body"],
      { confidentiality: ["team", "legal"] },
      {},
      ambiguousDeps as never,
    )).rejects.toThrow(
      'Cannot preserve observes at "body": ' +
        "the effective label uses multiple observation classes.",
    );
  });

  it("redacts caveat sources from command-facing label views", async () => {
    const updated = await setCellCfcLabel(
      pieceConfig,
      ["body"],
      {
        confidentiality: [{
          type: CFC_ATOM_TYPE.Caveat,
          kind: "derived-from",
          source: "did:key:private-source",
        }],
      },
      {},
      deps as never,
    );

    expect(updated?.entries[0].label.confidentiality).toEqual([{
      type: CFC_ATOM_TYPE.Caveat,
      kind: "derived-from",
    }]);
  });

  it("returns null for unlabeled values and rejects absent paths", async () => {
    expect(
      await getCellCfcLabel(pieceConfig, ["body"], {}, deps as never),
    ).toBeNull();
    await expect(setCellCfcLabel(
      pieceConfig,
      ["missing"],
      { confidentiality: ["team"] },
      {},
      deps as never,
    )).rejects.toThrow('absent path "missing"');
  });

  it("fails when label metadata cannot be read", async () => {
    // The root, read through a transaction whose every read fails.
    const failingCell = new CellImpl(
      runtime,
      interceptTransaction(runtime.edit(), (method, _args, proceed) => {
        if (method === "readOrThrow" || method === "readValueOrThrow") {
          throw new Error("metadata unavailable");
        }
        return proceed();
      }),
      root.getAsNormalizedFullLink(),
    );
    let editCalled = false;
    const failingPieces = {
      runtime: {
        edit: () => {
          editCalled = true;
          throw new Error("edit must not start");
        },
      },
      get: () =>
        Promise.resolve({
          input: { getCell: () => Promise.resolve(failingCell) },
          result: { getCell: () => Promise.resolve(failingCell) },
        }),
    };
    const failingDeps = {
      loadPieces: () => Promise.resolve(failingPieces),
      resolvePieceAddress: (_pieces: unknown, token: string) =>
        Promise.resolve(token),
    };

    await expect(getCellCfcLabel(
      pieceConfig,
      [],
      {},
      failingDeps as never,
    )).rejects.toThrow('Could not read CFC labels at "<root>"');
    await expect(setCellCfcLabel(
      pieceConfig,
      [],
      { confidentiality: ["team"] },
      {},
      failingDeps as never,
    )).rejects.toThrow('Could not read CFC labels at "<root>"');
    expect(editCalled).toBe(false);
  });

  /**
   * The shape a labeled query result stores, built by hand: the row is its own
   * entity doc and carries the per-column label, the query doc only LINKS to
   * it, and the piece result links to the query doc. So `q/result/0/secret`
   * crosses a link at `result/0` — the path `cf cell get-label` is asked
   * about on a sqlite-backed panel, and the one the reader has to resolve.
   */
  const buildCrossingChain = async (prefix: string) => {
    const row = runtime.getCell<{ secret: string; shouted: string }>(
      signer.did(),
      `${prefix}-row`,
      {
        type: "object",
        additionalProperties: true,
        properties: {
          secret: { type: "string", ifc: { confidentiality: ["finance"] } },
          shouted: {
            type: "string",
            ifc: { confidentiality: ["finance"], observes: "value" },
          },
        },
      },
    );
    const t1 = runtime.edit();
    row.withTx(t1).set({ secret: "top secret", shouted: "TOP SECRET" });
    runtime.prepareTxForCommit(t1);
    expect((await t1.commit().settled).error).toBeUndefined();

    const query = runtime.getCell<never>(
      signer.did(),
      `${prefix}-query`,
      undefined,
    );
    const t2 = runtime.edit();
    query.withTx(t2).key("result").key(0).setRawUntyped(row.getAsLink());
    runtime.prepareTxForCommit(t2);
    expect((await t2.commit().settled).error).toBeUndefined();

    const chainRoot = runtime.getCell<never>(
      signer.did(),
      `${prefix}-root`,
      undefined,
    );
    const t3 = runtime.edit();
    chainRoot.withTx(t3).key("q").setRawUntyped(query.getAsLink());
    runtime.prepareTxForCommit(t3);
    expect((await t3.commit().settled).error).toBeUndefined();

    const chainPiece = {
      input: { getCell: () => Promise.resolve(chainRoot) },
      result: { getCell: () => Promise.resolve(chainRoot) },
    };
    const chainDeps = {
      loadPieces: () =>
        Promise.resolve({
          runtime,
          get: () => Promise.resolve(chainPiece),
          synced: () => Promise.resolve(),
        }),
      resolvePieceAddress: (_pieces: unknown, token: string) =>
        Promise.resolve(token),
    };
    return { row, query, chainRoot, chainDeps };
  };

  it("get-label reports a label behind a link the path CROSSES", async () => {
    const { chainDeps } = await buildCrossingChain("cf-piece-label-crossing");

    const atColumn = await getCellCfcLabel(
      pieceConfig,
      ["q", "result", 0, "secret"],
      {},
      chainDeps as never,
    );
    expect(atColumn?.entries).toEqual([
      { path: [], label: { confidentiality: ["finance"] } },
    ]);

    // Selecting the ROW reports one entry per labeled column.
    const atRow = await getCellCfcLabel(
      pieceConfig,
      ["q", "result", 0],
      {},
      chainDeps as never,
    );
    expect(
      atRow?.entries.find((entry) => entry.path[0] === "secret")?.label
        .confidentiality,
    ).toEqual(["finance"]);
  });

  it("renders that same label through the get-label command", async () => {
    const { chainDeps } = await buildCrossingChain("cf-piece-label-cmd");
    const rendered: unknown[] = [];

    await getCellCfcLabelFromCommand(
      {
        apiUrl: "https://example.com",
        identity: "/identity.key",
        space: signer.did(),
        cell: "piece",
        quiet: true,
      },
      "q/result/0/secret",
      {
        // The real reader, reaching this test's runtime through its deps —
        // the command's own wiring, not a stub standing in for it.
        getCellCfcLabel:
          ((config: never, path: never, options: never) =>
            getCellCfcLabel(
              config,
              path,
              options,
              chainDeps as never,
            )) as never,
        render: (value: unknown) => {
          rendered.push(value);
        },
      },
    );

    expect(rendered).toEqual([{
      version: 1,
      entries: [{ path: [], label: { confidentiality: ["finance"] } }],
    }]);
  });

  it("set-label preserves the class the WRITE will land beside", async () => {
    // The write resolves the links the path crosses, so this update lands in
    // the row doc beside its `observes: "value"` entry. Addressed through the
    // crossing path it must do what it does addressed at the row itself:
    // preserve the class, and return the label it wrote.
    const { row, chainDeps } = await buildCrossingChain("cf-piece-label-set");

    const updated = await setCellCfcLabel(
      pieceConfig,
      ["q", "result", 0, "shouted"],
      { confidentiality: ["finance", "team"] },
      {},
      chainDeps as never,
    );

    expect(updated?.entries).toEqual([
      {
        path: [],
        label: { confidentiality: ["finance", "team"] },
        observes: "value",
      },
    ]);
    await row.pull();
    const stored = cfcLabelViewForCell(row)?.entries.find((entry) =>
      entry.path[0] === "shouted"
    );
    expect(stored?.observes).toBe("value");
    expect(stored?.label.confidentiality).toEqual(["finance", "team"]);
  });

  it("set-label REFUSES a class the resolved doc already contradicts", async () => {
    // The other half of reading the doc the write lands in. Preservation shows
    // the guard sees the row doc's class; this shows it ACTS on it. Asking for
    // `shape` where the row doc declares `value` is the conflict the CLI exists
    // to refuse, and against the unresolved view the guard could not see it —
    // the write went through and replaced the class instead.
    const { row, chainDeps } = await buildCrossingChain(
      "cf-piece-label-refuse",
    );

    await expect(setCellCfcLabel(
      pieceConfig,
      ["q", "result", 0, "shouted"],
      { confidentiality: ["finance", "team"], observes: "shape" },
      {},
      chainDeps as never,
    )).rejects.toThrow('Cannot set observes to "shape"');

    // Refused means nothing was written.
    await row.pull();
    const stored = cfcLabelViewForCell(row)?.entries.find((entry) =>
      entry.path[0] === "shouted"
    );
    expect(stored?.observes).toBe("value");
    expect(stored?.label.confidentiality).toEqual(["finance"]);
  });

  describe("lowering confidentiality", () => {
    // Every clause here names the signer alone unless a case says otherwise,
    // so the refusals a case pins come from what it varies.
    const owner = cfcAtom.personalSpace(signer.did());
    const lower = { lowerConfidentiality: true };

    /** Labels the root's `body` with `confidentiality`, the ordinary way. */
    const declareOnBody = (confidentiality: unknown[]) =>
      setCellCfcLabel(
        pieceConfig,
        ["body"],
        { confidentiality, observes: "value" },
        {},
        deps as never,
      );

    /** Writes `body` again in a transaction that reads nothing labeled. */
    const rewriteBody = async (body: string) => {
      const tx = runtime.edit();
      root.withTx(tx).key("body").set(body);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
    };

    /**
     * A user-scoped document written in a transaction that read the
     * signer's personal data, so its root carries the derived `shape` and
     * `value` entries such a write stamps, and the piece dependencies that
     * select it.
     */
    const derivedQueue = async () => {
      const secret = runtime.getCell<{ text: string }>(
        signer.did(),
        "cf-piece-label-personal-secret",
        {
          type: "object",
          ifc: { confidentiality: [owner] },
          properties: { text: { type: "string" } },
        },
      );
      const seed = runtime.edit();
      secret.withTx(seed).set({ text: "personal" });
      runtime.prepareTxForCommit(seed);
      expect((await seed.commit().settled).error).toBeUndefined();
      const schema = {
        type: "object",
        properties: { items: { type: "array", items: { type: "string" } } },
      } as const;
      const base = runtime.getCell(
        signer.did(),
        "cf-piece-label-queue",
        schema,
      );
      const queue = runtime.getCellFromLink(
        { ...base.getAsNormalizedFullLink(), scope: "user" },
        schema,
      );
      const derive = runtime.edit();
      const read = secret.withTx(derive).get();
      queue.withTx(derive).set({ items: [read.text.toUpperCase()] });
      runtime.prepareTxForCommit(derive);
      expect((await derive.commit().settled).error).toBeUndefined();
      const queueDeps = {
        ...deps,
        loadPieces: () =>
          Promise.resolve({
            runtime,
            get: () =>
              Promise.resolve({
                input: { getCell: () => Promise.resolve(queue) },
                result: { getCell: () => Promise.resolve(queue) },
              }),
            synced: () => Promise.resolve(),
          }),
      };
      return { queue, queueDeps };
    };

    it("refuses to drop a declared clause without the flag, and keeps it", async () => {
      await declareOnBody([owner]);

      await expect(setCellCfcLabel(
        pieceConfig,
        ["body"],
        { confidentiality: [] },
        {},
        deps as never,
      )).rejects.toThrow("confidentiality cannot be weakened");
      expect(
        await getCellCfcLabel(pieceConfig, ["body"], {}, deps as never),
      ).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: { confidentiality: [owner] },
          observes: "value",
        }],
      });
    });

    it("removes a declared clause with the flag, and a later declaration does not restore it", async () => {
      await declareOnBody([owner]);

      expect(
        await setCellCfcLabel(
          pieceConfig,
          ["body"],
          { confidentiality: [] },
          lower,
          deps as never,
        ),
      ).toBeNull();
      // A declaration merges into the stored schema and re-mints the label
      // from the merge, so the clause staying gone shows the stored schema
      // lost it too.
      await rewriteBody("rewritten");
      expect(await declareOnBody([cfcAtom.user(signer.did())])).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: { confidentiality: [cfcAtom.user(signer.did())] },
          observes: "value",
        }],
      });
    });

    it("keeps the clauses the input names and removes the others", async () => {
      await declareOnBody([owner, cfcAtom.user(signer.did())]);

      const updated = await setCellCfcLabel(
        pieceConfig,
        ["body"],
        { confidentiality: [cfcAtom.user(signer.did())] },
        lower,
        deps as never,
      );

      expect(updated).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: { confidentiality: [cfcAtom.user(signer.did())] },
          observes: "value",
        }],
      });
    });

    it("refuses the derived shape and value entries without the flag", async () => {
      const { queueDeps } = await derivedQueue();
      const stamped = {
        version: 1,
        entries: [
          { path: [], label: { confidentiality: [owner] }, observes: "shape" },
          { path: [], label: { confidentiality: [owner] }, observes: "value" },
        ],
      };
      expect(await getCellCfcLabel(pieceConfig, [], {}, queueDeps as never))
        .toEqual(stamped);

      await expect(setCellCfcLabel(
        pieceConfig,
        [],
        { confidentiality: [] },
        {},
        queueDeps as never,
      )).rejects.toThrow("multiple observation classes");
      await expect(setCellCfcLabel(
        pieceConfig,
        [],
        { confidentiality: [], observes: "value" },
        {},
        queueDeps as never,
      )).rejects.toThrow("already uses a different observation class");
      expect(await getCellCfcLabel(pieceConfig, [], {}, queueDeps as never))
        .toEqual(stamped);
    });

    it("clears the derived shape and value entries with the flag, and keeps the label-metadata templates", async () => {
      const { queue, queueDeps } = await derivedQueue();
      const templates = () => {
        const tx = runtime.edit();
        try {
          return readStoredCfcMetadata(tx, queue.getAsNormalizedFullLink())
            ?.labelMap.documentEntries;
        } finally {
          tx.abort();
        }
      };
      const before = templates();
      expect(before?.length).toBeGreaterThan(0);

      expect(
        await setCellCfcLabel(
          pieceConfig,
          [],
          { confidentiality: [] },
          lower,
          queueDeps as never,
        ),
      ).toBeNull();
      const overwrite = runtime.edit();
      queue.withTx(overwrite).set({ items: ["clean"] });
      runtime.prepareTxForCommit(overwrite);
      expect((await overwrite.commit().settled).error).toBeUndefined();
      expect(await getCellCfcLabel(pieceConfig, [], {}, queueDeps as never))
        .toBeNull();
      expect(templates()).toEqual(before);
    });

    it("lowers the label in the doc a write redirect lands in", async () => {
      const linked = runtime.getCell<string>(
        signer.did(),
        "cf-piece-label-lowered-redirect-target",
        { type: "string" },
      );
      const seed = runtime.edit();
      linked.withTx(seed).set("redirected value");
      root.withTx(seed).key("body").setRawUntyped(
        linked.getAsWriteRedirectLink({ includeSchema: true }),
      );
      runtime.prepareTxForCommit(seed);
      expect((await seed.commit().settled).error).toBeUndefined();
      await declareOnBody([owner]);
      expect(cfcLabelViewForCell(linked)?.entries[0].label.confidentiality)
        .toEqual([owner]);

      await setCellCfcLabel(
        pieceConfig,
        ["body"],
        { confidentiality: [] },
        lower,
        deps as never,
      );

      await linked.pull();
      expect(cfcLabelViewForCell(linked)).toBeUndefined();
    });

    it("refuses a clause that names anyone but the identity, and keeps it", async () => {
      const other = (await Identity.fromPassphrase("cf-piece-label-other"))
        .did();
      // Each round stores one more clause and asks to remove only that one,
      // so each refusal is that clause's.
      const stored: unknown[] = [];
      for (
        const clause of [
          "team",
          cfcAtom.user(other),
          { anyOf: [cfcAtom.user(signer.did()), cfcAtom.user(other)] },
        ]
      ) {
        const kept = [...stored];
        stored.push(clause);
        await declareOnBody(stored);

        await expect(setCellCfcLabel(
          pieceConfig,
          ["body"],
          { confidentiality: kept },
          lower,
          deps as never,
        )).rejects.toThrow(`is not ${signer.did()}'s alone to release`);
      }
      expect(
        (await getCellCfcLabel(pieceConfig, ["body"], {}, deps as never))
          ?.entries[0].label.confidentiality,
      ).toHaveLength(3);
    });

    it("refuses a document in a space whose DID is not the identity's, and keeps its label", async () => {
      const space = (await Identity.fromPassphrase("cf-piece-label-space"))
        .did();
      const elsewhere = runtime.getCell<{ body: string }>(
        space,
        "cf-piece-label-elsewhere",
        {
          type: "object",
          properties: {
            body: { type: "string", ifc: { confidentiality: [owner] } },
          },
        },
      );
      const seed = runtime.edit();
      elsewhere.withTx(seed).set({ body: "hello" });
      runtime.prepareTxForCommit(seed);
      expect((await seed.commit().settled).error).toBeUndefined();
      const elsewhereDeps = {
        ...deps,
        loadPieces: () =>
          Promise.resolve({
            runtime,
            get: () =>
              Promise.resolve({
                input: { getCell: () => Promise.resolve(elsewhere) },
                result: { getCell: () => Promise.resolve(elsewhere) },
              }),
            synced: () => Promise.resolve(),
          }),
      };
      const config = { ...pieceConfig, space };

      await expect(setCellCfcLabel(
        config,
        ["body"],
        { confidentiality: [] },
        lower,
        elsewhereDeps as never,
      )).rejects.toThrow("only in their own space");
      expect(
        (await getCellCfcLabel(config, ["body"], {}, elsewhereDeps as never))
          ?.entries[0].label.confidentiality,
      ).toEqual([owner]);
    });

    it("refuses an input naming a clause the path does not store", async () => {
      await declareOnBody([owner]);

      await expect(setCellCfcLabel(
        pieceConfig,
        ["body"],
        { confidentiality: [owner, cfcAtom.user(signer.did())] },
        lower,
        deps as never,
      )).rejects.toThrow("the path stores no such clause");
      expect(
        (await getCellCfcLabel(pieceConfig, ["body"], {}, deps as never))
          ?.entries[0].label.confidentiality,
      ).toEqual([owner]);
    });

    it("refuses a lowering input that is not a confidentiality list alone", async () => {
      await declareOnBody([owner]);

      for (
        const input of [
          { integrity: [] },
          { confidentiality: [], integrity: [] },
          { confidentiality: [], observes: "value" },
        ]
      ) {
        await expect(setCellCfcLabel(
          pieceConfig,
          ["body"],
          input,
          lower,
          deps as never,
        )).rejects.toThrow("Lowering confidentiality");
      }
      expect(
        (await getCellCfcLabel(pieceConfig, ["body"], {}, deps as never))
          ?.entries[0].label.confidentiality,
      ).toEqual([owner]);
    });

    it("passes the flag from the command line to the update", async () => {
      const calls: unknown[][] = [];
      const run = (options: Record<string, unknown>) =>
        setCellCfcLabelFromCommand(
          {
            apiUrl: "https://example.com",
            identity: "/identity.key",
            space: signer.did(),
            cell: "piece",
            quiet: true,
            ...options,
          },
          "queue",
          {
            drainStdin: () => Promise.resolve({ confidentiality: [] }),
            setCellCfcLabel: ((...args: unknown[]) => {
              calls.push(args);
              return Promise.resolve(null);
            }) as never,
            render: () => {},
          },
        );

      await run({ dangerouslyAllowLoweringConfidentiality: true });
      await run({});

      expect(calls.map((call) => call[3])).toEqual([
        { input: undefined, lowerConfidentiality: true },
        { input: undefined },
      ]);
    });
  });

  it("documents JSON input and output on both commands", async () => {
    const getHelp = await cf(argv`cell get-label --help`);
    expect(getHelp.code).toBe(0);
    expect(stripAnsi(getHelp.stdout.join("\n"))).toContain(
      "effective CFC label view",
    );
    expect(stripAnsi(getHelp.stdout.join("\n"))).toContain("--json");

    const setHelp = await cf(argv`cell set-label --help`);
    expect(setHelp.code).toBe(0);
    const text = stripAnsi(setHelp.stdout.join("\n"));
    expect(text).toContain("from JSON on stdin");
    expect(text).toMatch(
      /confidentiality\s+may only become\s+more restrictive/,
    );
    expect(text).toContain("--dangerously-allow-lowering-confidentiality");
    expect(text).toContain("--json");
  });
});
