/**
 * Where `sqliteQuery` labels its selection inputs (CFC spec §8.17.6).
 *
 * `S` below is the confidentiality of a query's selection inputs: its
 * statement and its parameters. A result's structure carries `S`, whatever
 * the result's scope: its membership, its count, and the reference identity at
 * each slot. Membership and count carry the rows' labels as well; a read of
 * one row through the result carries that row's label and not another's. A
 * row document carries the label its columns and its row rule assign and
 * nothing of `S`, and holds one content for its whole life, so a reader who
 * retained a reference to one learns nothing about a later selection through
 * it. Its id is hashed with a per-space runtime secret, so the id says nothing
 * about the row.
 *
 * The fixture labels the column a parameter is read from differently from the
 * column a query projects, so a label that reached a path from the parameter
 * is distinguishable from one the projected rows brought.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { URI } from "@commonfabric/memory/interface";
import {
  all,
  dbOwner,
  match,
  principal,
} from "@commonfabric/memory/sqlite/row-label";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef, SqliteParamsWire } from "@commonfabric/memory/v2";
import { deepEqual } from "@commonfabric/utils/deep-equal";

import { encodeCfLinkValue } from "../src/builtins/sqlite/cf-link.ts";
import { SQLITE_ROW_SALT } from "../src/builtins/sqlite/row-identity.ts";
import type { Cell } from "../src/cell.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { CFC_LABEL_READ_FAILED_ATOM } from "../src/cfc/observation.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import { createRef } from "../src/create-ref.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { runtimeSecretLink } from "../src/runtime-secret.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { linkResolutionProbe } from "../src/storage/reactivity-log.ts";
import { toURI } from "../src/uri-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner-sqlite-row-set-members");
const space = signer.did();

const clauseFor = (cls: string) => [
  space,
  { type: CFC_ATOM_TYPE.Resource, class: cls, subject: space },
];

const BOB = "did:mailto:bob@example.test";

/** The label of the cell a parameter is read from: `S`. */
const PICKED_CLAUSE = clauseFor("message");
/** The label of the `body` column. */
const BODY_CLAUSE = clauseFor("attachment");

/** Projects the labeled column. */
const BODIES_SQL =
  "SELECT body FROM messages WHERE container_id = ?1 ORDER BY id";
/** Projects a column that declares nothing. */
const NOTES_SQL =
  "SELECT note FROM messages WHERE container_id = ?1 ORDER BY id";

/** Projects a link column, which declares nothing. */
const TARGETS_SQL =
  "SELECT target_cf_link FROM messages WHERE container_id = ?1 ORDER BY id";
/** The row schema of a query that reads `target_cf_link` as a cell. */
const TARGETS_ROW_SCHEMA = {
  type: "object",
  properties: { target_cf_link: { asCell: ["cell"], type: "object" } },
} as const;

type QueryScope = "session" | "space";
type FlowLabels = "persist" | "off";

interface QueryState {
  pending?: boolean;
  result?: Record<string, unknown>[];
  error?: unknown;
  requestHash?: string;
}

const HANDLES_SCHEMA = {
  type: "object",
  properties: {
    result: { type: "array", items: { asCell: ["cell"] } },
  },
} as const;

