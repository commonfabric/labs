import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { NAME } from "@commonfabric/runner/shared";
import { MentionableSchema } from "./mentionable.ts";

describe("mentionable", () => {
  describe("MentionableSchema", () => {
    it("requires only the display name", () => {
      // The pattern side relies on the asymmetry: a producer that lists
      // pieces directly satisfies the schema without `piece`, while an
      // index row carries one. Requiring `piece` would silently drop every
      // direct-list producer's completions.
      expect(MentionableSchema.required).toEqual([NAME]);
    });

    it("reads piece as a cell rather than a value", () => {
      // The MentionRef.destination shape: an opaque boundary the client
      // reaches by address rather than through its value. Reading THROUGH it
      // here would put every listed piece back into the editor's own demand —
      // the cost the index exists to remove.
      expect(MentionableSchema.properties.piece.asCell).toEqual(["cell"]);
      expect(MentionableSchema.properties.piece.properties).toEqual({});
    });

    it("reads the member name as a plain string", () => {
      // What a `#42` query and a pill's number both read: a universe row's
      // copy of what its collection calls the member. The read goes no
      // further than the string, so neither costs a read of a piece.
      expect(MentionableSchema.properties.shortName).toEqual({
        type: "string",
      });
    });
  });
});
