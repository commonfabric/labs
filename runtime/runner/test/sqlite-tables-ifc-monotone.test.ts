import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { growOnlyMergeDbTables } from "../src/builtins/sqlite-builtins.ts";

// Audit S8: a db handle's per-column `ifc` lives in mutable handle-cell value
// data, outside the schema-envelope monotonicity the labelMap enforces. A
// re-derivation reading a weaker `tables` input could silently lower a column's
// read label or widen its write ceiling — a store's effective label going DOWN,
// which §8.12.1 forbids. growOnlyMergeDbTables clamps every re-derivation to be
// monotone (strengthen-only) against the prior committed handle value.
const table = (
  cols: Record<string, Record<string, unknown>>,
) => ({ type: "object", properties: cols });

describe("growOnlyMergeDbTables (audit S8)", () => {
  it("passes the declared tables through unchanged on first creation", () => {
    const next = {
      emails: table({ from: { ifc: { confidentiality: ["sender"] } } }),
    };
    expect(growOnlyMergeDbTables(undefined, next)).toEqual(next);
  });

  it("keeps a prior read label that a re-derivation tries to DROP", () => {
    const prior = {
      emails: table({ from: { ifc: { confidentiality: ["sender"] } } }),
    };
    // Attacker / weaker re-declaration: the column loses its ifc.
    const next = { emails: table({ from: {} }) };
    const merged = growOnlyMergeDbTables(prior, next) as Record<string, {
      properties: Record<string, { ifc?: { confidentiality?: unknown[] } }>;
    }>;
    expect(merged.emails.properties.from.ifc?.confidentiality).toEqual([
      "sender",
    ]);
  });

  it("unions confidentiality (read label may strengthen)", () => {
    const prior = {
      t: table({ c: { ifc: { confidentiality: ["a"] } } }),
    };
    const next = {
      t: table({ c: { ifc: { confidentiality: ["b"] } } }),
    };
    const merged = growOnlyMergeDbTables(prior, next) as Record<string, {
      properties: Record<string, { ifc?: { confidentiality?: unknown[] } }>;
    }>;
    expect(merged.t.properties.c.ifc?.confidentiality).toEqual(["a", "b"]);
  });

  it("does NOT union integrity: a re-declared claim can't mint trust", () => {
    // Integrity atoms are trust claims that satisfy downstream requiredIntegrity
    // gates. Prior trusted the column for ["x"]; a re-derivation declaring ["y"]
    // must NOT yield ["x","y"] — that would forge a claim "y" the store never had
    // (and re-derivations read potentially-weaker inputs). Subset-clamp instead.
    const prior = {
      t: table({ c: { ifc: { integrity: ["x"] } } }),
    };
    const next = {
      t: table({ c: { ifc: { integrity: ["y"] } } }),
    };
    const merged = growOnlyMergeDbTables(prior, next) as Record<string, {
      properties: Record<string, { ifc?: { integrity?: unknown[] } }>;
    }>;
    // "y" was never trusted and "x" was not re-asserted: intersection is empty.
    expect(merged.t.properties.c.ifc?.integrity).toBeUndefined();
  });

  it("never mints integrity on a column the prior store didn't trust", () => {
    // Prior column carries a read label but NO integrity. A re-derivation adding
    // integrity would mint trust from nothing — clamp it away.
    const prior = {
      t: table({ c: { ifc: { confidentiality: ["a"] } } }),
    };
    const next = {
      t: table({
        c: { ifc: { confidentiality: ["a"], integrity: ["forged"] } },
      }),
    };
    const merged = growOnlyMergeDbTables(prior, next) as Record<string, {
      properties: Record<
        string,
        { ifc?: { confidentiality?: unknown[]; integrity?: unknown[] } }
      >;
    }>;
    expect(merged.t.properties.c.ifc?.integrity).toBeUndefined();
    expect(merged.t.properties.c.ifc?.confidentiality).toEqual(["a"]);
  });

  it("allows integrity to NARROW (subset re-declaration)", () => {
    const prior = {
      t: table({ c: { ifc: { integrity: ["a", "b"] } } }),
    };
    const next = {
      t: table({ c: { ifc: { integrity: ["a"] } } }),
    };
    const merged = growOnlyMergeDbTables(prior, next) as Record<string, {
      properties: Record<string, { ifc?: { integrity?: unknown[] } }>;
    }>;
    expect(merged.t.properties.c.ifc?.integrity).toEqual(["a"]);
  });

  it("never widens a write ceiling: a present ceiling can't be removed", () => {
    const prior = {
      t: table({ c: { ifc: { maxConfidentiality: ["lo"] } } }),
    };
    // Re-derivation drops the ceiling (would make the column unlimited).
    const next = { t: table({ c: {} }) };
    const merged = growOnlyMergeDbTables(prior, next) as Record<string, {
      properties: Record<
        string,
        { ifc?: { maxConfidentiality?: unknown[] } }
      >;
    }>;
    expect(merged.t.properties.c.ifc?.maxConfidentiality).toEqual(["lo"]);
  });

  it("tightens a write ceiling to the intersection when both are present", () => {
    const prior = {
      t: table({ c: { ifc: { maxConfidentiality: ["a", "b"] } } }),
    };
    const next = {
      t: table({ c: { ifc: { maxConfidentiality: ["b", "c"] } } }),
    };
    const merged = growOnlyMergeDbTables(prior, next) as Record<string, {
      properties: Record<
        string,
        { ifc?: { maxConfidentiality?: unknown[] } }
      >;
    }>;
    // Only the meet survives — the smaller allowed set.
    expect(merged.t.properties.c.ifc?.maxConfidentiality).toEqual(["b"]);
  });

  it("keeps a disjoint ceiling intersection as [] (public-only), not absent", () => {
    // The verifier reads `undefined` as "no ceiling" but `[]` as "public only"
    // (the tightest ceiling). Two ceilings with no atom in common must meet at
    // [], NOT collapse to undefined — that would forge an unlimited ceiling.
    const prior = { t: table({ c: { ifc: { maxConfidentiality: ["a"] } } }) };
    const next = { t: table({ c: { ifc: { maxConfidentiality: ["b"] } } }) };
    const merged = growOnlyMergeDbTables(prior, next) as Record<string, {
      properties: Record<
        string,
        { ifc?: { maxConfidentiality?: unknown[] } }
      >;
    }>;
    expect(merged.t.properties.c.ifc?.maxConfidentiality).toEqual([]);
  });

  it("restores a labeled table that a re-derivation drops entirely", () => {
    const prior = {
      secrets: table({ k: { ifc: { confidentiality: ["s"] } } }),
    };
    const next = { other: table({ x: {} }) };
    const merged = growOnlyMergeDbTables(prior, next) as Record<string, {
      properties: Record<string, { ifc?: { confidentiality?: unknown[] } }>;
    }>;
    expect(merged.secrets.properties.k.ifc?.confidentiality).toEqual(["s"]);
    expect(merged.other).toBeDefined();
  });

  it("restores a labeled column dropped from a still-present table", () => {
    const prior = {
      t: table({
        secret: { type: "string", ifc: { confidentiality: ["s"] } },
        plain: { type: "string" },
      }),
    };
    // Table stays, but the labeled column is removed entirely.
    const next = { t: table({ plain: { type: "string" } }) };
    const merged = growOnlyMergeDbTables(prior, next) as Record<string, {
      properties: Record<
        string,
        { type?: string; ifc?: { confidentiality?: unknown[] } }
      >;
    }>;
    // The whole column comes back — its non-ifc structure (`type`) included.
    expect(merged.t.properties.secret.type).toEqual("string");
    expect(merged.t.properties.secret.ifc?.confidentiality).toEqual(["s"]);
    expect(merged.t.properties.plain).toBeDefined();
  });

  it("lets new columns and a stricter re-declaration through", () => {
    const prior = { t: table({ a: { ifc: { confidentiality: ["x"] } } }) };
    const next = {
      t: table({
        // Stricter via confidentiality (a read label only grows). Adding
        // integrity here would be a mint, covered by its own test above.
        a: { ifc: { confidentiality: ["x", "more"] } },
        b: { ifc: { confidentiality: ["y"] } }, // new column
      }),
    };
    const merged = growOnlyMergeDbTables(prior, next) as Record<string, {
      properties: Record<
        string,
        { ifc?: { confidentiality?: unknown[] } }
      >;
    }>;
    expect(merged.t.properties.a.ifc?.confidentiality).toEqual(["x", "more"]);
    expect(merged.t.properties.b.ifc?.confidentiality).toEqual(["y"]);
  });
});