describe("sqlite-query-row-set-members", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  /**
   * `persist` is the strict rung with the dials every preset deployment pins.
   * `off` is enforcement without flow labels, where no write of the result
   * store stamps the issuing transaction's join on it, so what the builtin
   * declares is the only place `S` can come from.
   */
  const makeRuntime = (flowLabels: FlowLabels) => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      ...(flowLabels === "persist"
        ? {
          cfcEnforcementMode: "enforce-strict",
          cfcFlowLabels: "persist",
          cfcWriteFloor: "enforce",
          cfcPolicyEvaluation: "enforce",
          cfcLabelMetadataProtection: "enforce",
          cfcDeclaredMonotonicity: "enforce",
        } as const
        : {
          cfcEnforcementMode: "enforce-explicit",
          cfcFlowLabels: "off",
        } as const),
    });
  };

  beforeEach(() => makeRuntime("persist"));

  afterEach(async () => {
    await runtime.dispose({ closeStorage: false });
    await storageManager.close();
  });

  const labeledDb = (): SqliteDbRef =>
    ({
      id: `of:row-set-members-${crypto.randomUUID()}`,
      tables: {
        messages: {
          type: "object",
          properties: {
            id: { type: "integer", sqlType: "integer primary key" },
            container_id: { type: "string", sqlType: "text" },
            body: {
              type: "string",
              sqlType: "text",
              ifc: { confidentiality: BODY_CLAUSE },
            },
            note: { type: "string", sqlType: "text" },
            target_cf_link: { type: "string", sqlType: "text" },
          },
          required: [],
        },
      },
    }) as unknown as SqliteDbRef;

  const seed = async (
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
  ): Promise<void> => {
    const tx = runtime.edit();
    tx.recordSqliteWrite!(space, { op: "sqlite", db, sql, params });
    expect((await tx.commit()).error).toBeUndefined();
  };

  /** Two rows in `c-alpha` and one in `c-beta`. */
  const seededDb = async (): Promise<SqliteDbRef> => {
    const db = labeledDb();
    await seed(
      db,
      "INSERT INTO messages (container_id, body, note) VALUES " +
        "(?, ?, ?), (?, ?, ?), (?, ?, ?)",
      [
        "c-alpha",
        "first",
        "n1",
        "c-alpha",
        "second",
        "n2",
        "c-beta",
        "only",
        "n3",
      ],
    );
    return db;
  };

  /**
   * The cells a query's parameter is read from: an unlabeled one holding
   * `c-beta`, a labeled one holding `c-alpha`, and the flag choosing between
   * them, which starts at the unlabeled one.
   */
  const parameterSource = async (cause: string) => {
    const tx = runtime.edit();
    const plain = runtime.getCell<string>(space, `${cause}-plain`, {
      type: "string",
    }, tx);
    plain.set("c-beta");
    const labeled = runtime.getCell<string>(space, `${cause}-labeled`, {
      type: "string",
      ifc: { confidentiality: PICKED_CLAUSE },
      // deno-lint-ignore no-explicit-any -- `ifc` is not on the schema type
    } as any, tx);
    labeled.set("c-alpha");
    const useLabeled = runtime.getCell<boolean>(space, `${cause}-flag`, {
      type: "boolean",
    }, tx);
    useLabeled.set(false);
    expect((await tx.commit()).error).toBeUndefined();
    return { plain, labeled, useLabeled };
  };

  type ParameterSource = Awaited<ReturnType<typeof parameterSource>>;

  /**
   * Runs one query whose only parameter is read from `source`, and returns the
   * result store the builtin writes.
   */
  const runQuery = async (options: {
    cause: string;
    db: SqliteDbRef;
    sql: string;
    source: ParameterSource;
    scope: QueryScope;
    /** Binds the labeled cell as the parameter, with no lift between. */
    direct?: boolean;
    /** The row schema a typed query carries, which marks its link columns. */
    rowSchema?: unknown;
  }) => {
    const { cause, db, sql, source, scope, direct, rowSchema } = options;
    const { commonfabric: cf } = createTrustedBuilder(runtime);
    const { lift } = cf as unknown as {
      lift: (
        fn: (value: unknown) => unknown,
        argumentSchema?: unknown,
        resultSchema?: unknown,
      ) => (value: unknown) => unknown;
    };
    // Reads one of the two cells, chosen by the flag: the branch it does not
    // take is a cell it does not read, so an issue made from the unlabeled
    // cell carries nothing.
    const parameterOf = lift(
      (input: unknown) => {
        const { plain, labeled, useLabeled } = input as {
          plain?: string;
          labeled?: string;
          useLabeled?: boolean;
        };
        return [String((useLabeled ? labeled : plain) ?? "")];
      },
      undefined,
      { type: "array", items: { type: "string" } },
    );
    const testPattern = cf.pattern<
      { plain: string; labeled: string; useLabeled: boolean }
    >((input) => {
      const query = scope === "session"
        ? cf.sqliteQuery.asScope("session")
        : cf.sqliteQuery;
      const rows = query(
        // deno-lint-ignore no-explicit-any -- the builtin's input is untyped
        {
          db,
          reactOn: db,
          sql,
          params: direct ? [input.labeled] : parameterOf(input),
          ...(rowSchema !== undefined && { rowSchema }),
        } as any,
      );
      return { rows };
    });
    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      space,
      cause,
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      testPattern,
      // deno-lint-ignore no-explicit-any -- cells stand in for the arguments
      source as any,
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    // deno-lint-ignore no-explicit-any -- the builtin's state, as it writes it
    return result.key("rows") as Cell<any>;
  };

  /** Runs one query with no parameter, and returns its result store. */
  const runUnparameterized = async (options: {
    cause: string;
    db: SqliteDbRef;
    sql: string;
    scope: QueryScope;
  }) => {
    const { cause, db, sql, scope } = options;
    const { commonfabric: cf } = createTrustedBuilder(runtime);
    const testPattern = cf.pattern<Record<string, never>>(() => {
      const query = scope === "session"
        ? cf.sqliteQuery.asScope("session")
        : cf.sqliteQuery;
      // deno-lint-ignore no-explicit-any -- the builtin's input is untyped
      return { rows: query({ db, reactOn: db, sql } as any) };
    });
    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      space,
      cause,
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    // deno-lint-ignore no-explicit-any -- the builtin's state, as it writes it
    return result.key("rows") as Cell<any>;
  };

  const settled = async (
    // deno-lint-ignore no-explicit-any -- the builtin's state
    rows: Cell<any>,
    count: number,
  ): Promise<QueryState> => {
    const state = await waitForCellValue<QueryState>(
      runtime,
      rows,
      (value) =>
        (value?.pending === false && (value?.result ?? []).length === count) ||
        value?.error !== undefined,
    );
    expect(state.error).toBeUndefined();
    return state;
  };

  /** Moves the parameter to the labeled cell, which selects `c-alpha`. */
  const selectLabeled = async (source: ParameterSource) => {
    const tx = runtime.edit();
    source.useLabeled.withTx(tx).set(true);
    expect((await tx.commit()).error).toBeUndefined();
  };

  /** Moves the parameter back to the unlabeled cell, which selects `c-beta`. */
  const selectUnlabeled = async (source: ParameterSource) => {
    const tx = runtime.edit();
    source.useLabeled.withTx(tx).set(false);
    expect((await tx.commit()).error).toBeUndefined();
  };

  /** Moves the labeled parameter to another container. */
  const selectLabeledContainer = async (
    source: ParameterSource,
    value: string,
  ) => {
    const tx = runtime.edit();
    source.labeled.withTx(tx).set(value);
    expect((await tx.commit()).error).toBeUndefined();
  };

  /** Moves the unlabeled parameter to another container. */
  const selectPlain = async (source: ParameterSource, value: string) => {
    const tx = runtime.edit();
    source.plain.withTx(tx).set(value);
    expect((await tx.commit()).error).toBeUndefined();
  };

  /** What the row document behind `link` holds. */
  const rowContent = (link: ReturnType<typeof rowLinks>[number]): unknown => {
    const tx = runtime.edit();
    try {
      return runtime.getCellFromLink(link, undefined, tx).getRaw();
    } finally {
      tx.abort("content read");
    }
  };

  /** The document each stored result row links to, in row order. */
  // deno-lint-ignore no-explicit-any -- the builtin's state
  const rowLinks = (rows: Cell<any>) => {
    const store = rows.resolveAsCell();
    const raw = store.key("result").getRaw() as unknown[];
    return raw.map((entry) => {
      const link = parseLink(entry as Parameters<typeof parseLink>[0], store);
      if (!link?.id) throw new Error("a result row is stored inline");
      return {
        space,
        id: link.id as URI,
        scope: link.scope,
        type: "application/json" as const,
        path: [] as string[],
      };
    });
  };

  /** The join of what `observe` reads, off a transaction then abandoned. */
  const joinOf = (
    observe: (tx: IExtendedStorageTransaction) => void,
  ): unknown[] => {
    const tx = runtime.edit();
    try {
      observe(tx);
      return deriveFlowJoin(tx).confidentiality;
    } finally {
      tx.abort("observation only");
    }
  };

  /** Whether every alternative of `clause` is among `atoms`. */
  const hasClause = (
    atoms: readonly unknown[],
    clause: readonly unknown[],
  ): boolean =>
    clause.every((atom) => atoms.some((held) => deepEqual(held, atom)));

  /**
   * The confidentiality the result store declares at `path` for the
   * observation class `observes`.
   */
  const declaredAt = (
    // deno-lint-ignore no-explicit-any -- the builtin's state
    rows: Cell<any>,
    path: string[],
    observes: string,
  ): unknown[] => {
    const tx = runtime.edit();
    try {
      const link = rows.resolveAsCell().getAsNormalizedFullLink();
      const entries = (readStoredCfcMetadata(tx, link)?.labelMap.entries ??
        []) as {
          path: string[];
          origin?: string;
          observes?: string;
          label: { confidentiality?: unknown[] };
        }[];
      return entries.filter((entry) =>
        entry.origin === "declared" && entry.observes === observes &&
        entry.path.length === path.length &&
        entry.path.every((segment, i) => segment === path[i])
      ).flatMap((entry) => entry.label.confidentiality ?? []);
    } finally {
      tx.abort("label read");
    }
  };

  /** A standalone probe of which reference sits at `/result/<index>`. */
  // deno-lint-ignore no-explicit-any -- the builtin's state
  const probeSlot = (rows: Cell<any>, index: number) => {
    const link = rows.resolveAsCell().getAsNormalizedFullLink();
    return joinOf((tx) => {
      tx.read({
        space,
        scope: link.scope,
        id: link.id,
        type: "application/json",
        path: ["value", ...link.path, "result", String(index)],
      }, { meta: linkResolutionProbe });
    });
  };

  describe("a retained row reference", () => {
    for (
      const [name, sql, before] of [
        ["a column-labeled row", BODIES_SQL, { body: "only" }],
        ["an unlabeled row", NOTES_SQL, { note: "n3" }],
      ] as const
    ) {
      it(`reads the same content of ${name} after the parameter changes`, async () => {
        const db = await seededDb();
        const source = await parameterSource(`retained-${name}`);
        const rows = await runQuery({
          cause: `retained-${name}`,
          db,
          sql,
          source,
          scope: "session",
        });
        await settled(rows, 1);
        const [retained] = rowLinks(rows);
        expect(rowContent(retained)).toEqual(before);

        await selectPlain(source, "c-alpha");
        await settled(rows, 2);
        await runtime.settled();

        expect(rowContent(retained)).toEqual(before);
        expect(rowLinks(rows).map((link) => link.id)).not.toContain(
          retained.id,
        );
      });
    }
  });

  for (
    const [scope, flowLabels] of [
      ["session", "persist"],
      ["space", "persist"],
      ["session", "off"],
      ["space", "off"],
    ] as const
  ) {
    describe(`a ${scope}-scoped result of unlabeled columns under a labeled parameter, flow labels ${flowLabels}`, () => {
      // The projected column declares nothing, so `S` is the only label that
      // can reach any of these observations.

      beforeEach(async () => {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
        makeRuntime(flowLabels);
      });

      const labeledSelection = async (cause: string) => {
        const db = await seededDb();
        const source = await parameterSource(`${scope}-${flowLabels}-${cause}`);
        const rows = await runQuery({
          cause: `${scope}-${flowLabels}-${cause}`,
          db,
          sql: NOTES_SQL,
          source,
          scope,
          direct: flowLabels === "off",
        });
        if (flowLabels === "persist") {
          // The store is created by an issue that carries nothing, so no
          // label of its creation stands in for the one the later issue
          // brings. With flow labels off a lift's output carries no label, so
          // there the labeled cell is the parameter from the first issue.
          await settled(rows, 1);
          await selectLabeled(source);
        }
        const state = await settled(rows, 2);
        expect(state.result).toEqual([{ note: "n1" }, { note: "n2" }]);
        return rows;
      };

      it("declares `S` on its membership and on the reference at each slot", async () => {
        const rows = await labeledSelection("declared");

        expect(
          hasClause(declaredAt(rows, ["result"], "enumerate"), PICKED_CLAUSE),
        )
          .toBe(true);
        expect(
          hasClause(
            declaredAt(rows, ["result", "*"], "followRef"),
            PICKED_CLAUSE,
          ),
        ).toBe(true);
      });

      it("carries `S` on a probe of a slot", async () => {
        const rows = await labeledSelection("probe");

        expect(hasClause(probeSlot(rows, 0), PICKED_CLAUSE)).toBe(true);
      });

      it("carries `S` on `equals()` of a slot against a known row", async () => {
        const rows = await labeledSelection("equals");
        const known = runtime.getCellFromLink(rowLinks(rows)[0]);

        const join = joinOf((tx) => {
          rows.resolveAsCell().withTx(tx).key("result").key(0).equals(known);
        });
        expect(hasClause(join, PICKED_CLAUSE)).toBe(true);
      });

      it("carries `S` on the row references taken as handles", async () => {
        const rows = await labeledSelection("handles");

        const join = joinOf((tx) => {
          const handles = rows.resolveAsCell().asSchema(HANDLES_SCHEMA)
            .withTx(tx).key("result").get() as unknown as Cell<unknown>[];
          handles.map((cell) => cell.getAsNormalizedFullLink().id);
        });
        expect(hasClause(join, PICKED_CLAUSE)).toBe(true);
      });

      it("carries `S` on a raw read of one slot's reference", async () => {
        const rows = await labeledSelection("raw-slot");

        const join = joinOf((tx) => {
          rows.resolveAsCell().withTx(tx).key("result").key(0).getRaw();
        });
        expect(hasClause(join, PICKED_CLAUSE)).toBe(true);
      });

      it("carries `S` on the result's length", async () => {
        const rows = await labeledSelection("length");

        const join = joinOf((tx) => {
          rows.resolveAsCell().withTx(tx).key("result").key("length").get();
        });
        expect(hasClause(join, PICKED_CLAUSE)).toBe(true);
      });

      it("carries `S` on an enumeration of the result", async () => {
        const rows = await labeledSelection("enumerate");

        const join = joinOf((tx) => {
          rows.resolveAsCell().withTx(tx).key("result").get();
        });
        expect(hasClause(join, PICKED_CLAUSE)).toBe(true);
      });

      it("carries nothing of `S` on a row read through a retained reference", async () => {
        const rows = await labeledSelection("independent");
        const [first] = rowLinks(rows);

        let content: unknown;
        const join = joinOf((tx) => {
          content = runtime.getCellFromLink(first, undefined, tx).get();
        });
        expect(content).toEqual({ note: "n1" });
        expect(hasClause(join, PICKED_CLAUSE)).toBe(false);
      });
    });
  }

  for (const scope of ["session", "space"] as const) {
    describe(`a ${scope}-scoped result whose rows carry different row labels`, () => {
      // Row 0 is labeled for the owner alone, row 1 for the owner and Bob.
      // Reaching one row through the result observes that row and which
      // reference sits at its slot; enumerating or counting the rows
      // observes all of them.

      const mixedLabels = async (cause: string) => {
        const db = {
          id: `of:row-set-members-${crypto.randomUUID()}`,
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
        const rows = await runUnparameterized({
          cause: `${scope}-${cause}`,
          db,
          sql: "SELECT id, to_addr, body FROM mail ORDER BY id",
          scope,
        });
        const state = await settled(rows, 2);
        expect(state.result?.map((row) => row.body)).toEqual([
          "mine",
          "private message",
        ]);
        return rows;
      };

      it("carries a row's own label, and not another row's, on a read of that row through the result", async () => {
        const rows = await mixedLabels("addressed");

        let body: unknown;
        const join = joinOf((tx) => {
          body = rows.resolveAsCell().withTx(tx).key("result").key(0).key(
            "body",
          ).get();
        });
        expect(body).toBe("mine");
        expect(join).toContainEqual(space);
        expect(join).not.toContainEqual(BOB);
      });

      it("carries every row's label on an enumeration of the result", async () => {
        const rows = await mixedLabels("enumerated");

        const join = joinOf((tx) => {
          rows.resolveAsCell().withTx(tx).key("result").get();
        });
        expect(join).toContainEqual(BOB);
      });

      it("carries every row's label on the result's length", async () => {
        const rows = await mixedLabels("counted");

        const join = joinOf((tx) => {
          rows.resolveAsCell().withTx(tx).key("result").key("length").get();
        });
        expect(join).toContainEqual(BOB);
      });
    });
  }

  describe("the row salt", () => {
    // A row document's id is hashed with a per-space runtime secret, so the
    // id says nothing about the row to a reader who cannot read the row.

    const saltLink = runtimeSecretLink(space, SQLITE_ROW_SALT);

    const saltedRows = async (cause: string) => {
      const db = await seededDb();
      const source = await parameterSource(cause);
      const rows = await runQuery({
        cause,
        db,
        sql: NOTES_SQL,
        source,
        scope: "space",
      });
      const state = await settled(rows, 1);
      expect(state.result).toEqual([{ note: "n3" }]);
      return rows;
    };

    /** The salt stored in this space, read under an abandoned transaction. */
    const storedSalt = (): unknown => {
      const tx = runtime.edit();
      try {
        return runtime.getCellFromLink(saltLink, undefined, tx).getRaw();
      } finally {
        tx.abort("salt read");
      }
    };

    it("keys a row document on more than the row and its namespace", async () => {
      const rows = await saltedRows("salt-id");
      const [first] = rowLinks(rows);
      const store = rows.resolveAsCell().getAsNormalizedFullLink();

      const unsalted = toURI(createRef({ row: { note: "n3" } }, {
        parent: { id: store.id, space: store.space },
        path: [...store.path, "result"],
        context: "sqlite-result-row",
      }));
      expect(first.id).not.toBe(unsalted);
    });

    it("keeps one salt per space across queries", async () => {
      await saltedRows("salt-first");
      const salt = storedSalt();
      expect(typeof salt).toBe("string");

      await saltedRows("salt-second");
      expect(storedSalt()).toBe(salt);
    });

    it("carries a label no ceiling admits on a read of the salt", async () => {
      await saltedRows("salt-label");

      const join = joinOf((tx) => {
        runtime.getCellFromLink(saltLink, undefined, tx).get();
      });
      expect(join).toContainEqual(CFC_LABEL_READ_FAILED_ATOM);
    });

    it("replaces a salt stored without the runtime's writer claim", async () => {
      // A value written into the namespace before the write chokepoint
      // existed, or by a runtime without it. The fixture's privileged write
      // stands in for that writer: it lands the value and records no claim.
      const plant = runtime.edit() as ExtendedStorageTransaction;
      plant.accessForTestingOnly.privilegedSystemWrite(
        { ...saltLink, type: "application/json", path: ["value"] },
        "planted",
      );
      expect((await plant.commit()).error).toBeUndefined();
      expect(storedSalt()).toBe("planted");

      const rows = await saltedRows("salt-planted");
      const salt = storedSalt();
      expect(typeof salt).toBe("string");
      expect(salt).not.toBe("planted");
      const [first] = rowLinks(rows);
      const store = rows.resolveAsCell().getAsNormalizedFullLink();
      const underPlanted = toURI(
        createRef({ salt: "planted", row: { note: "n3" } }, {
          parent: { id: store.id, space: store.space },
          path: [...store.path, "result"],
          context: "sqlite-result-row",
        }),
      );
      expect(first.id).not.toBe(underPlanted);
    });

    it("refuses to mint a salt without the runtime's authorization", () => {
      // Code that minted the salt in its own transaction could read it back
      // there before its label is stored, so the mint is the runtime's alone.

      const tx = runtime.edit();
      try {
        expect(() =>
          tx.ensureRuntimeSecret(
            space,
            SQLITE_ROW_SALT,
            {} as Parameters<typeof tx.ensureRuntimeSecret>[2],
          )
        ).toThrow(/runtime's authorization/);
      } finally {
        tx.abort("refused mint");
      }
    });

    it("refuses a write to the salt from outside the runtime", async () => {
      await saltedRows("salt-write");

      const tx = runtime.edit();
      try {
        expect(() =>
          runtime.getCellFromLink(saltLink, undefined, tx).set("known")
        ).toThrow(/runtime secret/);
      } finally {
        tx.abort("refused write");
      }
    });
  });

  for (
    const [scope, flowLabels] of [
      ["session", "persist"],
      ["space", "persist"],
      ["session", "off"],
      ["space", "off"],
    ] as const
  ) {
    describe(`a ${scope}-scoped result of unlabeled columns that links a standing row document, flow labels ${flowLabels}`, () => {
      // The projected column declares nothing, so a row document stores no
      // label, and the result store carries `S`. A settle that finds a row's
      // document standing writes the slot that links it and not the
      // document.

      beforeEach(async () => {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
        makeRuntime(flowLabels);
      });

      const labeledSelection = async (cause: string) => {
        const db = await seededDb();
        const source = await parameterSource(`${scope}-${flowLabels}-${cause}`);
        const rows = await runQuery({
          cause: `${scope}-${flowLabels}-${cause}`,
          db,
          sql: NOTES_SQL,
          source,
          scope,
          direct: flowLabels === "off",
        });
        let unlabeled: ReturnType<typeof rowLinks> = [];
        if (flowLabels === "persist") {
          await settled(rows, 1);
          unlabeled = rowLinks(rows);
          await selectLabeled(source);
        }
        await settled(rows, 2);
        return { source, rows, unlabeled, labeled: rowLinks(rows) };
      };

      /** Selects no row and then `c-alpha` again, under the labeled cell. */
      const selectAgain = async (
        source: ParameterSource,
        // deno-lint-ignore no-explicit-any -- the builtin's state
        rows: Cell<any>,
      ) => {
        await selectLabeledContainer(source, "c-none");
        await settled(rows, 0);
        await selectLabeledContainer(source, "c-alpha");
        return await settled(rows, 2);
      };

      it("settles the rows of an earlier labeled selection on the documents they stand on", async () => {
        const { source, rows, labeled } = await labeledSelection("again");

        const state = await selectAgain(source, rows);

        expect(state.result).toEqual([{ note: "n1" }, { note: "n2" }]);
        expect(rowLinks(rows).map((link) => link.id)).toEqual(
          labeled.map((link) => link.id),
        );
      });

      it("stores no label on a row document it links again", async () => {
        const { source, rows } = await labeledSelection("unstored");

        await selectAgain(source, rows);
        await runtime.settled();

        const tx = runtime.edit();
        try {
          expect(
            rowLinks(rows).map((link) => readStoredCfcMetadata(tx, link)),
          ).toEqual([undefined, undefined]);
        } finally {
          tx.abort("label read");
        }
      });

      if (flowLabels === "persist") {
        it("settles the row of an earlier unlabeled selection on the document it stands on", async () => {
          const { source, rows, unlabeled } = await labeledSelection("back");

          await selectUnlabeled(source);

          const state = await settled(rows, 1);
          expect(state.result).toEqual([{ note: "n3" }]);
          expect(rowLinks(rows).map((link) => link.id)).toEqual(
            unlabeled.map((link) => link.id),
          );
        });
      }
    });
  }

  for (const scope of ["session", "space"] as const) {
    describe(`a ${scope}-scoped result of an unlabeled link column that links a standing row document`, () => {
      // The row holds a link to a cell that stores no label. The link write
      // policy refuses such a link beneath a labeled position, so a row that
      // settles twice is one whose root took no label from the result store.

      it("settles the row of an earlier selection, whose link column reads the cell it names", async () => {
        const db = await seededDb();
        const seedTx = runtime.edit();
        const target = runtime.getCell<{ name: string }>(
          space,
          `${scope}-link-target`,
          undefined,
          seedTx,
        );
        target.set({ name: "Ada" });
        expect((await seedTx.commit()).error).toBeUndefined();
        await seed(
          db,
          "INSERT INTO messages (container_id, target_cf_link) VALUES (?, ?)",
          ["c-link", encodeCfLinkValue(target)],
        );
        const source = await parameterSource(`${scope}-link`);
        await selectLabeledContainer(source, "c-link");
        const rows = await runQuery({
          cause: `${scope}-link`,
          db,
          sql: TARGETS_SQL,
          source,
          scope,
          direct: true,
          rowSchema: TARGETS_ROW_SCHEMA,
        });
        await settled(rows, 1);
        const earlier = rowLinks(rows).map((link) => link.id);

        await selectLabeledContainer(source, "c-none");
        await settled(rows, 0);
        await selectLabeledContainer(source, "c-link");
        await settled(rows, 1);

        expect(rowLinks(rows).map((link) => link.id)).toEqual(earlier);
        const read = rows.resolveAsCell().asSchema({
          type: "object",
          properties: {
            result: { type: "array", items: TARGETS_ROW_SCHEMA },
          },
        }).get() as { result: { target_cf_link: Cell<unknown> }[] };
        expect(read.result[0].target_cf_link.get()).toEqual({ name: "Ada" });
      });
    });
  }

  describe("a row document under a labeled parameter", () => {
    it("carries the row's label and nothing of `S` on the row's existence", async () => {
      const db = await seededDb();
      const source = await parameterSource("labeled-existence");
      const rows = await runQuery({
        cause: "labeled-existence",
        db,
        sql: BODIES_SQL,
        source,
        scope: "space",
      });
      await settled(rows, 1);
      await selectLabeled(source);
      await settled(rows, 2);
      const [first] = rowLinks(rows);

      const join = joinOf((tx) => {
        tx.read({ ...first, path: ["value"] }, { nonRecursive: true });
      });
      expect(hasClause(join, BODY_CLAUSE)).toBe(true);
      expect(hasClause(join, PICKED_CLAUSE)).toBe(false);
    });
  });
});
