import type { JSONSchema } from "@commonfabric/api";
import {
  columnDeclaresIfc,
  isSqliteDbRef,
  type SqliteDbRef,
  type SqliteQueryResult,
  tableDeclaresRowLabel,
} from "@commonfabric/memory/v2";
import {
  rowLabelSpecOf,
  ruleInputFields,
  validateRowLabelSpec,
} from "@commonfabric/memory/sqlite/row-label";
import { type Cell, readResultSchemaMeta } from "@commonfabric/runner";
import {
  type CfcLabelView,
  cfcLabelViewForCellFailClosedWithStatus,
  type IFCLabel,
} from "@commonfabric/runner/cfc";
import { mergeLabel } from "@commonfabric/runner/cfc/label-view-core";
import { parseLLMFriendlyLink } from "@commonfabric/runner/shared";
import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  cfcLabelAtomTypes,
  type DisclosedCfcLabel,
  disclosedCfcLabels,
} from "../cfc-label-disclosure.ts";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { HarnessFabricSession } from "../fabric-session.ts";
import { admitsFabricReference } from "../foreign-spaces.ts";
import { resolveHandleToken, resolveReferentToken } from "../handle-table.ts";
import { schemaShapeOnly } from "../schema-shape.ts";
import type { HarnessToolContext, HarnessToolDefinition } from "./types.ts";

export interface DescribeHandleToolInput {
  token: string;
}

export interface DescribeHandleToolOutput {
  outputId: string;

  /** The token as asked about, echoed so a reply stands on its own. */
  token: string;

  /** Whether this run's handle table holds the token. */
  known: boolean;

  /**
   * Whether a schema was found to report, from either source. A held
   * non-cell referent can be known and described under {@link referent} while
   * this remains false.
   */
  hasSchema: boolean;

  /** Named capability refusal for a known but non-describable handle. */
  error?: string;

  /**
   * The reported schema: fabric-declared, or harness-derived, whichever
   * answered first in that order.
   */
  schema?: JSONSchema;

  /**
   * Path segments of the referent within its piece — which field of which
   * piece the token names. Read off the entry's already-parsed reference, so
   * it costs nothing and reveals no value.
   */
  path?: string[];

  /**
   * The CFC labels the referent carries, one per labelled path within it.
   * Absent when the run has no session to read them through; an empty list
   * says the space holds none, which is a different answer.
   */
  labels?: DescribeHandleLabel[];

  /**
   * The table contract of a referent that is a SQLite database, reported
   * where the referent declares no schema of its own. Without it a database
   * handed to a run is indistinguishable from an opaque value, and the code
   * an agent can write over it is code that treats it as one.
   */
  database?: DescribeHandleDatabase;

  /**
   * Present when the token names a held referent that is not a cell: what
   * kind it is, which tool observed it, and where its label came from.
   */
  referent?: {
    kind: "document";
    source: string;
    labelSource: "row" | "query";
  };
}

/**
 * What a SQLite database handle states about itself: the shape of a row of
 * each of its tables, and what handling each column demands. Rows are not
 * part of it. They live in the database rather than in the handle, and
 * nothing here opens one — the tables are the contract the database was
 * created under, which is a declaration in exactly the sense a schema is.
 */
export interface DescribeHandleDatabase {
  /**
   * One property per table, whose own properties are that table's columns
   * with their declared types. Reduced like every other disclosed schema, so
   * column annotations, prose and defaults do not ride out on it, and the
   * table- and column-name channels are bounded exactly as any other
   * property-name channel is.
   */
  tables: JSONSchema;

  /**
   * The columns that declare a CFC label, each addressed by its table name
   * and its column name. Atom types and nothing else, the same line
   * {@link DescribeHandleLabel} draws for a cell's own labels — so an entry
   * with no atoms says the column declares a label this cannot name, which is
   * a different fact from a column that declares none and has no entry. A
   * path names a column only where {@link tables} names it too: the bound on
   * the property-name channel holds across both, so a column the reduction
   * refused is absent from this list as well.
   */
  labels: DescribeHandleLabel[];

