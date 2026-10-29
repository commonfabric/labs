import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { STAT_BY_ARCH, STAT_LAYOUT, writeStatWith } from "./platform-linux.ts";

/** Read a member back at the width its architecture gives it. */
function nlinkAt(view: DataView, stat: typeof STAT_LAYOUT): number {
  return stat.nlinkBytes === 8
    ? Number(view.getBigUint64(stat.nlink, true))
    : view.getUint32(stat.nlink, true);
}

describe("platform-linux stat marshalling", () => {
  // verify-structs.c confirms these offsets against the headers of whichever
  // architecture it is compiled on. What it cannot say is whether writeStat
  // puts each member where the table places it, and it can only speak for one
  // architecture at a time. These run over both tables on any host.

  for (const [arch, stat] of Object.entries(STAT_BY_ARCH)) {
    describe(arch, () => {
      it("writes each member at the offset the architecture gives it", () => {
        const buf = new ArrayBuffer(stat.size);
        writeStatWith(stat, buf, {
          ino: 7n,
          mode: 0o100644,
          nlink: 3,
          size: 42,
          uid: 501,
          gid: 20,
        });
        const view = new DataView(buf);
        expect(view.getBigUint64(8, true)).toBe(7n);
        expect(view.getUint32(stat.mode, true)).toBe(0o100644);
        expect(nlinkAt(view, stat)).toBe(3);
        expect(view.getUint32(stat.uid, true)).toBe(501);
        expect(view.getUint32(stat.gid, true)).toBe(20);
        expect(Number(view.getBigInt64(48, true))).toBe(42);
      });

      it("leaves the bytes no member claims alone", () => {
        // The members that move are packed against each other, so a write
        // landing one field wide would show up in its neighbor rather than
        // here. `st_rdev` is the gap after them, and nothing writes it.
        const buf = new ArrayBuffer(stat.size);
        writeStatWith(stat, buf, {
          ino: 1n,
          mode: 0o40755,
          nlink: 2,
          size: 0,
          uid: 0xffff,
          gid: 0xffff,
        });
        const view = new DataView(buf);
        const afterTheBlock = stat.gid + 4;
        expect(view.getBigUint64(afterTheBlock, true)).toBe(0n);
      });

      it("writes a mode that does not reach into the member beside it", () => {
        // st_mode and its neighbor are adjacent four-byte members on both
        // architectures, so a mode written eight bytes wide would erase one.
        const buf = new ArrayBuffer(stat.size);
        writeStatWith(stat, buf, {
          ino: 1n,
          mode: 0o100777,
          nlink: 1,
          size: 0,
          uid: 1234,
          gid: 5678,
        });
        const view = new DataView(buf);
        expect(view.getUint32(stat.uid, true)).toBe(1234);
        expect(view.getUint32(stat.gid, true)).toBe(5678);
      });
    });
  }

  describe("the table for this host", () => {
    it("is the one the running architecture names", () => {
      expect(STAT_LAYOUT).toBe(STAT_BY_ARCH[Deno.build.arch]);
    });
  });
});
