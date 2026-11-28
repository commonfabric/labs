// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * The owner's fixes as a connector would store them: rows of a SQLite table
 * whose per-row rule names the label, rather than a cell typed with it. This
 * is step 2 of top/3599 comment 7: whether a `PolicyOf` alternative written
 * into a row rule survives the query's read path and releases through the
 * policy's rules, before loom's connector labels are changed to carry one.
 *
 * Three tables hold the same rows under three rules:
 *
 * - `custody`: `constant(PolicyOf<locationRules>)` alone, the row-rule form
 *   of the cell fixture's `OwnerLocation` source.
 * - `shared_owner`: `any(dbOwner(), constant(PolicyOf<locationRules>))`, the
 *   `anyOf(User{owner}, PolicyOf<rules>)` shape comment 6 proposes for
 *   connector rows.
 * - `owner_only`: `dbOwner()`, today's connector shape.
 *
 * A row rule is a value and `PolicyOf` is a type, so the policy's atom is
 * taken from the compiled schema of `OwnerLocation`. A connector would write
 * the same atom into its label profile; it has no compiler to take it from,
 * which is why comment 7 asks for a system policy with a pinned digest.
 */
import {
  cfSqlite,
  handler,
  NAME,
  pattern,
  sqliteDatabase,
  type SqliteDb,
  Stream,
  toSchema,
} from "commonfabric";
import { type Fix, type OwnerLocation } from "./policy.tsx";

/** A schema whose confidentiality is `PolicyOf<locationRules>`. */
const POLICY_SCHEMA = toSchema<OwnerLocation<string>>();

const SELECT = (table: string) =>
  `SELECT lat, lon, at FROM ${table} ORDER BY at`;

export interface SqliteSourceOutput {
  [NAME]: string;
  /** The atom the two policy tables name, for the test to inspect. */
  policyAtom: { policyRefKind?: string } | undefined;
  custody: Fix[] | undefined;
  sharedOwner: Fix[] | undefined;
  ownerOnly: Fix[] | undefined;
  /** Writes `FIXES` into all three tables. */
  seed: Stream<Fix[]>;
}

const seedFixes = handler<Fix[], { db: SqliteDb }>((fixes, { db }) => {
  for (const table of ["custody", "shared_owner", "owner_only"]) {
    for (const fix of fixes) {
      db.exec(`INSERT INTO ${table} (lat, lon, at) VALUES (?, ?, ?)`, [
        fix.lat,
        fix.lon,
        fix.at,
      ]);
    }
  }
});

export default pattern<Record<string, never>, SqliteSourceOutput>(() => {
  const { table, any, constant, dbOwner } = cfSqlite;
  /** The compiled atom `PolicyOf<locationRules>` lowers to. */
  const POLICY_ATOM = (POLICY_SCHEMA as {
    ifc?: { confidentiality?: readonly unknown[] };
  }).ifc?.confidentiality?.[0];
  const COLUMNS = {
    id: "integer primary key",
    lat: "real",
    lon: "real",
    at: "integer",
  } as const;
  const db = sqliteDatabase({
    tables: {
      custody: table(COLUMNS, () => ({
        confidentiality: constant(POLICY_ATOM),
      })),
      shared_owner: table(COLUMNS, () => ({
        confidentiality: any(dbOwner(), constant(POLICY_ATOM)),
      })),
      owner_only: table(COLUMNS, () => ({ confidentiality: dbOwner() })),
    },
  });
  const custody = db.query<Fix>(SELECT("custody"), { reactOn: db });
  const sharedOwner = db.query<Fix>(SELECT("shared_owner"), { reactOn: db });
  const ownerOnly = db.query<Fix>(SELECT("owner_only"), { reactOn: db });
  return {
    [NAME]: "Owner's fixes in SQLite",
    policyAtom: POLICY_ATOM as { policyRefKind?: string } | undefined,
    custody: custody.result,
    sharedOwner: sharedOwner.result,
    ownerOnly: ownerOnly.result,
    seed: seedFixes({ db }),
  };
});
