/**
 * The agent result writer turns a run's structured result into a document in
 * the run's space: every handle the result names becomes a link, a referent
 * that is not a cell becomes a labeled document of its own, and the text the
 * model authored carries the join the writing transaction derived from the
 * cells it read. These tests run the writer over an in-memory runtime at the
 * enforcement rung the harness's fabric session runs at, and read every label
 * they assert back through the runtime's own label view.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model";
import { cfcAtom } from "@commonfabric/api/cfc";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { type Cell, parseLink, Runtime } from "@commonfabric/runner";
import { cfcLabelViewForCell } from "@commonfabric/runner/cfc";
import {
  type NormalizedFullLink,
  renderCellReference,
} from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { HarnessHandleTable } from "../src/contracts/handle-table.ts";
import type { HarnessFabricSession } from "../src/fabric-session.ts";
import {
  createHarnessHandleTable,
  mintAddressHandle,
} from "../src/handle-table.ts";
import {
  type AgentObservedHandle,
  agentResultCommitFailure,
  agentResultReferentCause,
  AgentResultWriteError,
  writeAgentResult,
} from "../src/result-writer.ts";
import { seedStoredEnvelope } from "../../runner/test/cfc-seed-envelope.ts";
import { isSealedOpaqueLinkObject } from "../src/structured-result.ts";

const signer = await Identity.fromPassphrase("cf-harness result-writer");

const FINANCE = "https://cfc.test/atom/finance";
const HEALTH = "https://cfc.test/atom/health";
const LOOM_ROW = "https://cfc.test/atom/loom-row";
const CONNECTOR_OBSERVED = "https://cfc.test/atom/connector-observed";

/** A token of the value-handle grammar the table reserves and does not mint. */
const ROW_TOKEN = "cfh:v:hit1";

const RUN_ID = "run-result-writer";

/** The shape of a book cell, labeled at its root with `atom`. */
const bookSchema = (atom: string): JSONSchema => ({
  type: "object",
  properties: { title: { type: "string" } },
  ifc: { confidentiality: [atom] },
});

/** The result shape the tests write: two picks and one retrieved source. */
const RESULT_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          book: { type: "object", asCell: ["cell"] },
          why: { type: "string" },
        },
        required: ["book", "why"],
        additionalProperties: false,
      },
    },
    source: { type: "object", asCell: ["cell"] },
  },
  required: ["summary", "picks", "source"],
  additionalProperties: false,
};

const ROW_VALUE = { title: "A page about ledgers", snippet: "ledgers..." };

const rowReferent = (token = ROW_TOKEN): AgentObservedHandle => ({
  kind: "document",
  token,
  value: ROW_VALUE,
  label: { confidentiality: [LOOM_ROW], integrity: [CONNECTOR_OBSERVED] },
});

