/**
 * What each child of a `map` over a query result carries, when the rows carry
 * different labels.
 *
 * A `sqliteQuery` result's membership carries every row's label joined with
 * `S`, the label of the query's selection inputs, and the reference at each
 * slot carries `S` (CFC spec §8.17.6). A child of a `map` over that result
 * observes its own row and which reference sits at its slot, so it carries
 * that row's label and `S`. It does not carry another row's label: the map
 * coordinator reads the membership to learn which children to run, and that
 * read is not one any child makes.
 *
 * Row 0 is labeled for the owner alone, row 1 for the owner and Bob, and the
 * query's parameter is read from a cell labeled `S`.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { deepEqual } from "@commonfabric/js-values/deep-equal";
import {
  all,
  dbOwner,
  match,
  principal,
} from "@commonfabric/memory/sqlite/row-label";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef, SqliteParamsWire } from "@commonfabric/memory/v2";

import type { FactoryInput } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner-cfc-map-row-labels");
const space = signer.did();

const BOB = "did:mailto:bob@example.test";

/** The label of the cell the query's parameter is read from: `S`. */
const SELECTION_CLAUSE = [
  space,
  { type: CFC_ATOM_TYPE.Resource, class: "selection", subject: space },
];

const SELECT_MAIL =
  "SELECT id, to_addr, body FROM mail WHERE body != ?1 ORDER BY id";

interface Row {
  id: number;
  to_addr: string;
  body: string;
}

interface QueryState {
  pending?: boolean;
  result?: Row[];
  error?: unknown;
}