  /**
   * How much each disclosed table actually holds. Absent when the run has no
   * way to count — a session that could not reach the database at all — which
   * is a different answer from a table that reports itself uncountable.
   */
  fill?: DescribeHandleTableFill[];
}

/**
 * How much one table holds: its rows, and per disclosed column how many of
 * those rows carry a value rather than NULL.
 *
 * This is the one quantity this tool reports. No row, no cell value and no
 * column's contents cross with it, and no predicate the caller chose is ever
 * counted — a count is taken of a whole table and of whole columns, or not at
 * all. What it buys is the difference between a column a query can filter on
 * and one that is NULL on every row of this database, which is otherwise
 * discoverable only by writing the query, reading nothing back, and having no
 * way to tell that from a source that is genuinely empty.
 */
export interface DescribeHandleTableFill {
  /** The table, named as {@link DescribeHandleDatabase.tables} names it. */
  table: string;

  /** Rows the table holds. Absent with {@link unread}. */
  rows?: number;

  /**
   * One entry per disclosed column of the table, holding how many of those
   * rows are non-NULL there. A column reading `0` beside a non-zero
   * {@link rows} is filled on no row at all. Absent with {@link unread}.
   */
  nonNull?: Record<string, number>;

  /**
   * The columns this table's per-row label rule reads, when it has one. A
   * query over such a table must project every one of them — located by true
   * origin, so an alias does not stand in for the column — or the read is
   * refused rather than returned unlabeled, and the refusal arrives on the
   * result's error rather than as rows.
   *
   * Derived from the same declaration the runner evaluates, never restated
   * here, so a rule this build cannot read reports nothing rather than a
   * guess. Absent when the table declares no rule.
   */
  rowLabelReads?: string[];

  /**
   * Present when {@link rowLabelReads} is a part of the rule's requirement
   * rather than the whole of it, so a query projecting everything named there
   * is still refused. Two causes, and a caller acts the same way on both: the
   * rule reads a column this disclosure does not name, or it is declared in a
   * shape this build cannot read at all — which the runner counts as
   * rule-bearing and refuses. A partial list with nothing saying it is partial
   * would read as the recipe for a read that cannot succeed.
   */
  rowLabelReadsIncomplete?: true;

  /**
   * Why this table holds no counts, in the words of whatever refused. A table
   * that could not be counted is reported as uncounted rather than as empty:
   * zero rows and unknown rows are the two readings these counts exist to
   * separate, and collapsing them would make an unreadable table look like an
   * empty one.
   *
   * This is text from the database or the provider rather than from this tool,
   * and it is the one such channel in the reply — the reason a count is worth
   * having is the reason a refused count is, and a bare "uncounted" leaves a
   * caller with nothing to correct. It crosses on the same terms property
   * names do: the prompt loop scrubs bare fabric identifiers out of the whole
   * reply, keys included, before any of it reaches model context.
   */
  unread?: string;
}

/**
 * The label at one path inside a referent, as atom types and nothing else.
 *
 * A clause of several types is satisfied by any one of them, so the nesting
 * in `confidentiality` is the requirement rather than a formatting choice.
 * The projection is shared with every other reply that discloses a label —
 * see [`cfc-label-disclosure.ts`](../cfc-label-disclosure.ts).
 */
export type DescribeHandleLabel = DisclosedCfcLabel;

