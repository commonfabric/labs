import { assertEquals } from "@std/assert";
import {
  DIR_MODE,
  DIR_MODE_RW,
  FILE_MODE_RWX,
  msToTimespec,
} from "./platform.ts";
import { buildNodeStat, getMountOwnership, nodeMode } from "./stat.ts";
import type { FsNode } from "./types.ts";

Deno.test("msToTimespec splits milliseconds into seconds and nanoseconds", () => {
  assertEquals(msToTimespec(1_700_000_000_500), {
    sec: 1_700_000_000n,
    nsec: 500_000_000n,
  });
  assertEquals(msToTimespec(0), { sec: 0n, nsec: 0n });
  assertEquals(msToTimespec(undefined), { sec: 0n, nsec: 0n });
});

Deno.test("getMountOwnership uses the current process ids when available", () => {
  assertEquals(
    getMountOwnership({
      uid: () => 501,
      gid: () => 20,
    }),
    { uid: 501, gid: 20 },
  );
});

Deno.test("getMountOwnership falls back to root ids when unavailable", () => {
  assertEquals(getMountOwnership({}), { uid: 0, gid: 0 });
});

Deno.test("getMountOwnership falls back when uid/gid probes throw", () => {
  assertEquals(
    getMountOwnership({
      uid: () => {
        throw new Error("uid unavailable");
      },
      gid: () => {
        throw new Error("gid unavailable");
      },
    }),
    { uid: 0, gid: 0 },
  );
});

Deno.test("buildNodeStat assigns mounted handler files to the current user", () => {
  const script = new TextEncoder().encode("#!/bin/sh\n");
  const node: FsNode = {
    kind: "callable",
    callableKind: "handler",
    cellKey: "addItem",
    cellProp: "result",
    script,
    mtime: 1_700_000_000_000,
  };

  assertEquals(
    buildNodeStat(node, 7n, {
      ownership: { uid: 501, gid: 20 },
    }),
    {
      ino: 7n,
      mode: FILE_MODE_RWX,
      nlink: 1,
      size: script.length,
      uid: 501,
      gid: 20,
      mtime: 1_700_000_000_000,
    },
  );
});

Deno.test("nodeMode exposes directories as read-only", () => {
  const node: FsNode = {
    kind: "dir",
    children: new Map(),
    mtime: 0,
  };

  assertEquals(nodeMode(node), DIR_MODE);
});

Deno.test("nodeMode exposes writable directories with write bits", () => {
  const node: FsNode = {
    kind: "dir",
    children: new Map(),
    mtime: 0,
  };

  assertEquals(nodeMode(node, true), DIR_MODE_RW);
});

Deno.test("nodeMode gives writable nodes user-independent write bits", () => {
  const file: FsNode = {
    kind: "file",
    content: new Uint8Array(),
    jsonType: "string",
    mtime: 0,
  };
  const dir: FsNode = {
    kind: "dir",
    children: new Map(),
    mtime: 0,
  };
  const handler: FsNode = {
    kind: "callable",
    callableKind: "handler",
    cellKey: "addItem",
    cellProp: "result",
    script: new Uint8Array(),
    mtime: 0,
  };

  assertEquals(nodeMode(file, true) & 0o777, 0o666);
  assertEquals(nodeMode(dir, true) & 0o777, 0o777);
  assertEquals(nodeMode(handler) & 0o777, 0o777);
});
