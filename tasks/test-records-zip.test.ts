import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { readZip } from "./test-records-zip.ts";
import { buildZip } from "./zip-testing.ts";

describe("test-records-zip", () => {
  describe("readZip()", () => {
    it("returns a stored member byte for byte", async () => {
      const content = new TextEncoder().encode('{"v":1,"ct":"abc"}');
      const zip = await buildZip("delivery.sealed", content, 0);
      const members = await readZip(zip);
      expect(members.length).toBe(1);
      expect(members[0]!.name).toBe("delivery.sealed");
      expect(members[0]!.data).toEqual(content);
    });

    it("inflates a deflated member", async () => {
      const content = new TextEncoder().encode(
        "repeated repeated repeated repeated repeated content",
      );
      const zip = await buildZip("delivery.sealed", content, 8);
      const members = await readZip(zip);
      expect(members[0]!.data).toEqual(content);
    });

    it("throws for bytes with no central directory", async () => {
      await expect(readZip(new Uint8Array(100))).rejects.toThrow(
        "no central directory",
      );
    });

    it("throws when the central directory points at something else", async () => {
      const zip = await buildZip("delivery.sealed", new Uint8Array([1]), 0);
      // The directory offset sits four bytes before the archive's
      // trailing comment-length field; aim it at the local header.
      zip.fill(0, zip.length - 6, zip.length - 2);
      await expect(readZip(zip)).rejects.toThrow(
        "malformed zip: central directory entry expected",
      );
    });

    it("throws for a compression method other than stored or deflated", async () => {
      const zip = await buildZip("delivery.sealed", new Uint8Array([1]), 0);
      // The central directory entry starts 22 + 46 + the name's length
      // bytes from the end; its method field is 10 bytes into it.
      const entry = zip.length - 22 - 46 - "delivery.sealed".length;
      zip[entry + 10] = 12;
      await expect(readZip(zip)).rejects.toThrow(
        "unsupported zip compression method 12",
      );
    });

    it("reads past a comment containing the directory signature", async () => {
      const content = new TextEncoder().encode("commented");
      const zip = await buildZip("delivery.sealed", content, 0);
      // An archive comment whose first bytes mimic the record signature;
      // its fake comment-length field does not reach the end of the
      // archive, so the scan must continue to the real record.
      const comment = new Uint8Array(22).fill(0xaa);
      comment.set([0x50, 0x4b, 0x05, 0x06], 0);
      const commented = new Uint8Array(zip.length + comment.length);
      commented.set(zip, 0);
      commented.set(comment, zip.length);
      commented[zip.length - 2] = comment.length;
      commented[zip.length - 1] = 0;
      const members = await readZip(commented);
      expect(members.length).toBe(1);
      expect(members[0]!.data).toEqual(content);
    });
  });
});
