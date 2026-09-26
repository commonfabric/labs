import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import * as policy from "./policy.ts";

// A dial nobody documented is a number that decides what runs and cannot
// be found, so the two halves of this module are held to each other.
const NAMED_IN_TABLE = new Set(policy.DIALS.map((dial) => dial.name));
const EXPORTED_DIALS = Object.keys(policy).filter((name) =>
  /^[A-Z][A-Z0-9_]*$/.test(name) && name !== "DIALS"
);

/** The live document the dial table lives in, from the repository root. */
const DIAL_TABLE_PATH = "docs/development/test-selection.md";

/** The dial table's header row, which is how the table is found. */
const DIAL_TABLE_HEADER =
  "| Dial | Default | Units | Set by | Why you would move it, and which way |";

/** One line of a cell, unwrapped and with its pipes unescaped. */
function flatten(text: string): string {
  return text.replace(/\\\|/g, "|").replace(/\s+/g, " ").trim();
}

/** The same, without the backticks a cell puts around a name. */
function unquoted(text: string): string {
  return flatten(text).replace(/`/g, "");
}

/** A table row's cells. A cell escapes any `|` it holds. */
function tableCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return inner.split(/(?<!\\)\|/).map(flatten);
}

/** The dial table's columns after the first, which names the dial. */
const DIAL_TABLE_COLUMNS = tableCells(DIAL_TABLE_HEADER).slice(1);

/**
 * The dial table's rows, each one its cells with the dial's name first.
 * `policy.ts` wraps its strings at 72 columns and the table writes each
 * row on one line, so both sides are flattened before anything is
 * compared.
 */
function dialTable(): string[][] {
  const lines = Deno.readTextFileSync(
    new URL(`../../${DIAL_TABLE_PATH}`, import.meta.url),
  ).split("\n");
  const headers = lines.flatMap((line, at) =>
    flatten(line) === flatten(DIAL_TABLE_HEADER) ? [at] : []
  );
  if (headers.length !== 1) {
    throw new Error(
      `${DIAL_TABLE_PATH} holds ${headers.length} dial tables and takes ` +
        "exactly one. It is the documented copy of `DIALS` in " +
        "`tasks/test-selection/policy.ts`, and it belongs in a live " +
        "document, which an archived one is not. Point `DIAL_TABLE_PATH` " +
        "at the live document holding it.",
    );
  }
  const rows: string[][] = [];
  for (const line of lines.slice(headers[0]! + 2)) {
    if (!line.trimStart().startsWith("|")) break;
    rows.push(tableCells(line));
  }
  return rows;
}

describe("policy", () => {
  describe("the dial table", () => {
    it("names every exported dial", () => {
      const missing = EXPORTED_DIALS.filter((name) =>
        !NAMED_IN_TABLE.has(name)
      );
      expect(missing).toEqual([]);
    });

    it("names nothing this module does not export", () => {
      const exported = new Set(EXPORTED_DIALS);
      const strays = policy.DIALS.map((dial) => dial.name).filter((name) =>
        !exported.has(name)
      );
      expect(strays).toEqual([]);
    });

    it("gives every dial a unit and a reason to move it", () => {
      for (const dial of policy.DIALS) {
        expect(dial.unit.length).toBeGreaterThan(0);
        expect(dial.why.length).toBeGreaterThan(0);
      }
    });

    it("lists each dial once", () => {
      expect(NAMED_IN_TABLE.size).toBe(policy.DIALS.length);
    });
  });

  describe("the dial table in the guide", () => {
    // `DIALS` and the table in the documentation are two copies of one
    // set of decisions, and a reader reaches for whichever is nearer.
    // Each cell is compared on its own, so a mismatch names the dial and
    // the column it is in.

    it("holds one row per dial and no row without one", () => {
      expect(dialTable().map((row) => unquoted(row[0]!)))
        .toEqual(policy.DIALS.map((dial) => dial.name));
    });

    it("gives every dial the value, unit, source, and reason `policy.ts` gives it", () => {
      const rows = dialTable();
      const disagreements: string[] = [];
      for (const dial of policy.DIALS) {
        const row = rows.find((cells) => unquoted(cells[0]!) === dial.name);
        if (row === undefined) {
          disagreements.push(
            `${dial.name}: ${DIAL_TABLE_PATH} carries no row for it`,
          );
          continue;
        }
        const inCode = [
          policy.dialValue(dial),
          dial.unit,
          dial.setBy,
          dial.why,
        ];
        DIAL_TABLE_COLUMNS.forEach((column, index) => {
          const documented = row[index + 1] ?? "";
          const code = flatten(inCode[index]!);
          if (documented !== code) {
            disagreements.push(
              `${dial.name} ${column}: ${DIAL_TABLE_PATH} says ` +
                `"${documented}", \`policy.ts\` says "${code}"`,
            );
          }
        });
      }
      expect(disagreements).toEqual([]);
    });
  });

  describe("the values that constrain each other", () => {
    it("keeps the lane budget inside the lane's bound", () => {
      expect(policy.LANE_BUDGET_SECONDS).toBe(
        policy.LANE_BOUND_SECONDS - policy.LANE_PROLOGUE_SECONDS -
          policy.LANE_SAFETY_SECONDS,
      );
      expect(policy.LANE_BUDGET_SECONDS).toBeGreaterThan(0);
    });

    it("splits the whole budget across the three filling passes", () => {
      const shares = policy.FILL_VALUE_SHARE + policy.FILL_DENSITY_SHARE +
        policy.FILL_EXPLORATION_SHARE;
      expect(shares).toBeCloseTo(1, 10);
    });

    it("splits the whole score across the three weights", () => {
      const weights = policy.WEIGHT_PROVEN + policy.WEIGHT_BREADTH +
        policy.WEIGHT_CHURN;
      expect(weights + policy.VALUE_FLOOR).toBeCloseTo(1, 10);
    });

    it("climbs the execution count with the rate, up to its cap", () => {
      expect(policy.FLAKE_ANCHOR_EXECUTIONS).toBeGreaterThan(
        policy.FLAKE_MIN_EXECUTIONS,
      );
      expect(policy.MAX_EXECUTIONS).toBeGreaterThanOrEqual(
        policy.FLAKE_ANCHOR_EXECUTIONS,
      );
      expect(policy.FLAKE_MIN_EXECUTIONS).toBeGreaterThan(1);
    });

    it("anchors the count past the rate that stops a test being picked", () => {
      // The line is allowed past the exclusion, and has to be: what
      // reaches a lane above that rate is a change that edits the test,
      // and the count is what makes it prove itself.
      expect(policy.FLAKE_ANCHOR_RATE).toBeGreaterThan(
        policy.FLAKE_EXCLUSION_RATE,
      );
    });

    it("reads churn over a window its decay has faded", () => {
      // Past four half-lives a day's weight is under one part in sixteen,
      // which is what makes that read window a performance choice. The
      // flake window has no such property, since its decay is by runs.
      expect(policy.CHURN_WINDOW_DAYS).toBeGreaterThanOrEqual(
        4 * policy.CHURN_HALF_LIFE_DAYS,
      );
    });
  });

  describe("the coverage exclusion list", () => {
    it("gives every excluded member a reason", () => {
      for (const [member, reason] of policy.EXCLUDED_FROM_COVERAGE_GATE) {
        expect(member.startsWith("packages/")).toBe(true);
        expect(reason.length).toBeGreaterThan(0);
      }
    });
  });

  describe("exclusionKind()", () => {
    it("returns `size` for a member on the list for its size", () => {
      expect(policy.exclusionKind("packages/runner")).toBe("size");
    });

    it("returns `source` for a member on the list for what measures it", () => {
      expect(policy.exclusionKind("packages/cli")).toBe("source");
    });

    it("returns `undefined` for a member not on the list", () => {
      expect(policy.exclusionKind("packages/memory")).toBeUndefined();
    });
  });
});