/**
 * Describes the SHAPE of a handle's referent: property names, types, nesting,
 * and required-ness — and, for a database, how full each of its tables is. No
 * datum is ever reported, so a reply here says what a reference is and how much
 * of it there is, never what it holds. This is what lets an agent write code
 * over a reference it was handed
 * — you cannot compute over data whose shape you do not know — and what lets
 * an orchestrator verify a chain of transformations without reading the data
 * flowing through it.
 *
 * Posture, stated plainly. The policy on disclosing shape is permissive and
 * fixed: any run that holds the token gets an answer, and there is no setting
 * that says otherwise. That is defensible on the same ground declassification
 * stands on elsewhere, and it is the contract patterns already work under
 * internally: you cannot see the data, you can only describe the data flow.
 *
 * Two shapes can answer, in this order:
 *
 * 1. The schema the referent DECLARES in the fabric, read through the run's
 *    session when it has one. A piece's document schema is the result schema
 *    of the pattern behind it, which is the shape an agent holding a handle to
 *    that piece would be wiring into a pattern of its own. The read is of the
 *    document's declared schema and of nothing else; the referent's value is
 *    not read, and a reference outside the session's own space is not
 *    followed.
 * 2. The schema the mint recorded out of the harness's OWN work — the result
 *    schema of a pattern this harness compiled and ran, marked
 *    `schemaSource: "harness"` on the entry.
 *
 * Either way what leaves this tool is STRUCTURE. A JSON Schema is a place a
 * value can hide — `const`, `enum`, `default` and `examples` carry values
 * outright, and `title`, `description` and `pattern` carry free text whoever
 * authored the schema chose — and a fabric-declared schema was authored by
 * someone other than this run, quite possibly a person. So every disclosed
 * schema is rebuilt by {@link schemaShapeOnly} from an allowlist of structural
 * keywords, at every depth, before it is reported. Prose and values do not
 * cross that line, and neither do definition names, which are replaced by
 * opaque ones. Property names do cross it, because nothing can be written over
 * data without them — so they are the one channel of author-chosen text this
 * tool knowingly accepts.
 *
 * A referent that declares no schema gets a third read, and it is the one
 * place this tool reads a value. Some referents state their contract in their
 * value rather than in their metadata, and a SQLite database handle is the
 * case that matters: what the handle holds is the set of table schemas the
 * database was created under, and the rows live in the database file, which
 * nothing here opens. So where no schema was declared and the value is a
 * database handle, its tables are reported as {@link DescribeHandleDatabase}
 * — reduced by the same {@link schemaShapeOnly} pass, with the columns' own
 * `ifc` annotations reported beside them as labels rather than left on the
 * schema. Without that a database reads as an opaque value, and the code an
 * agent writes over an opaque value is code that treats it as one. The read
 * is conditional on there being no declared schema, so a referent that states
 * its own shape is never opened.
 *
 * A run with no fabric session still answers from its own table, so shape
 * stays inspectable in every run that has handles at all.
 *
 * Labels answer beside the shape, from the same synced document, and only
 * where a session read it: a cell's CFC labels live in its own metadata
 * rather than on its schema, so shape and labels are two reads of one
 * document and a run can hold one without the other. What crosses is atom
 * TYPES — the URLs naming what a value requires and what it carries — and not
 * an atom's other fields, which say what a label was computed FROM. That is
 * the same line the shape disclosure draws: a run may know what it is holding
 * and what handling that demands, and may not read what is behind it. A read
 * that fails is reported as a label rather than as no label, so a cell whose
 * metadata could not be interpreted does not read as public.
 */
