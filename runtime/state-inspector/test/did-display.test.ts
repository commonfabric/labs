import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { didTail, shortDid } from "../did-display.ts";

const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

describe("did-display", () => {
  describe("didTail()", () => {
    it("returns the method-specific identifier of a DID", () => {
      expect(didTail(DID)).toBe(
        "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
      );
      expect(didTail("did:web:example.com:8080")).toBe("example.com:8080");
    });

    it("returns the whole string for a value that is not a DID", () => {
      expect(didTail("of:fid1:abc")).toBe("of:fid1:abc");
      expect(didTail("DID:key:z6Mk")).toBe("DID:key:z6Mk");
      expect(didTail("")).toBe("");
    });

    it("returns the whole DID for one that names no identifier", () => {
      // Both are DIDs under the repository's rule, and an empty label would
      // say less about which principal it stands for than the DID does.
      expect(didTail("did:key")).toBe("did:key");
      expect(didTail("did:key:")).toBe("did:key:");
      expect(didTail("did:")).toBe("did:");
    });
  });

  describe("shortDid()", () => {
    it("elides the middle of a long identifier", () => {
      expect(shortDid(DID)).toBe("z6Mkha…2doK");
    });

    it("returns a short identifier whole", () => {
      expect(shortDid("did:key:z6Mkhaxg")).toBe("z6Mkhaxg");
    });

    it("keeps an identifier at the eliding threshold whole", () => {
      // Twelve characters, which is `head + tail + 2` for the defaults.
      expect(shortDid("did:key:abcdefghijkl")).toBe("abcdefghijkl");
      expect(shortDid("did:key:abcdefghijklm")).toBe("abcdef…jklm");
    });

    it("honors the head and tail it is given", () => {
      expect(shortDid(DID, 8, 4)).toBe("z6MkhaXg…2doK");
    });

    it("labels a DID naming no identifier with the DID", () => {
      expect(shortDid("did:key")).toBe("did:key");
    });
  });
});