describe("writeAgentResult()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let session: HarnessFabricSession;
  let space: ReturnType<PiecesController["getSpace"]>;
  let bookA: NormalizedFullLink;
  let bookB: NormalizedFullLink;
  let tokenA: string;
  let tokenB: string;
  let handleTable: HarnessHandleTable;

  /** Writes a labeled book cell and returns its link. */
  const seedBook = async (
    name: string,
    title: string,
    atom: string,
  ): Promise<NormalizedFullLink> => {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, name, bookSchema(atom), tx);
    cell.set({ title });
    expect((await tx.commit()).error).toBeUndefined();
    return cell.getAsNormalizedFullLink();
  };

  /** Every confidentiality clause the runtime's label view holds at `path`. */
  const confidentialityOf = async (
    link: NormalizedFullLink,
    ...path: string[]
  ): Promise<unknown[]> => {
    const root = runtime.getCellFromLink(link);
    await root.sync();
    const cell = path.length === 0 ? root : root.key(...path);
    return (cfcLabelViewForCell(cell)?.entries ?? []).flatMap((entry) =>
      entry.label.confidentiality ?? []
    );
  };

  /** Every integrity atom the runtime's label view holds at `link`. */
  const integrityOf = async (link: NormalizedFullLink): Promise<unknown[]> => {
    const cell = runtime.getCellFromLink(link);
    await cell.sync();
    return (cfcLabelViewForCell(cell)?.entries ?? []).flatMap((entry) =>
      entry.label.integrity ?? []
    );
  };

  /** Whether a document exists at `cause` in the session's space. */
  const documentExists = (cause: unknown): boolean =>
    runtime.getCell(space, cause).get() !== undefined;

  const cellHandles = (): AgentObservedHandle[] => [
    { kind: "cell", token: tokenA },
    { kind: "cell", token: tokenB },
  ];

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      // The rung the harness's fabric session runs at: a tainted write lands
      // only where the target declares a policy covering the join, and the
      // derived join is persisted so a later read sees it.
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    const pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `result-writer-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await pieces.synced();
    session = { pieces };
    space = pieces.getSpace();
    bookA = await seedBook("book-a", "Ledgers", FINANCE);
    bookB = await seedBook("book-b", "Anatomy", HEALTH);
    const mintedA = await mintAddressHandle(
      createHarnessHandleTable(RUN_ID),
      renderCellReference(bookA),
    );
    const mintedB = await mintAddressHandle(
      mintedA.table,
      renderCellReference(bookB),
    );
    handleTable = mintedB.table;
    tokenA = mintedA.token;
    tokenB = mintedB.token;
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("writes one result document whose handles are links, whose text carries the derived join, and which carries `LlmDerived`", async () => {
    const written = await writeAgentResult({
      session,
      handleTable,
      resultSchema: RESULT_SCHEMA,
      structuredResult: {
        summary: "Two books, one on ledgers and one on anatomy.",
        picks: [
          { book: tokenA, why: "Covers ledgers." },
          { book: tokenB, why: "Covers anatomy." },
        ],
        source: ROW_TOKEN,
      },
      // The same cell observed twice is read once.
      observedHandles: [
        ...cellHandles(),
        { kind: "cell", token: tokenA },
        rowReferent(),
      ],
      maxConfidentiality: [FINANCE, HEALTH, LOOM_ROW],
      cause: "result-links",
    });

    // Three links, one per handle: two to the book cells and one to the
    // document minted for the retrieved row.
    const result = runtime.getCellFromLink(written.link, RESULT_SCHEMA);
    await result.sync();
    const value = result.get() as {
      summary: string;
      picks: { book: Cell<unknown>; why: string }[];
      source: Cell<unknown>;
    };
    expect(value.summary).toBe("Two books, one on ledgers and one on anatomy.");
    expect(value.picks.map((pick) => pick.book.getAsNormalizedFullLink().id))
      .toEqual([bookA.id, bookB.id]);
    expect(written.mintedDocuments).toHaveLength(1);
    expect(written.mintedDocuments[0].token).toBe(ROW_TOKEN);
    const rowLink = written.mintedDocuments[0].link;
    expect(value.source.getAsNormalizedFullLink().id).toBe(rowLink.id);
    expect(written.sealedPaths).toEqual([]);

    // The targets keep their own labels: nothing wrote to them.
    expect(await confidentialityOf(bookA)).toEqual([FINANCE]);
    expect(await confidentialityOf(bookB)).toEqual([HEALTH]);

    // The minted row document carries the row's label and the row's value.
    const row = runtime.getCellFromLink(rowLink);
    await row.sync();
    expect(row.get()).toEqual(ROW_VALUE);
    expect(await confidentialityOf(rowLink)).toEqual([LOOM_ROW]);
    expect(await integrityOf(rowLink)).toContainEqual(CONNECTOR_OBSERVED);

    // The inline text carries the join of everything the run observed.
    const summaryLabel = await confidentialityOf(written.link, "summary");
    expect(summaryLabel).toContainEqual(FINANCE);
    expect(summaryLabel).toContainEqual(HEALTH);
    expect(summaryLabel).toContainEqual(LOOM_ROW);
    expect(written.joinLabel.confidentiality).toContainEqual(FINANCE);
    expect(written.joinLabel.confidentiality).toContainEqual(HEALTH);
    expect(written.joinLabel.confidentiality).toContainEqual(LOOM_ROW);

    // The result carries the runtime-minted `LlmDerived` family.
    expect(await integrityOf(written.link)).toContainEqual(
      cfcAtom.llmDerived(),
    );
    expect(written.joinLabel.integrity).toContainEqual(cfcAtom.llmDerived());
  });

  it("fails with `unheld_handle` before any write when the result names a handle the run does not hold", async () => {
    const unheld = "cfh:a:22222";
    const failure = await writeAgentResult({
      session,
      handleTable,
      resultSchema: RESULT_SCHEMA,
      structuredResult: {
        summary: "One book.",
        picks: [{ book: unheld, why: "Made up." }],
        source: ROW_TOKEN,
      },
      observedHandles: [...cellHandles(), rowReferent()],
      maxConfidentiality: [FINANCE, HEALTH, LOOM_ROW],
      cause: "result-unheld",
    }).then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(AgentResultWriteError);
    expect((failure as AgentResultWriteError).code).toBe("unheld_handle");
    expect(documentExists("result-unheld")).toBe(false);
    expect(documentExists(agentResultReferentCause("result-unheld", ROW_TOKEN)))
      .toBe(false);
  });

  it("fails with `unheld_handle` for a well-formed token embedded in prose that the run does not hold", async () => {
    const failure = await writeAgentResult({
      session,
      handleTable,
      resultSchema: RESULT_SCHEMA,
      structuredResult: {
        summary: "See cfh:a:33333 for the rest.",
        picks: [{ book: tokenA, why: "Covers ledgers." }],
        source: ROW_TOKEN,
      },
      observedHandles: [...cellHandles(), rowReferent()],
      maxConfidentiality: [FINANCE, HEALTH, LOOM_ROW],
      cause: "result-unheld-prose",
    }).then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(AgentResultWriteError);
    expect((failure as AgentResultWriteError).code).toBe("unheld_handle");
    expect(documentExists("result-unheld-prose")).toBe(false);
  });

  it("writes a link for a handle at a position the schema does not mark `asCell`, whether written as a token or as its canonical link string", async () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        note: { type: "string" },
        first: { type: "string" },
        second: { type: "string" },
      },
      required: ["note", "first", "second"],
      additionalProperties: false,
    };
    const written = await writeAgentResult({
      session,
      handleTable,
      resultSchema: schema,
      structuredResult: {
        note: "Both are worth reading.",
        first: tokenA,
        second: renderCellReference(bookB),
      },
      observedHandles: cellHandles(),
      maxConfidentiality: [FINANCE, HEALTH],
      cause: "result-plain-positions",
    });

    const result = runtime.getCellFromLink(written.link);
    await result.sync();
    expect(parseLink(result.key("first").getRaw())?.id).toBe(bookA.id);
    expect(parseLink(result.key("second").getRaw())?.id).toBe(bookB.id);
    expect(result.key("note").getRaw()).toBe("Both are worth reading.");
  });

  it("seals a handle at an `asCell` position whose referent is labeled above the ceiling that position declares", async () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        summary: { type: "string" },
        // A position that admits public content only.
        source: {
          type: "object",
          asCell: ["cell"],
          ifc: { maxConfidentiality: [] },
        },
      },
      required: ["summary", "source"],
      additionalProperties: false,
    };
    const written = await writeAgentResult({
      session,
      handleTable,
      resultSchema: {
        ...schema,
        properties: {
          ...(schema as { properties: Record<string, JSONSchema> }).properties,
          // The same ceiling over a non-cell referent.
          row: {
            type: "object",
            asCell: ["cell"],
            ifc: { maxConfidentiality: [] },
          },
        },
      },
      structuredResult: {
        summary: "A book on ledgers.",
        source: tokenA,
        row: ROW_TOKEN,
      },
      observedHandles: [{ kind: "cell", token: tokenA }, rowReferent()],
      maxConfidentiality: [FINANCE, LOOM_ROW],
      cause: "result-sealed",
    });

    expect(written.sealedPaths).toEqual([["source"], ["row"]]);
    expect(isSealedOpaqueLinkObject(
      await (async () => {
        const cell = runtime.getCellFromLink(written.link);
        await cell.sync();
        return cell.key("row").getRaw();
      })(),
    )).toBe(true);
    const result = runtime.getCellFromLink(written.link);
    await result.sync();
    const source = result.key("source").getRaw();
    expect(isSealedOpaqueLinkObject(source)).toBe(true);
    expect(parseLink(source)).toBeUndefined();
    expect(await confidentialityOf(bookA)).toEqual([FINANCE]);
  });

  it("fails with `cfc_commit_refused` and no label detail when the derived join does not fit the declared ceiling", async () => {
    const failure = await writeAgentResult({
      session,
      handleTable,
      resultSchema: RESULT_SCHEMA,
      structuredResult: {
        summary: "Two books.",
        picks: [
          { book: tokenA, why: "Covers ledgers." },
          { book: tokenB, why: "Covers anatomy." },
        ],
        source: ROW_TOKEN,
      },
      // The run observed the anatomy book, which the ceiling does not admit,
      // so the transaction's own join is what refuses the commit.
      observedHandles: [...cellHandles(), rowReferent()],
      maxConfidentiality: [FINANCE, LOOM_ROW],
      cause: "result-refused",
    }).then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(AgentResultWriteError);
    const error = failure as AgentResultWriteError;
    expect(error.code).toBe("cfc_commit_refused");
    expect(error.message).not.toContain(HEALTH);
    expect(error.message).not.toContain(FINANCE);
    expect(error.refusals?.length ?? 0).toBeGreaterThan(0);
    expect(documentExists("result-refused")).toBe(false);
  });

  it("fails with `invalid_result` when the result does not satisfy the schema", async () => {
    const failure = await writeAgentResult({
      session,
      handleTable,
      resultSchema: RESULT_SCHEMA,
      structuredResult: { summary: 7, picks: [], source: ROW_TOKEN },
      observedHandles: [rowReferent()],
      maxConfidentiality: [LOOM_ROW],
      cause: "result-invalid",
    }).then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(AgentResultWriteError);
    expect((failure as AgentResultWriteError).code).toBe("invalid_result");
    expect(documentExists("result-invalid")).toBe(false);
  });

  describe("handles the run cannot link", () => {
    /** The writer's failure for `structuredResult` over `table`. */
    const failureFor = async (
      table: HarnessHandleTable,
      structuredResult: unknown,
      observedHandles: AgentObservedHandle[] = [],
    ): Promise<AgentResultWriteError> => {
      const failure = await writeAgentResult({
        session,
        handleTable: table,
        resultSchema: {
          type: "object",
          properties: {
            note: { type: "string" },
            extras: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
          required: ["note"],
          additionalProperties: false,
        },
        structuredResult,
        observedHandles,
        maxConfidentiality: [FINANCE, HEALTH],
        cause: "result-unlinkable",
      }).then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(AgentResultWriteError);
      expect(documentExists("result-unlinkable")).toBe(false);
      return failure as AgentResultWriteError;
    };

    it("fails with `unheld_handle` for a handle held for skill context only", async () => {
      const minted = await mintAddressHandle(
        handleTable,
        "/of:fid1:" + "S".repeat(43) + "/skill",
        { capability: "skill-context" },
      );

      const failure = await failureFor(minted.table, { note: minted.token });

      expect(failure.code).toBe("unheld_handle");
    });

    it("fails with `unheld_handle` for an unheld token used as a property name", async () => {
      const failure = await failureFor(handleTable, {
        note: "keyed",
        extras: { "cfh:a:44444": "x" },
      });

      expect(failure.code).toBe("unheld_handle");
    });

    it("fails with `unheld_handle` for an unheld token inside a property name", async () => {
      const failure = await failureFor(handleTable, {
        note: "keyed",
        extras: { "see cfh:a:77777 here": "x" },
      });

      expect(failure.code).toBe("unheld_handle");
    });

    it("fails with `unheld_handle` for an observed cell handle whose token names a non-cell referent", async () => {
      const failure = await failureFor(handleTable, { note: "plain" }, [
        { kind: "cell", token: ROW_TOKEN },
        rowReferent(),
      ]);

      expect(failure.code).toBe("unheld_handle");
    });

    it("fails with `unheld_handle` for an observed handle the table does not hold", async () => {
      const failure = await failureFor(handleTable, { note: "plain" }, [
        { kind: "cell", token: "cfh:a:55555" },
      ]);

      expect(failure.code).toBe("unheld_handle");
    });

    it("fails with `unresolvable_handle` for a handle naming a cell in another space", async () => {
      const minted = await mintAddressHandle(
        handleTable,
        renderCellReference({ ...bookA, space: signer.did() }),
      );

      const failure = await failureFor(minted.table, { note: minted.token });

      expect(failure.code).toBe("unresolvable_handle");
    });

    it("fails with `unresolvable_handle` for a table entry whose address does not parse", async () => {
      const token = "cfh:a:66666";
      const table: HarnessHandleTable = {
        ...handleTable,
        entries: [...handleTable.entries, {
          token,
          kind: "address",
          ref: "not an address",
          addressKey: "not-an-address",
        }],
      };

      const failure = await failureFor(table, { note: token });

      expect(failure.code).toBe("unresolvable_handle");
    });
  });

  it("resolves handles at positions governed through `additionalProperties`, `prefixItems`, `allOf`, `anyOf`, and the `@link` object form", async () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        extras: { type: "object", additionalProperties: { type: "string" } },
        pair: {
          type: "array",
          prefixItems: [{ type: "string" }, { type: "string" }],
        },
        // The branch a token satisfies is the one whose ceiling governs.
        either: {
          anyOf: [
            { type: "number" },
            {
              type: "object",
              asCell: ["cell"],
              ifc: { maxConfidentiality: [] },
            },
          ],
        },
        // The second branch's ceiling reaches the position through `allOf`.
        both: {
          allOf: [
            {
              type: "object",
              properties: { book: { type: "object", asCell: ["cell"] } },
            },
            {
              type: "object",
              properties: { book: { ifc: { maxConfidentiality: [] } } },
            },
          ],
        },
        // A ceiling inside an alternative beneath an `allOf` branch.
        nested: {
          allOf: [
            { type: "object", asCell: ["cell"] },
            {
              anyOf: [
                { type: "number" },
                { ifc: { maxConfidentiality: [] } },
              ],
            },
          ],
        },
        viaLink: { type: "object", asCell: ["cell"] },
      },
      required: ["extras", "pair", "either", "both", "nested", "viaLink"],
      additionalProperties: false,
    };
    const written = await writeAgentResult({
      session,
      handleTable,
      resultSchema: schema,
      structuredResult: {
        extras: { one: tokenA },
        pair: [tokenB, "plain"],
        either: tokenA,
        both: { book: tokenB },
        nested: tokenA,
        viaLink: { "@link": tokenA },
      },
      observedHandles: cellHandles(),
      maxConfidentiality: [FINANCE, HEALTH],
      cause: "result-positions",
    });

    expect(written.sealedPaths).toEqual([
      ["either"],
      ["both", "book"],
      ["nested"],
    ]);
    const result = runtime.getCellFromLink(written.link);
    await result.sync();
    expect(parseLink(result.key("extras").key("one").getRaw())?.id).toBe(
      bookA.id,
    );
    const pair = result.key("pair").getRaw() as unknown[];
    expect(parseLink(pair[0])?.id).toBe(bookB.id);
    expect(pair[1]).toBe("plain");
    expect(isSealedOpaqueLinkObject(result.key("either").getRaw())).toBe(true);
    expect(isSealedOpaqueLinkObject(result.key("both").key("book").getRaw()))
      .toBe(true);
    expect(parseLink(result.key("viaLink").getRaw())?.id).toBe(bookA.id);
  });

  it("seals a handle whose referent's label cannot be read, at a position declaring a ceiling", async () => {
    // A cell whose stored CFC metadata is of a version this build cannot
    // read has no label the writer can measure, and a measurement that could
    // not be taken proves no fit: the position is sealed rather than linked.
    const seed = runtime.edit();
    const unreadable = runtime.getCell(
      space,
      "unreadable-label",
      undefined,
      seed,
    );
    const id = unreadable.getAsNormalizedFullLink().id;
    seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
      value: { title: "Unlabeled" },
      cfc: { version: 99 },
    } as unknown as FabricValue);
    expect((await seed.commit()).error).toBeUndefined();
    const minted = await mintAddressHandle(
      handleTable,
      renderCellReference(unreadable.getAsNormalizedFullLink()),
    );

    const written = await writeAgentResult({
      session,
      handleTable: minted.table,
      resultSchema: {
        type: "object",
        properties: {
          source: {
            type: "object",
            asCell: ["cell"],
            ifc: { maxConfidentiality: [FINANCE] },
          },
        },
        required: ["source"],
        additionalProperties: false,
      },
      structuredResult: { source: minted.token },
      observedHandles: [],
      maxConfidentiality: [],
      cause: "result-unreadable",
    });

    expect(written.sealedPaths).toEqual([["source"]]);
  });

  it("resolves handles beneath boolean subschemas and through `allOf` branches on the way to a link", async () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        loose: { type: "object", additionalProperties: true },
        both: {
          allOf: [
            {
              type: "object",
              properties: { book: { type: "object", asCell: ["cell"] } },
            },
            { type: "object", properties: { book: true } },
          ],
        },
        list: {
          allOf: [
            { type: "array", items: { type: "object", asCell: ["cell"] } },
            { type: "array" },
          ],
        },
      },
      required: ["loose", "both", "list"],
      additionalProperties: false,
    };
    const written = await writeAgentResult({
      session,
      handleTable,
      resultSchema: schema,
      structuredResult: {
        loose: { inner: { a: tokenA }, items: [tokenB] },
        both: { book: tokenA },
        list: [tokenB],
      },
      observedHandles: cellHandles(),
      maxConfidentiality: [FINANCE, HEALTH],
      cause: "result-loose",
    });

    expect(written.sealedPaths).toEqual([]);
    const result = runtime.getCellFromLink(written.link);
    await result.sync();
    const loose = result.key("loose").getRaw() as {
      inner: { a: unknown };
      items: unknown[];
    };
    expect(parseLink(loose.inner.a)?.id).toBe(bookA.id);
    expect(parseLink(loose.items[0])?.id).toBe(bookB.id);
    expect(parseLink(result.key("both").key("book").getRaw())?.id).toBe(
      bookA.id,
    );
    const list = result.key("list").getRaw() as unknown[];
    expect(parseLink(list[0])?.id).toBe(bookB.id);
  });

  describe("agentResultCommitFailure()", () => {
    it("returns `cfc_commit_refused` with the boundary's refusals for a refusal error", () => {
      const failure = agentResultCommitFailure({
        name: "CfcCommitRefusalError",
        message: "refused: https://cfc.test/atom/finance",
        refusals: [{ gate: "writer-fit" }],
      }, "the agent result");

      expect(failure.code).toBe("cfc_commit_refused");
      expect(failure.refusals).toEqual([{ gate: "writer-fit" }]);
      expect(failure.rawCauseMessage).toBe(
        "refused: https://cfc.test/atom/finance",
      );
      expect(failure.message).not.toContain("finance");
    });

    it("returns `commit_failed` for any other storage error", () => {
      const failure = agentResultCommitFailure({
        name: "StorageTransactionAborted",
        message: "aborted",
      }, "the agent result");

      expect(failure.code).toBe("commit_failed");
      expect(failure.refusals).toBeUndefined();
      expect(failure.rawCauseMessage).toBe("aborted");
    });
  });
});
