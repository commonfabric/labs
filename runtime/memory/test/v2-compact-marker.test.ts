import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { hollowedMarkerPrefixOf } from "../v2/compact.ts";

describe("hollowedMarkerPrefixOf()", () => {
  it("returns the text up to and including the name of the `bytes` member", () => {
    expect(hollowedMarkerPrefixOf('x:{"hollowed":{"bytes":7,"hash":"h"}}'))
      .toBe('x:{"hollowed":{"bytes":');
  });

  it("throws for a marker that holds no `bytes` member", () => {
    expect(() => hollowedMarkerPrefixOf('x:{"hollowed":{"hash":"h"}}'))
      .toThrow("the hollowed-payload marker did not encode");
  });
});