export const describeHandleToolDescriptor: HarnessToolDescriptor = {
  toolId: "describe_handle",
  title: "Describe Handle",
  description:
    "Report the shape of a general handle's referent and the CFC labels it carries: its recorded schema, path and label atom types, never its data. A held non-cell referent returns its kind and provenance under `referent`, with `hasSchema: false`. A referent that is a SQLite database reports its tables instead of a schema, under `database`: the columns of each table with their types, the labels those columns carry, and under `fill` how many rows each table holds and how many of them are non-NULL in each column. Read `fill` before writing a query: a column whose count is 0 is NULL on every row of this database, so filtering on it returns nothing, and a table reporting `unread` was not counted rather than empty. A table reporting `rowLabelReads` carries a per-row label rule over those columns, and a query over it must select every one of them by its own name — an alias does not stand in for the column — or the read is refused and the refusal arrives on the result's `error` rather than as rows; `rowLabelReadsIncomplete` means the named columns are not the whole of what the rule needs — it reads a column this reply does not name, or it is declared in a shape that cannot be read — so such a query is refused whatever it selects. Read such a referent with `db.query` over the handle rather than as a value. A capability-restricted handle returns a named refusal. Use it to check that a reference is the kind of thing a step expects, and what handling it demands, before passing it on.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      token: {
        type: "string",
        description: "A handle token of the form cfh:a:<suffix>.",
      },
    },
    required: ["token"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    type: "object",
    properties: {
      outputId: { type: "string" },
      token: { type: "string" },
      known: { type: "boolean" },
      hasSchema: { type: "boolean" },
      schema: {},
      path: { type: "array", items: { type: "string" } },
      labels: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "array", items: { type: "string" } },
            confidentiality: {
              type: "array",
              items: { type: "array", items: { type: "string" } },
            },
            integrity: { type: "array", items: { type: "string" } },
          },
          required: ["confidentiality", "integrity"],
          additionalProperties: false,
        },
      },
      database: {
        type: "object",
        properties: {
          tables: {},
          labels: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "array", items: { type: "string" } },
                confidentiality: {
                  type: "array",
                  items: { type: "array", items: { type: "string" } },
                },
                integrity: { type: "array", items: { type: "string" } },
              },
              required: ["confidentiality", "integrity"],
              additionalProperties: false,
            },
          },
          fill: {
            type: "array",
            items: {
              type: "object",
              properties: {
                table: { type: "string" },
                rows: { type: "integer", minimum: 0 },
                nonNull: {
                  type: "object",
                  additionalProperties: { type: "integer", minimum: 0 },
                },
                rowLabelReads: { type: "array", items: { type: "string" } },
                rowLabelReadsIncomplete: { type: "boolean" },
                unread: { type: "string" },
              },
              required: ["table"],
              additionalProperties: false,
            },
          },
        },
        required: ["tables", "labels"],
        additionalProperties: false,
      },
      referent: {
        type: "object",
        properties: {
          kind: { type: "string" },
          source: { type: "string" },
          labelSource: { type: "string" },
        },
        required: ["kind", "source", "labelSource"],
        additionalProperties: false,
      },
      error: { type: "string" },
    },
    required: ["outputId", "token", "known", "hasSchema"],
    additionalProperties: false,
  } satisfies JSONSchema,
  tags: ["handle", "shape"],
};

/**
 * Path segments of `ref`, or `undefined` when the reference names a piece
 * root or does not parse. Parsing is the only work done here — no lookup, no
 * read.
 */
const pathSegmentsOf = (ref: string): string[] | undefined => {
  try {
    const parsed = parseLLMFriendlyLink(
      ref.startsWith("/") ? ref : `/${ref}`,
    );
    return parsed.path.length > 0 ? parsed.path.map(String) : undefined;
  } catch {
    return undefined;
  }
};

/** Full existing CFC metadata across every path of one referent. */
const referentLabel = (view: CfcLabelView | undefined): IFCLabel =>
  (view?.entries ?? []).reduce<IFCLabel>(
    (label, entry) => mergeLabel(label, entry.label),
    {},
  );

/** The properties `schema` declares, empty when it declares none. */
const schemaProperties = (
  schema: JSONSchema | undefined,
): Record<string, JSONSchema> =>
  schema !== undefined && typeof schema === "object" && !Array.isArray(schema)
    ? (schema.properties ?? {}) as Record<string, JSONSchema>
    : {};

/**
 * Every `(table, column)` a reduced table schema still names. The reduction
 * has already dropped whatever it refused, so walking its output rather than
 * its input is what holds a second disclosure to the first one's bound.
 */
function* disclosedColumns(
  reduced: JSONSchema,
): Generator<[string, string]> {
  for (const [table, spec] of Object.entries(schemaProperties(reduced))) {
    for (const column of Object.keys(schemaProperties(spec))) {
      yield [table, column];
    }
  }
}

/** The columns `table` declares in the handle's own tables, as authored. */
const declaredColumns = (
  tables: object,
  table: string,
): Record<string, { ifc?: unknown } | undefined> =>
  ((tables as Record<string, { properties?: unknown } | undefined>)[table]
    ?.properties ?? {}) as Record<string, { ifc?: unknown } | undefined>;

