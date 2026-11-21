import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { blobSuffix, storedBlobPath } from "../src/blob-record.ts";

describe("blob-record", () => {
  describe("blobSuffix()", () => {
    it("returns the name's last extension when it is one to eight letters or digits", () => {
      expect(blobSuffix("archive.tar.gz", "application/gzip")).toBe("gz");
    });

    it("returns the media type's usual extension for a name with no usable extension", () => {
      expect(blobSuffix("photo", "image/png")).toBe("png");
      expect(blobSuffix("photo.not-a-suffix", "image/jpeg")).toBe("jpg");
      expect(blobSuffix(undefined, "image/webp")).toBe("webp");
    });

    it("returns `bin` for a media type with no usual extension, an inherited key's name included", () => {
      expect(blobSuffix(undefined, "application/x-unknown")).toBe("bin");
      expect(blobSuffix(undefined, "constructor")).toBe("bin");
      expect(blobSuffix(undefined, "toString")).toBe("bin");
    });
  });

  describe("storedBlobPath()", () => {
    it("returns the blob's hash, without its `fid1:` tag, under `blobs/` with the suffix", () => {
      expect(storedBlobPath("fid1:abc_-123", "png")).toBe(
        "blobs/abc_-123.png",
      );
    });
  });
});
