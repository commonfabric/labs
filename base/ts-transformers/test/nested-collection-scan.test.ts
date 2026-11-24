import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { validateSource } from "./utils.ts";

async function warnings(body: string) {
  const result = await validateSource(
    `
    import {pattern,computed} from "commonfabric";
    export default pattern<{rows:{key:string;children:string[]}[];other:{key:string}[];collections:string[][]}>(({rows,other,collections})=>{
      ${body}
    });
  `,
    { types: COMMONFABRIC_TYPES, typeCheck: true },
  );
  expect(
    result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
  ).toEqual([]);
  return result.diagnostics.filter((diagnostic) =>
    diagnostic.type === "collection:nested-scan"
  );
}

describe("nested collection scan warnings", () => {
  it("warns for a captured collection scanned per reactive row", async () => {
    const found = await warnings(
      "return rows.map(row=>other.filter(item=>item.key===row.key));",
    );
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
  });
  it("leaves a row's own child collection unreported", async () => {
    expect(
      await warnings("return rows.map(row=>row.children.map(child=>child));"),
    ).toHaveLength(0);
  });
  it("leaves plain local arrays unreported", async () => {
    expect(
      await warnings(
        'const plain=["a","b"]; return rows.map(row=>({key:row.key,values:plain.map(item=>item)}));',
      ),
    ).toHaveLength(0);
  });
  it("leaves sequential scans unreported", async () => {
    expect(
      await warnings(
        "return {left:rows.map(row=>row.key),right:other.map(item=>item.key)};",
      ),
    ).toHaveLength(0);
  });
  it("leaves shared work computed outside the enclosing scan unreported", async () => {
    expect(
      await warnings(
        "const shared = other.map(item=>item.key); return rows.map(row=>({key:row.key,shared}));",
      ),
    ).toHaveLength(0);
  });
  it("recognizes a captured collection through a const alias", async () => {
    expect(
      await warnings(
        "const candidates=other; return rows.map(row=>candidates.filter(item=>item.key===row.key));",
      ),
    ).toHaveLength(1);
  });

  it("preserves the warning through parenthesized callbacks", async () => {
    expect(
      await warnings(
        "return rows.map((row=>other.filter((item=>item.key===row.key))));",
      ),
    ).toHaveLength(1);
  });
  it("leaves callback-local derived child lists unreported", async () => {
    expect(
      await warnings(
        "return rows.map(row=>{const children=computed(()=>row.children);return children.map(child=>child);});",
      ),
    ).toHaveLength(0);
  });
  it("leaves an indexed lookup's returned members unreported", async () => {
    const result = await validateSource(
      `
      import {pattern,GroupIndex} from "commonfabric";
      export default pattern<{rows:{key:string}[];index:GroupIndex<string,{title:string}>}>(({rows,index})=>({
        values:rows.map(row=>index.lookup(row.key).map(item=>item.title)),
      }));
    `,
      { types: COMMONFABRIC_TYPES, typeCheck: true },
    );
    expect(result.diagnostics).toEqual([]);
  });
  it("leaves a captured collection selected by element access unreported", async () => {
    expect(
      await warnings(
        "return rows.map(row=>collections[0].map(child=>child));",
      ),
    ).toHaveLength(0);
  });
  it("warns for nested captured scans within a computed body", async () => {
    expect(
      await warnings(
        "return computed(()=>rows.map(row=>other.filter(item=>item.key===row.key)));",
      ),
    ).toHaveLength(1);
  });
});