/**
 * The table contract `value` states, or nothing when it is not a SQLite
 * database handle or names no tables. A handle's tables are the schemas the
 * database was created under — a declaration, in the same sense a document's
 * schema is one — so what leaves here is the same structure every other
 * disclosure is reduced to, plus the columns' labels.
 */
const describedDatabase = (
  value: unknown,
): DescribeHandleDatabase | undefined => {
  if (!isSqliteDbRef(value)) {
    return undefined;
  }
  const tables = value.tables;
  if (!isObjectOrArray(tables)) {
    return undefined;
  }
  // Wrapping the tables as one schema's properties is what puts the table
  // names through the same bound and the same reduction the column names
  // already go through: a table is an object whose properties are its
  // columns, which is what the reduction already knows how to walk.
  const reduced = schemaShapeOnly({
    type: "object",
    properties: tables as Record<string, JSONSchema>,
  });
  // A label names the column it came off, so its path is the same
  // property-name channel the reduction bounds — which is why the names it
  // reports are read back off the reduced schema rather than off the tables.
  // A column the reduction refused is a column no label may name either.
  const labels: DescribeHandleLabel[] = [];
  for (const [table, column] of disclosedColumns(reduced)) {
    const ifc = declaredColumns(tables, table)[column]?.ifc;
    if (columnDeclaresIfc(ifc)) {
      labels.push({
        path: [table, column],
        ...cfcLabelAtomTypes(ifc as Parameters<typeof cfcLabelAtomTypes>[0]),
      });
    }
  }
  return { tables: reduced, labels };
};

/**
 * The read-only query a storage provider offers, as much of it as counting
 * needs. A provider that offers none leaves a database uncounted.
 */
type SqliteQueryRunner = (
  db: SqliteDbRef,
  sql: string,
) => Promise<SqliteQueryResult>;

/** `name` as a SQLite identifier, quoted so no name can carry structure. */
const quoteIdentifier = (name: string): string =>
  `"${name.replaceAll('"', '""')}"`;

/**
 * Counts one table: its rows, and each of `columns` non-NULL over those rows.
 *
 * One statement per table, aliasing each count to a name this builds rather
 * than to the column's own, so nothing a column is called can collide with
 * the row count or with another alias.
 */
const countTableSql = (
  table: string,
  columns: readonly string[],
): string => {
  const counts = columns.map((column, index) =>
    `COUNT(${quoteIdentifier(column)}) AS ${quoteIdentifier(`c${index}`)}`
  );
  return `SELECT COUNT(*) AS "n"${
    counts.length === 0 ? "" : `, ${counts.join(", ")}`
  } FROM ${quoteIdentifier(table)}`;
};

/** A count a query returned, or `undefined` for anything that is not one. */
const countOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * The row-label rule's input columns for `table`, as much of them as this
 * disclosure may name.
 *
 * Read off the declaration the runner itself evaluates rather than restated
 * here, so the two cannot disagree about what a query has to project. Held to
 * the same bound every other name in this reply is held to: a column the
 * reduction refused is a column no rule may name either, and dropping one
 * silently would hand back a list that looks like the whole requirement and
 * is not — so a dropped input is reported as withheld.
 */
const rowLabelReadsOf = (
  db: SqliteDbRef,
  table: string,
  disclosed: readonly string[],
): Pick<
  DescribeHandleTableFill,
  "rowLabelReads" | "rowLabelReadsIncomplete"
