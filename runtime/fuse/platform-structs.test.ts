// platform-structs.test.ts — Exercise the platform struct writers directly.
//
// These functions marshal `struct stat` / `fuse_entry_param` into raw byte
// buffers for the FFI layer. They are only run through libfuse during a real
// mount, so on the opposite platform (and in CI, which runs on Linux) the
// macOS writer never executes and the Linux writer is never called by a unit
// test. They are pure `DataView` writes with no FFI, so they can be exercised
// and asserted directly here, on either host, which also pins the byte layout
// of the timestamp fields.

import { assertEquals } from "@std/assert";
import darwinPlatform from "./platform-darwin.ts";
import linuxPlatform from "./platform-linux.ts";
import type { FusePlatform } from "./platform.ts";

function testPlatformStructs(name: string, p: FusePlatform): void {
  Deno.test(`${name} writeStat marshals ino, size, and the mtime/atime/ctime timespecs`, () => {
    const buf = new ArrayBuffer(p.STAT_SIZE);
    p.writeStat(buf, {
      ino: 7n,
      mode: 0o644,
      nlink: 1,
      size: 42,
      uid: 501,
      gid: 20,
      mtime: 1_700_000_000_500,
    });
    const view = new DataView(buf);

    // st_ino is at offset 8 on both platforms.
    assertEquals(view.getBigUint64(8, true), 7n);
    assertEquals(Number(view.getBigInt64(p.STAT_ST_SIZE_OFFSET, true)), 42);

    // mtime is split into seconds and nanoseconds, and ctime/atime are reported
    // equal to it. The three timespecs are 16 bytes apart around st_mtim.
    const mtim = p.STAT_ST_MTIM_OFFSET;
    for (const offset of [mtim - 16, mtim, mtim + 16]) {
      assertEquals(view.getBigInt64(offset, true), 1_700_000_000n);
      assertEquals(view.getBigInt64(offset + 8, true), 500_000_000n);
    }
  });

  Deno.test(`${name} writeStat leaves the timestamps at the epoch when mtime is omitted`, () => {
    const buf = new ArrayBuffer(p.STAT_SIZE);
    p.writeStat(buf, { ino: 1n, mode: 0o755, nlink: 2, size: 0 });
    const view = new DataView(buf);
    assertEquals(view.getBigInt64(p.STAT_ST_MTIM_OFFSET, true), 0n);
    assertEquals(view.getBigInt64(p.STAT_ST_MTIM_OFFSET + 8, true), 0n);
    // A missing uid/gid marshals as 0.
    assertEquals(view.getBigUint64(8, true), 1n);
  });

  Deno.test(`${name} writeEntryParam embeds the attr stat with its mtime`, () => {
    const buf = new ArrayBuffer(p.ENTRY_PARAM_SIZE);
    p.writeEntryParam(buf, {
      ino: 9n,
      generation: 3n,
      attr: { ino: 9n, mode: 0o644, nlink: 1, size: 5, mtime: 2_000 },
      attrTimeout: 1,
      entryTimeout: 1,
    });
    const view = new DataView(buf);

    // Layout: ino @ 0, generation @ 8, embedded struct stat @ 16.
    assertEquals(view.getBigUint64(0, true), 9n);
    assertEquals(view.getBigUint64(8, true), 3n);
    // The embedded stat's own ino sits at 16 + 8.
    assertEquals(view.getBigUint64(16 + 8, true), 9n);
    // The embedded stat's mtime (2000 ms -> 2s) sits at 16 + st_mtim offset.
    assertEquals(view.getBigInt64(16 + p.STAT_ST_MTIM_OFFSET, true), 2n);
  });
}

testPlatformStructs("darwin", darwinPlatform);
testPlatformStructs("linux", linuxPlatform);
