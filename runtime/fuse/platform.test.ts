import { assertEquals } from "@std/assert";
import { COMMON_SYMBOLS } from "./platform.ts";

Deno.test("reverse-invalidation symbols are nonblocking", () => {
  // The FUSE daemon runs fuse_session_loop on an FFI thread and answers every
  // request on the isolate thread. A reverse invalidation (notify_inval_entry /
  // notify_inval_inode) enters the Linux kernel and takes the parent
  // directory's inode lock for write; a concurrent lookup under that directory
  // holds the same lock for read until the daemon answers it. If a notify ran
  // synchronously on the isolate thread it would block there, inside the
  // kernel, behind a lookup only that thread can answer — a deadlock that
  // wedges the mount before it serves anything. The notify symbols must
  // therefore be nonblocking so they run off the isolate thread and leave the
  // request path free.
  assertEquals(
    COMMON_SYMBOLS.fuse_lowlevel_notify_inval_entry.nonblocking,
    true,
    "fuse_lowlevel_notify_inval_entry must run off the isolate thread",
  );
  assertEquals(
    COMMON_SYMBOLS.fuse_lowlevel_notify_inval_inode.nonblocking,
    true,
    "fuse_lowlevel_notify_inval_inode must run off the isolate thread",
  );
});

Deno.test("session loop is nonblocking", () => {
  // The session loop owns one FFI thread for the mount's lifetime.
  assertEquals(COMMON_SYMBOLS.fuse_session_loop.nonblocking, true);
});

Deno.test("reply functions stay synchronous", () => {
  // Reply functions are called synchronously from inside the op callbacks,
  // which run on the isolate thread. They hand an answer back to an outstanding
  // request rather than waiting on a lock, so they stay blocking; making them
  // nonblocking would return an unawaited promise and break the reply-once
  // contract.
  const replySymbols = [
    "fuse_reply_err",
    "fuse_reply_entry",
    "fuse_reply_attr",
    "fuse_reply_buf",
    "fuse_reply_open",
    "fuse_reply_readlink",
    "fuse_reply_write",
    "fuse_reply_create",
    "fuse_reply_xattr",
    "fuse_reply_none",
  ] as const;
  for (const name of replySymbols) {
    const sym = COMMON_SYMBOLS[name] as { nonblocking?: boolean };
    assertEquals(
      sym.nonblocking ?? false,
      false,
      `${name} must stay synchronous (called from within op callbacks)`,
    );
  }
});