> => {
  const tables = db.tables as Record<string, unknown> | undefined;
  const declared = tables?.[table];
  // Gated on the predicate the RUNNER uses, not on whether a spec can be read
  // here: the two disagree on a `rowLabel` that is present but not an object,
  // which the runner counts as rule-bearing and then refuses as an invalid
  // rule. Reporting no rule for that table would describe a query that gets
  // refused as one that works, which is the whole failure this disclosure
  // exists to prevent.
  if (!tableDeclaresRowLabel(declared)) {
    return {};
  }
  const spec = rowLabelSpecOf(declared);
  // Validated with the runner's own validator, against the table's DECLARED
  // columns rather than the disclosed ones — the rule may legitimately read a
  // column this reply withholds, and judging it against what was disclosed
  // would call a good rule invalid. Its own contract is the reason this runs
  // at all: "couldn't validate" is never "no label", and a rule this build
  // cannot validate is one the runner refuses queries over.
  const columns = declaredColumns(tables ?? {}, table);
  if (
    spec === undefined ||
    validateRowLabelSpec(spec, Object.keys(columns), columns) !== undefined
  ) {
    // Declared, and not a rule this build can read or accept. There is a
    // requirement and no column to name for it: the incomplete case.
    return { rowLabelReadsIncomplete: true };
  }
  const named = new Set(disclosed);
  const inputs = ruleInputFields(spec);
  const reads = inputs.filter((field) => named.has(field));
  return {
    ...(reads.length > 0 ? { rowLabelReads: reads } : {}),
    ...(reads.length < inputs.length ? { rowLabelReadsIncomplete: true } : {}),
  };
};

/**
 * How full each disclosed table of `db` is, read through the session's
 * storage provider.
 *
 * The tables walked are the reduced ones, so a table or column the disclosure
 * refused is not counted either and cannot be learned of here. Each table is
 * counted on its own, so one that cannot be read — a declared table the file
 * does not hold, a statement the server refused — costs its own counts and
 * none of the others, and says so in place of them.
 *
 * One statement per table, and a count over a column is a scan of it, so the
 * work here grows with the database rather than with the reply. That is the
 * price of the reading: what a count buys is the difference between a column a
 * query can filter on and one that is NULL throughout, and nothing cheaper
 * than reading the column establishes it.
 */