describe("CFC flow labels: a map over rows with different labels", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // The strict rung with the dials every preset deployment pins.
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
      cfcWriteFloor: "enforce",
      cfcPolicyEvaluation: "enforce",
      cfcLabelMetadataProtection: "enforce",
      cfcDeclaredMonotonicity: "enforce",
    });
  });

  afterEach(async () => {
    await runtime.dispose({ closeStorage: false });
    await storageManager.close();
  });

  const seed = async (
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
  ): Promise<void> => {
    const tx = runtime.edit();
    tx.recordSqliteWrite!(space, { op: "sqlite", db, sql, params });
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  /** A db whose row rule labels each row for the owner and its addressee. */
  const mixedLabelDb = async (): Promise<SqliteDbRef> => {
    const db = {
      id: `of:map-row-labels-${crypto.randomUUID()}`,
      owner: space,
      tables: {
        mail: table(
          { id: "integer primary key", to_addr: "text", body: "text" },
          (f) => ({
            confidentiality: all(
              dbOwner(),
              principal(
                "mailto",
                match(f.to_addr, /[^\s<>,;"]+@[^\s<>,;"]+/g),
              ),
            ),
          }),
        ),
      },
    } as unknown as SqliteDbRef;
    await seed(
      db,
      "INSERT INTO mail (to_addr, body) VALUES (?, ?), (?, ?)",
      ["", "mine", "bob@example.test", "private message"],
    );
    return db;
  };

  /**
   * Runs a page that maps the query's rows to one card each, beside an output
   * that reads nothing of the query, and waits for both cards.
   */
  const runPage = async (cause: string) => {
    const db = await mixedLabelDb();
    const setup = runtime.edit();
    const excluded = runtime.getCell<string>(space, `${cause}-excluded`, {
      type: "string",
      ifc: { confidentiality: SELECTION_CLAUSE },
      // deno-lint-ignore no-explicit-any -- `ifc` is not on the schema type
    } as any, setup);
    excluded.set("no such body");
    const plain = runtime.getCell<string>(space, `${cause}-plain`, {
      type: "string",
    }, setup);
    plain.set("Inbox");
    expect((await setup.commit().settled).error).toBeUndefined();

    const { commonfabric: cf } = createTrustedBuilder(runtime);
    const { lift } = cf as unknown as {
      lift: (fn: (value: any) => unknown) => (value: unknown) => unknown;
    };
    const card = lift((row: Row) => ({ title: row.body }));
    const heading = lift((value: string) => ({ text: value }));
    const page = cf.pattern<{ excluded: string; plain: string }>((input) => {
      const query = cf.sqliteQuery(
        // deno-lint-ignore no-explicit-any -- the builtin's input is untyped
        { db, reactOn: db, sql: SELECT_MAIL, params: [input.excluded] } as any,
      );
      // deno-lint-ignore no-explicit-any -- the builtin's state is untyped
      const cards = (query as any).result.mapWithPattern(
        cf.pattern(({ element }: FactoryInput<any>) => card(element)),
        {},
      );
      return { query, cards, heading: heading(input.plain) };
    });

    const tx = runtime.edit();
    const resultCell = runtime.getCell(space, cause, page.resultSchema, tx);
    const result = runtime.run(
      tx,
      page,
      // deno-lint-ignore no-explicit-any -- cells stand in for the arguments
      { excluded, plain } as any,
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    const state = await waitForCellValue<QueryState>(
      runtime,
      // deno-lint-ignore no-explicit-any -- the builtin's state
      result.key("query") as Cell<any>,
      (value) =>
        (value?.pending === false && (value?.result ?? []).length === 2) ||
        value?.error !== undefined,
    );
    expect(state.error).toBeUndefined();
    await result.pull();
    await runtime.idle();
    // deno-lint-ignore no-explicit-any -- the page's outputs are untyped
    const cards = (result.key("cards") as Cell<any>).get() as {
      title: string;
    }[];
    expect(cards.map((c) => c?.title)).toEqual(["mine", "private message"]);
    return result;
  };

  /**
   * The confidentiality a consumer of one of the page's outputs derives: the
   * output is copied into a fresh document, and what that document stores is
   * what the consumer would carry.
   */
  const consumerConfidentiality = async (
    // deno-lint-ignore no-explicit-any -- the page's outputs are untyped
    output: Cell<any>,
    cause: string,
  ): Promise<unknown[]> => {
    const tx = runtime.edit();
    const value = output.withTx(tx).get() as FabricValue;
    const out = runtime.getCell(space, cause, undefined, tx);
    out.set({ copied: value } as FabricValue);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    const read = runtime.edit();
    try {
      const entries = readStoredCfcMetadata(read, out.getAsNormalizedFullLink())
        ?.labelMap.entries ?? [];
      return entries.flatMap((entry) =>
        (entry.label as { confidentiality?: unknown[] }).confidentiality ?? []
      );
    } finally {
      read.abort("label read");
    }
  };

  /** Every confidentiality atom stored anywhere on `cell`'s document. */
  // deno-lint-ignore no-explicit-any -- any cell
  const storedConfidentiality = (cell: Cell<any>): unknown[] => {
    const read = runtime.edit();
    try {
      const link = cell.getAsNormalizedFullLink();
      const entries = readStoredCfcMetadata(read, link)
        ?.labelMap.entries ?? [];
      return entries.flatMap((entry) =>
        (entry.label as { confidentiality?: unknown[] }).confidentiality ?? []
      );
    } finally {
      read.abort("label read");
    }
  };

  /** The join a read of `list`'s length derives, off an abandoned transaction. */
  // deno-lint-ignore no-explicit-any -- any list cell
  const lengthConfidentiality = (list: Cell<any>): unknown[] => {
    const tx = runtime.edit();
    try {
      list.withTx(tx).key("length").get();
      return deriveFlowJoin(tx).confidentiality;
    } finally {
      tx.abort("observation only");
    }
  };

  const hasClause = (
    atoms: readonly unknown[],
    clause: readonly unknown[],
  ): boolean =>
    clause.every((atom) => atoms.some((held) => deepEqual(held, atom)));

  it("labels each card with its own row and the selection, and not another row", async () => {
    const result = await runPage("cards");
    // deno-lint-ignore no-explicit-any -- the page's outputs are untyped
    const cards = result.key("cards") as Cell<any>;

    const first = await consumerConfidentiality(cards.key(0), "cards-probe-0");
    const second = await consumerConfidentiality(cards.key(1), "cards-probe-1");

    expect(first).toContainEqual(space);
    expect(hasClause(first, SELECTION_CLAUSE)).toBe(true);
    expect(first).not.toContainEqual(BOB);

    expect(second).toContainEqual(space);
    expect(second).toContainEqual(BOB);
    expect(hasClause(second, SELECTION_CLAUSE)).toBe(true);
  });

  it("stores no other row's label on a card's own document", async () => {
    const result = await runPage("stored");
    // deno-lint-ignore no-explicit-any -- the page's outputs are untyped
    const cards = result.key("cards") as Cell<any>;

    expect(storedConfidentiality(cards.key(0).resolveAsCell())).not
      .toContainEqual(BOB);
    expect(storedConfidentiality(cards.key(1).resolveAsCell()))
      .toContainEqual(BOB);
  });

  it("labels the cards' count with every row and the selection", async () => {
    const result = await runPage("count");
    const count = lengthConfidentiality(
      // deno-lint-ignore no-explicit-any -- the page's outputs are untyped
      result.key("cards") as Cell<any>,
    );

    expect(count).toContainEqual(space);
    expect(count).toContainEqual(BOB);
    expect(hasClause(count, SELECTION_CLAUSE)).toBe(true);
  });

  it("leaves the page's output that reads nothing of the query unlabeled", async () => {
    const result = await runPage("heading");

    const heading = await consumerConfidentiality(
      // deno-lint-ignore no-explicit-any -- the page's outputs are untyped
      result.key("heading") as Cell<any>,
      "heading-probe",
    );
    expect(heading).not.toContainEqual(BOB);
    expect(hasClause(heading, SELECTION_CLAUSE)).toBe(false);
  });
});
