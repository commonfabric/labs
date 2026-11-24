import type { SqliteQueryRow } from "../index.ts";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

describe("SQLite query row types", () => {
  it("exposes reserved aliases as entry rows", () => {
    type ReservedRow = SqliteQueryRow<{
      constructor: number;
      __proto__: string;
      label: string;
    }>;
    const row: ReservedRow = [
      ["constructor", 7],
      ["__proto__", "safe"],
      ["label", "kept"],
    ];

    expect(row).toEqual([
      ["constructor", 7],
      ["__proto__", "safe"],
      ["label", "kept"],
    ]);

    const readAsObject = (value: ReservedRow) => {
      // @ts-expect-error Reserved aliases use entries, not object properties.
      return value.constructor.toFixed();
    };
    expect(typeof readAsObject).toBe("function");
  });

  it("keeps ordinary typed rows as objects", () => {
    const row: SqliteQueryRow<{ id: number; label: string }> = {
      id: 1,
      label: "kept",
    };

    expect(row.label).toBe("kept");
  });

  it("exposes entry rows as possible for indexed row types", () => {
    type IndexedRow = SqliteQueryRow<
      Record<string, unknown> & { constructor: number }
    >;
    const row: IndexedRow = [["constructor", 7]];

    expect(row).toEqual([["constructor", 7]]);

    const readAsObject = (value: IndexedRow) => {
      // @ts-expect-error Indexed rows can arrive as reserved-key entries.
      return value.constructor.toFixed();
    };
    expect(typeof readAsObject).toBe("function");
  });
});