const readDatabaseFill = async (
  provider: { sqliteQuery?: SqliteQueryRunner },
  db: SqliteDbRef,
  reduced: JSONSchema,
): Promise<DescribeHandleTableFill[] | undefined> => {
  if (provider.sqliteQuery === undefined) {
    return undefined;
  }
  const fill: DescribeHandleTableFill[] = [];
  for (const [table, spec] of Object.entries(schemaProperties(reduced))) {
    const columns = Object.keys(schemaProperties(spec));
    // Stated whether or not the counts arrive: what a query must project is a
    // property of the declaration, and a table that could not be counted
    // still has to be queried correctly.
    const rule = rowLabelReadsOf(db, table, columns);
    let row: Record<string, unknown> | undefined;
    try {
      // Called on the provider rather than through a name lifted off it: the
      // storage provider is an object whose query reads its own state, and a
      // detached call arrives with no receiver.
      const result = await provider.sqliteQuery(
        db,
        countTableSql(table, columns),
      );
      const first = result.rows[0];
      row = !isObjectOrArray(first)
        ? undefined
        : first as Record<string, unknown>;
    } catch (error) {
      fill.push({
        table,
        ...rule,
        unread: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const rows = countOf(row?.n);
    if (rows === undefined) {
      fill.push({
        table,
        ...rule,
        unread: "the count query returned no row count",
      });
      continue;
    }
    const nonNull: Record<string, number> = {};
    for (const [index, column] of columns.entries()) {
      const count = countOf(row?.[`c${index}`]);
      if (count !== undefined) {
        nonNull[column] = count;
      }
    }
    fill.push({ table, rows, nonNull, ...rule });
  }
  return fill;
};

/**
 * The schema declared for the referent at `path`, or nothing when none is.
 * A document's declared schema narrowed by a path is a walk over the schema
 * rather than a read of the data, so nothing here goes near a value; the
 * referent's own schema is the last resort, since with no declared schema
 * there is nothing to walk.
 */
const declaredSchema = async (
  root: Cell<unknown>,
  referent: Cell<unknown>,
  path: readonly (string | number)[],
  documentSchema: JSONSchema | undefined,
): Promise<JSONSchema | undefined> => {
  if (path.length === 0) {
    return documentSchema ?? root.schema;
  }
  if (documentSchema !== undefined) {
    return ((root.asSchema(documentSchema) as Cell<unknown>).key(
      ...path,
    ) as Cell<unknown>).schema;
  }
  await referent.sync();
  return referent.schema;
};

/**
 * The referent's table contract as a fragment to spread, empty where it has
 * none. The read is permissive-schema and resolving because a handle written
 * before the sqlite builtin stored it inline can hold links where its table
 * schemas belong, and the SqliteDb shape declares no properties, so a shaped
 * read would reduce the handle to `{}`.
 */
const databaseOf = (
  referent: Cell<unknown>,
): { database?: DescribeHandleDatabase; ref?: SqliteDbRef } => {
  const value = referent.asSchema({
    type: "object",
    additionalProperties: true,
  })
    .get();
  const database = describedDatabase(value);
  return database === undefined || !isSqliteDbRef(value)
    ? {}
    : { database, ref: value };
};

/** What the session can state about `ref`: its declared shape, and its labels. */
interface DescribedReferent {
  schema?: JSONSchema;
  labels?: DescribeHandleLabel[];
  database?: DescribeHandleDatabase;
  cfcLabel?: IFCLabel;
  cfcLabelAvailable?: boolean;
}

/**
 * What `ref` DECLARES in the session's fabric, or nothing when the session
 * cannot state it. A document's declared schema lives in its metadata — for a
 * piece it is the result schema of the pattern behind it — and a reference
 * into the document narrows that schema by its path, which is a walk over the
 * schema rather than a read of the data. The labels come off the same synced
 * document, rebased onto the referent's own path, so one read answers both.
 *
 * References are followed within the session's space and operator-admitted
 * foreign spaces, under the session's identity and CFC posture. Anything that
 * goes wrong — an unparseable reference, a document
 * that does not exist, a path the schema does not describe — answers nothing,
 * since what the session cannot state is reported as absent rather than as a
 * failed call.
 */
const describeInFabric = async (
  session: HarnessFabricSession,
  ref: string,
): Promise<DescribedReferent> => {
  const { pieces } = session;
  const space = pieces.getSpace();
  let link;
  try {
    link = parseLLMFriendlyLink(ref.startsWith("/") ? ref : `/${ref}`, space);
  } catch {
    return {};
  }
  if (!admitsFabricReference(link.space, space, session.foreignSpaces)) {
    return {};
  }
  try {
    const root = pieces.runtime.getCellFromLink({
      ...link,
      path: [],
      schema: undefined,
    });
    await root.sync();
    // The labels are the synced document's own metadata, narrowed to the
    // referent's path by the view, so they cost no read beyond the one the
    // shape already needed.
    const referent =
      (link.path.length === 0 ? root : root.key(...link.path)) as Cell<unknown>;
    const { view: labelView, readFailed } =
      cfcLabelViewForCellFailClosedWithStatus(referent);
    const labels = disclosedCfcLabels(labelView);
    const cfcLabel = referentLabel(labelView);
    const cfcLabelAvailable = !readFailed;
    const documentSchema = readResultSchemaMeta(root);
    const declared = await declaredSchema(
      root,
      referent,
      link.path,
      documentSchema,
    );
    if (declared !== undefined) {
      return {
        labels,
        schema: declared,
        cfcLabel,
        cfcLabelAvailable,
      };
    }
    // Nothing was declared, so the referent's own value is the only place a
    // contract can still be stated, and a database handle states one there.
    const { database, ref: db } = databaseOf(referent);
    if (database === undefined || db === undefined) {
      return { labels, cfcLabel, cfcLabelAvailable };
    }
    // The counts are read after the contract rather than with it, so a
    // database that discloses its tables still discloses them when nothing
    // could be counted.
    const fill = await readDatabaseFill(
      pieces.runtime.storageManager.open(link.space),
      db,
      database.tables,
    );
    return {
      labels,
      database: fill === undefined ? database : { ...database, fill },
      cfcLabel,
      cfcLabelAvailable,
    };
  } catch {
    return {};
  }
};

/** Private sidecar used to carry exact existing labels into research. */
export interface DescribeHandleResearchResult {
  /** Ordinary safe shape-only result shown to the research model. */
  output: DescribeHandleToolOutput;

  /** Full existing referent label, including integrity, when readable. */
  cfcLabel?: IFCLabel;

  /** Distinguishes a known clean label from unavailable label metadata. */
  cfcLabelAvailable: boolean;
}

const invokeDescribeHandle = async (
  context: HarnessToolContext,
  input: DescribeHandleToolInput,
): Promise<DescribeHandleResearchResult> => {
  const outputId = context.nextOutputId("describe_handle");
  const token = typeof input.token === "string" ? input.token.trim() : "";
  const referent = context.handleTable === undefined
    ? undefined
    : resolveReferentToken(context.handleTable, token);
  if (referent !== undefined) {
    // A held referent that is not a cell. The model saw its content when the
    // tool returned it; what is reported here is what it is and the atom
    // types of the label it was admitted under.
    return {
      output: {
        outputId,
        token: referent.token,
        known: true,
        hasSchema: false,
        referent: {
          kind: referent.kind,
          source: referent.source,
          labelSource: referent.labelSource,
        },
        labels: [{ path: [], ...cfcLabelAtomTypes(referent.label) }],
      },
      cfcLabel: referent.label,
      cfcLabelAvailable: true,
    };
  }
  const entry = context.handleTable === undefined
    ? undefined
    : resolveHandleToken(context.handleTable, token);
  if (entry === undefined) {
    // An unknown token is an ordinary answer, not a failure: a token from
    // another run, or one the model invented, simply names nothing here.
    return {
      output: {
        outputId,
        token,
        known: false,
        hasSchema: false,
      },
      cfcLabelAvailable: false,
    };
  }
  if (entry.capability === "skill-context") {
    return {
      output: {
        outputId,
        token: entry.token,
        known: true,
        hasSchema: false,
        error:
          "describe_handle cannot consume a skill-context handle; only delegate_task skillHandle can",
      },
      cfcLabelAvailable: false,
    };
  }
  const path = pathSegmentsOf(entry.ref);
  // What the referent DECLARES answers first, because the question asked is
  // what is at this address and the document at it is the authority on
  // that. A recorded schema is second-best — it is what whichever step
  // minted the handle happened to know — and it answers when the run has no
  // session, or when the session can state no shape for the address.
  let described: DescribedReferent = {};
  if (context.getFabricSession !== undefined) {
    try {
      described = await describeInFabric(
        await context.getFabricSession(),
        entry.ref,
      );
    } catch {
      // A session that cannot be established leaves the record to answer,
      // which is what a run without one does anyway.
    }
  }
  const schema = described.schema ??
    (entry.schemaSource === "harness" ? entry.schema : undefined);
  // Structure only: whatever the source, the reported schema is rebuilt
  // from structural keywords, so no value and no prose rides out on it.
  const disclosed = schema === undefined ? undefined : schemaShapeOnly(schema);
  return {
    output: {
      outputId,
      token: entry.token,
      known: true,
      hasSchema: disclosed !== undefined,
      ...(disclosed !== undefined ? { schema: disclosed } : {}),
      ...(path !== undefined ? { path } : {}),
      ...(described.labels !== undefined ? { labels: described.labels } : {}),
      ...(described.database !== undefined
        ? { database: described.database }
        : {}),
    },
    ...(described.cfcLabel !== undefined ||
        described.cfcLabelAvailable === true
      ? {
        cfcLabel: structuredClone(described.cfcLabel ?? {}),
      }
      : {}),
    cfcLabelAvailable: described.cfcLabelAvailable === true,
  };
};

/** Describes a handle while retaining exact label metadata for research. */
export const describeHandleForResearch = invokeDescribeHandle;

export const describeHandleTool: HarnessToolDefinition<
  DescribeHandleToolInput,
  DescribeHandleToolOutput
> = {
  descriptor: describeHandleToolDescriptor,
  async invoke(context, input) {
    return (await invokeDescribeHandle(context, input)).output;
  },
};
