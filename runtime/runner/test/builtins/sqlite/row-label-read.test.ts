import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { constant, whenMatches } from "@commonfabric/memory/sqlite/row-label";
import { table } from "@commonfabric/memory/sqlite/schema";

import { computeRowLabelRead } from "../../../src/builtins/sqlite/row-label-read.ts";

const tables = {
  notes: table(
    { id: "integer primary key", tag: "text" },
    (f) => ({
      confidentiality: whenMatches(f.tag, /^secret$/, constant("did:tag:x")),
    }),
  ),
};

const columns = [{ output: "tag", table: "notes", column: "tag" }];

describe("computeRowLabelRead()", () => {
  it("returns an error naming a result row that is not an object", () => {
    expect(
      computeRowLabelRead({
        tables,
        columns,
        rows: [{ tag: "secret" }, ["secret"]],
      }),
    ).toEqual({ error: "sqlite: result row 1 is not an object" });
    expect(
      computeRowLabelRead({ tables, columns, rows: [{ tag: "secret" }] }),
    ).toMatchObject({ labels: [{ confidentiality: ["did:tag:x"] }] });
  });
});
