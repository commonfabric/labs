/** Unit coverage for the snapshot-reading half of the Topics export/restore
 * vocabulary. It sits apart from `topics-rehearsal-lib.test.ts` for the same
 * reason its subject does: importing it costs `--allow-ffi`, and keeping that
 * out of the shared lib's test file makes the boundary visible where someone
 * would otherwise reintroduce it. */

import { expect } from "@std/expect";
import { FabricLink } from "@commonfabric/data-model/fabric-instances";
import { describe, it } from "@commonfabric/test-support/test";
import { argumentIdOf } from "./topics-snapshot-lib.ts";

describe("topics-snapshot-lib", () => {
  describe("argumentIdOf", () => {
    //
    // Both encodings
    //
    // Both encodings reach a reader of a real snapshot, and a reader that knows
    // only one of them reports the other as "no argument entity" — for the
    // export, that aborts the run rather than skipping a field.
    //

    it("reads the id out of a sigil-encoded link", () => {
      const document = {
        argument: { "/": { "link@1": { id: "of:fid1:arg" } } },
      };
      expect(argumentIdOf(document)).toBe("of:fid1:arg");
    });

    it("reads the id out of a FabricLink the codec restored", () => {
      const document = { argument: new FabricLink({ id: "of:fid1:arg" }) };
      expect(argumentIdOf(document)).toBe("of:fid1:arg");
    });

    //
    // Neither encoding
    //
    // A document that links nothing, and one whose `argument` is not a link at
    // all, both read as no argument entity.
    //

    it("returns undefined when the document links nothing", () => {
      expect(argumentIdOf({})).toBeUndefined();
      expect(argumentIdOf({ argument: "not a link" })).toBeUndefined();
    });
  });
});
