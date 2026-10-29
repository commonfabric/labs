import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  announceSupervisorState,
  appendDecodedJsonPath,
  bufferForNoHandleTruncate,
  cfcWritebackXattrResultErrno,
  createSupervisorStatusWriter,
  decodeFuseNamespaceName,
  decodeSourceWriteText,
  DEFAULT_CFC_XATTR_NAMESPACE,
  defaultCfcWritebackStatePath,
  disconnectedWriteErrno,
  isConnectionWriteFailure,
  parseCfcXattrNamespace,
  rootSpaceLookupNames,
  sourceRelPathToTreeSegments,
  writeUnavailableErrno,
} from "./mod.ts";
import { finalizeCommittedSourceWrite } from "./source-write-finalize.ts";
import { HandleMap } from "./handles.ts";
import {
  closeKernelFileHandle,
  createFuseOperationState,
} from "./operation-wiring.ts";
import {
  ATTRCACHE_TIMEOUT_MAX_SECONDS,
  buildMountFuseArgs,
  DEFAULT_FUSE_T_ATTRCACHE_TIMEOUT_SECONDS,
  parseAttrcacheTimeoutSeconds,
  resolveMountCacheOptions,
} from "./mount-options.ts";
import darwinPlatform, { libfusePaths } from "./platform-darwin.ts";
import linuxPlatform from "./platform-linux.ts";
import { EACCES, EINVAL, EROFS, FILE_MODE_RW } from "./platform.ts";
import { FsTree } from "./tree.ts";

function env(values: Record<string, string | undefined>) {
  return {
    get(name: string): string | undefined {
      return values[name];
    },
  };
}

function assertAppearsBefore(
  source: string,
  earlier: string,
  later: string,
  label = "source order",
): void {
  const earlierIndex = source.indexOf(earlier);
  const laterIndex = source.indexOf(later);
  assert(earlierIndex >= 0, `${label}: missing source fragment: ${earlier}`);
  assert(laterIndex >= 0, `${label}: missing source fragment: ${later}`);
  assert(
    earlierIndex < laterIndex,
    `expected ${earlier} to appear before ${later}`,
  );
}

function assertAppearsBeforeAfter(
  source: string,
  after: string,
  earlier: string,
  later: string,
  label: string,
): void {
  const start = source.indexOf(after);
  assert(start >= 0, `${label}: missing section marker: ${after}`);
  assertAppearsBefore(source.slice(start), earlier, later, label);
}

Deno.test("CFC xattr namespace defaults to both and rejects unknown values", () => {
  assertEquals(DEFAULT_CFC_XATTR_NAMESPACE, "both");
  assertEquals(parseCfcXattrNamespace("trusted"), "trusted");
  assertEquals(parseCfcXattrNamespace("compat"), "compat");
  assertEquals(parseCfcXattrNamespace("both"), "both");
  assertEquals(parseCfcXattrNamespace("bogus"), undefined);
});

Deno.test("default CFC writeback state path avoids /tmp fallback", () => {
  assertEquals(
    defaultCfcWritebackStatePath(
      "/mnt/cf mount",
      env({
        CF_CFC_WRITEBACK_STATE_DIR: "/explicit/state",
        XDG_STATE_HOME: "/xdg/state",
        HOME: "/home/alice",
        TMPDIR: "/tmp/ignored",
      }),
    ),
    "/explicit/state/cfc-writeback-_2Fmnt_2Fcf_20mount.json",
  );

  assertEquals(
    defaultCfcWritebackStatePath(
      "/mnt/cf",
      env({
        XDG_STATE_HOME: "/xdg/state",
        HOME: "/home/alice",
        TMPDIR: "/tmp/ignored",
      }),
    ),
    "/xdg/state/commonfabric-fuse/cfc-writeback-_2Fmnt_2Fcf.json",
  );

  assertEquals(
    defaultCfcWritebackStatePath(
      "/mnt/cf",
      env({
        HOME: "/home/alice",
        TMPDIR: "/tmp/ignored",
      }),
    ),
    "/home/alice/.cache/commonfabric-fuse/cfc-writeback-_2Fmnt_2Fcf.json",
  );
});

Deno.test("FUSE namespace writeback decodes path component names", () => {
  assertEquals(decodeFuseNamespaceName("of%3Aentity"), "of:entity");
  assertEquals(
    appendDecodedJsonPath(["items"], "of%3Aentity"),
    ["items", "of:entity"],
  );
});

Deno.test("FUSE operation wiring marks writable entries and closes projection handles", () => {
  const tree = new FsTree();
  const directory = tree.addDir(tree.rootIno, "directory");
  const file = tree.addFile(directory, "value", "text", "string");
  const writePathRequests: bigint[] = [];
  const released: bigint[] = [];
  const bridge = {
    resolveWritePath: (ino: bigint) => {
      writePathRequests.push(ino);
      return ino === file ? {} : null;
    },
    resolveSourceWritePath: () => null,
    releaseEntityProjectionOpen: (ino: bigint) => released.push(ino),
  };
  const operations = createFuseOperationState(tree, bridge as never);
  const directoryHandle = operations.openDirectory(directory)!;

  const entries = operations.directorySnapshot(directoryHandle, directory);
  assertEquals(
    entries.find((entry) => entry.name === "value")?.mode,
    FILE_MODE_RW,
  );
  assertEquals(writePathRequests, [file]);

  const handles = new HandleMap();
  const fileHandle = handles.open(file, 0);
  closeKernelFileHandle(handles, bridge, fileHandle);
  closeKernelFileHandle(handles, bridge, fileHandle);
  assertEquals(handles.get(fileHandle), undefined);
  assertEquals(released, [file]);
});

Deno.test("source writeback re-encodes decoded source relpaths for tree lookup", () => {
  assertEquals(
    sourceRelPathToTreeSegments("src/has:colon.tsx"),
    ["src", "has%3Acolon.tsx"],
  );
});

Deno.test("source writeback retains attached test roots", async () => {
  const source = await Deno.readTextFile(new URL("./mod.ts", import.meta.url));
  const sourceWriteback = source.slice(
    source.indexOf('if (writeTarget?.kind === "source")'),
  );

  assert(
    sourceWriteback.includes("sourceRoots: program.sourceRoots"),
    "source writeback must pass the recovered source roots to setPattern",
  );
});

Deno.test("source writeback retains attached data files", async () => {
  const source = await Deno.readTextFile(new URL("./mod.ts", import.meta.url));
  const sourceWriteback = source.slice(
    source.indexOf('if (writeTarget?.kind === "source")'),
  );

  assert(
    sourceWriteback.includes("dataFiles: program.dataFiles"),
    "source writeback must pass the recovered data files to setPattern",
  );
});

Deno.test("source writeback finalizes its receipt and persists every warning", async () => {
  // Finalizing rebuilds `.src` and mints a fresh empty `error.log`, so the
  // receipt goes into the operation performing that rebuild. The outer flush
  // then persists the finalizer's complete diagnostic, which retains both
  // failures when the running-piece refresh and the projection fail. Read from
  // the source because driving the flush needs a mounted filesystem, in the
  // same way as the two cases above.
  const source = await Deno.readTextFile(new URL("./mod.ts", import.meta.url));
  const sourceWriteback = source.slice(
    source.indexOf('if (writeTarget?.kind === "source")'),
  );

  assert(
    sourceWriteback.includes(
      "bridge.finalizeSourceWritePath(writeTarget.target, receipt)",
    ),
    "source writeback must hand the update receipt to the finalize",
  );
  assert(
    sourceWriteback.includes(
      "finalized.logWarning",
    ),
    "source writeback must persist the complete post-commit diagnostic",
  );
});

Deno.test("source projection failures after commit become warnings, not rejected writes", async () => {
  const receipt = {
    status: "committed" as const,
    ref: { identity: "A".repeat(43), symbol: "default" },
    revisionId: "revision-committed-before-finalize",
    detachedOrigin: null,
    space: "did:key:test" as const,
    seq: 12,
    refresh: { status: "completed" as const },
  };
  const failure = new Error("projection rebuild failed");

  const failed = await finalizeCommittedSourceWrite(receipt, () => {
    throw failure;
  });
  assertEquals(failed, {
    status: "failed",
    warning:
      `Source revision revision-committed-before-finalize committed as ` +
      `cf:module/${"A".repeat(43)}#default, but refreshing the FUSE ` +
      `projection failed: projection rebuild failed`,
    logWarning:
      `Source revision revision-committed-before-finalize committed as ` +
      `cf:module/${"A".repeat(43)}#default, but refreshing the FUSE ` +
      `projection failed: projection rebuild failed`,
    error: failure,
  });

  assertEquals(
    await finalizeCommittedSourceWrite(receipt, () => Promise.resolve()),
    { status: "completed" },
  );
});

Deno.test("source writes decode as strict UTF-8 text", () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  assertEquals(
    decodeSourceWriteText(encode("export default 1;")),
    "export default 1;",
  );
  assertEquals(decodeSourceWriteText(new Uint8Array(0)), "");
});

Deno.test("source writes keep a byte order mark", () => {
  // The mark is content: an attached data file is stored byte-for-byte.
  const withMark = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
  assertEquals(decodeSourceWriteText(withMark), "\uFEFF{}");
});

Deno.test("source writes that are not UTF-8 text decode to undefined", () => {
  // Storing replacement characters here would deploy something other than what
  // was written, so the write has to be refused instead.
  assertEquals(
    decodeSourceWriteText(new Uint8Array([0xff, 0xfe, 0x00])),
    undefined,
  );
  assertEquals(decodeSourceWriteText(new Uint8Array([0xc3, 0x28])), undefined);
});

Deno.test("no-handle truncate opens only the bounded target prefix", () => {
  const content = new Uint8Array([1, 2, 3, 4, 5]);
  assertEquals([...bufferForNoHandleTruncate(content, 2)], [1, 2]);
  assertEquals(bufferForNoHandleTruncate(content, 0).length, 0);
});

Deno.test("writeUnavailableErrno reports read-only filesystem while disconnected", () => {
  assertEquals(writeUnavailableErrno({ disconnected: true }), EROFS);
  assertEquals(writeUnavailableErrno({ disconnected: false }), EACCES);
  assertEquals(writeUnavailableErrno(null), EACCES);
});

Deno.test("disconnectedWriteErrno only rejects degraded writes", () => {
  assertEquals(disconnectedWriteErrno({ disconnected: true }), EROFS);
  assertEquals(disconnectedWriteErrno({ disconnected: false }), null);
  assertEquals(disconnectedWriteErrno(undefined), null);
});

Deno.test("mutating callbacks reject disconnected writes before optimistic mutation", async () => {
  const source = await Deno.readTextFile(new URL("./mod.ts", import.meta.url));
  const mutationGuards = [
    [
      "open callback",
      'logOp("open"',
      "if (failIfDisconnectedWrite(req)) return;",
      "const fh = handles.open(",
    ],
    [
      "write callback",
      'logOp("write"',
      "const errno = disconnectedWriteErrno(bridge);",
      "!handles.write(fh, data, off)",
    ],
    [
      "flushHandle",
      "async function flushHandle",
      "const disconnectedErrno = disconnectedWriteErrno(bridge);",
      'if (writeTarget?.kind === "handler")',
    ],
    [
      "flush callback",
      'logOp("flush"',
      "const errno = disconnectedWriteErrno(bridge);",
      "fuse.symbols.fuse_reply_err(req, 0);\n      console.log(`[write-trace] flush-fire fh=${fh}`);",
    ],
    [
      "release callback",
      'logOp("release"',
      "const errno = disconnectedWriteErrno(bridge);",
      "fuse.symbols.fuse_reply_err(req, 0);\n        let flushPromise",
    ],
    [
      "setattr",
      'logOp("setattr"',
      "if ((sizeChange || metadataChange) && failIfDisconnectedWrite(req))",
      "applyPreparedExistingWrite",
    ],
    [
      "setxattr",
      'logOp("setxattr"',
      "if (failIfDisconnectedWrite(req)) return;\n      const name = readCString(namePtr);",
      "cfcWritebacks.setPreparedXattr",
    ],
    [
      "removexattr",
      'logOp("removexattr"',
      "if (failIfDisconnectedWrite(req)) return;\n      const name = readCString(namePtr);",
      "cfcWritebacks.deleteAllForIno",
    ],
    [
      "create",
      "const parentPath = bridge.resolveWritePath(parent);",
      'if (failIfDisconnectedWrite(req)) return;\n      if (!authorizeCreateCfcWrite(parent, "create", name))',
      "tree.addFile(parent, name",
    ],
    [
      "mkdir",
      'logOp("mkdir"',
      'if (failIfDisconnectedWrite(req)) return;\n      if (!authorizeCreateCfcWrite(parent, "mkdir", name))',
      "tree.addDir(parent, name",
    ],
    [
      "unlink",
      "parentPath ??= bridge.resolveWritePath(parent);",
      'if (failIfDisconnectedWrite(req)) return;\n      authorization ??= authorizeNamespaceCfcWrite(parent, "unlink", name);',
      "tree.removeChild(parent, name)",
    ],
    [
      "rmdir",
      'logOp("rmdir"',
      'if (failIfDisconnectedWrite(req)) return;\n      authorization ??= authorizeNamespaceCfcWrite(parent, "rmdir", name);',
      "tree.removeChild(parent, name)",
    ],
    [
      "rename",
      'logOp("rename"',
      "if (failIfDisconnectedWrite(req)) return;\n      renameAuthorization ??= authorizeRenameCfcWrite",
      "tree.rename(oldParent, oldName, newParent, newName)",
    ],
    [
      "symlink",
      "const symlinkCb",
      "if (failIfDisconnectedWrite(req)) return;\n\n      let authorization = undefined",
      "tree.addSymlink(parent, name, target)",
    ],
  ] as const;

  for (const [label, marker, guard, mutation] of mutationGuards) {
    assertAppearsBeforeAfter(source, marker, guard, mutation, label);
  }
});

Deno.test("mounted is announced only after the session loop and signal handlers", async () => {
  // The readiness handshake carries no timed confirmation because the `mounted`
  // announcement is honest: by the time a caller can read it, the session loop
  // is dispatched and the signal handlers are installed, so the mount serves
  // requests and unmounts cleanly on a signal. An announcement moved back ahead
  // of either would reintroduce the confirmation the caller no longer pays for.
  const source = await Deno.readTextFile(new URL("./mod.ts", import.meta.url));
  assertAppearsBefore(
    source,
    "const sessionLoop = fuse.symbols.fuse_session_loop(handle.session);",
    'reportSupervisorState("mounted")',
    "session loop dispatched before mounted is announced",
  );
  assertAppearsBefore(
    source,
    'Deno.addSignalListener("SIGTERM"',
    'reportSupervisorState("mounted")',
    "signal handlers installed before mounted is announced",
  );
  // The announcement must also come before the loop is awaited, or every
  // background mount would block on the loop before it could report `mounted`.
  assertAppearsBefore(
    source,
    'reportSupervisorState("mounted")',
    "const result = await sessionLoop;",
    "mounted is announced before the session loop is awaited",
  );
});

Deno.test("write-trace lines the FUSE integration suite reads keep their shape", async () => {
  const source = await Deno.readTextFile(new URL("./mod.ts", import.meta.url));

  // `runtime/cli/integration/fuse-exec.sh` asserts that truncating a path
  // disarms an already-open descriptor by reading these three lines out of the
  // daemon log. It resolves the handle from the `write` line, requires the
  // `release` line to report the handle disarmed, and requires no `flush-fire`
  // line for that handle. That last check is satisfied by a line being absent,
  // so rewording it turns the check into a no-op that still passes. Pin the
  // shapes here, where a reword fails and names what it broke.
  const tracedLines = [
    "console.log(`[write-trace] write fh=${fh} size=${sz} offset=${off}`);",
    "console.log(`[write-trace] flush-fire fh=${fh}`);",
    "[write-trace] release fh=${fh} dirty=${handle.dirty} flushing=${handle.flushing} pending=${",
  ];

  for (const line of tracedLines) {
    assert(
      source.includes(line),
      `mod.ts no longer emits the trace line fuse-exec.sh reads: ${line}`,
    );
  }

  // The release line is only a verdict because it reports the handle's state as
  // releaseCb found it. Tracing it after the flush decision would report state
  // that decision had already changed.
  assertAppearsBeforeAfter(
    source,
    'logOp("release"',
    "[write-trace] release fh=${fh} dirty=${handle.dirty}",
    "if (handle && handleHasPendingChanges(handle) && bridge) {",
    "release trace precedes the flush decision",
  );
});

Deno.test("namespace write failures use shared outage accounting", async () => {
  const source = await Deno.readTextFile(new URL("./mod.ts", import.meta.url));

  for (
    const operation of [
      "create",
      "mkdir",
      "unlink",
      "rmdir",
      "rename",
      "symlink",
    ]
  ) {
    assert(
      source.includes(
        `recordAsyncWriteFailure(\"${operation} write error\", e);`,
      ),
      `missing shared outage accounting for ${operation}`,
    );
  }
});

Deno.test("connection write failure classifier recognizes backend outages", () => {
  assertEquals(
    isConnectionWriteFailure(new Error("ConnectionError: transport closed")),
    true,
  );
  assertEquals(
    isConnectionWriteFailure(
      "failed to connect to WebSocket: tcp connect error",
    ),
    true,
  );
  assertEquals(isConnectionWriteFailure("connection refused"), true);
  assertEquals(
    isConnectionWriteFailure(new Error("schema validation failed")),
    false,
  );
});

Deno.test("CFC writeback xattr errno policy distinguishes unsupported and malformed payloads", () => {
  const enotsup = 95;

  assertEquals(cfcWritebackXattrResultErrno({ ok: true }, { enotsup }), 0);
  assertEquals(
    cfcWritebackXattrResultErrno(
      { ok: false, reason: "unsupported writeback xattr" },
      { enotsup },
    ),
    enotsup,
  );
  assertEquals(
    cfcWritebackXattrResultErrno(
      { ok: false, reason: "invalid prepare metadata" },
      { enotsup },
    ),
    EINVAL,
  );
  assertEquals(
    cfcWritebackXattrResultErrno(
      { ok: false, reason: "invalid finalize metadata" },
      { enotsup },
    ),
    EINVAL,
  );
});

Deno.test("platform ENOTSUP matches host errno values", () => {
  assertEquals(darwinPlatform.ENOTSUP, 45);
  assertEquals(linuxPlatform.ENOTSUP, 95);
});

Deno.test("root space lookup decodes request names and replies with canonical names", () => {
  assertEquals(rootSpaceLookupNames("did%3Akey%3AzSpace"), {
    spaceName: "did:key:zSpace",
    directoryName: "did%3Akey%3AzSpace",
  });
  assertEquals(rootSpaceLookupNames("home"), {
    spaceName: "home",
    directoryName: "home",
  });
});

Deno.test("mount fuse args apply allow_other on Linux only", () => {
  assertEquals(
    buildMountFuseArgs({
      os: "linux",
      provider: "linux-libfuse",
      allowOther: true,
      cfcWritebackXattrs: false,
      noattrcache: false,
    }),
    ["fuse_ct", "-o", "allow_other", "-o", "default_permissions"],
  );
  assertEquals(
    buildMountFuseArgs({
      os: "linux",
      provider: "linux-libfuse",
      allowOther: true,
      cfcWritebackXattrs: true,
      noattrcache: false,
    }),
    ["fuse_ct", "-o", "allow_other"],
  );
  assertEquals(
    buildMountFuseArgs({
      os: "darwin",
      provider: "fuse-t",
      allowOther: true,
      cfcWritebackXattrs: false,
      noattrcache: false,
      attrcacheTimeoutSeconds: 0,
    }),
    ["fuse_ct"],
  );
});

Deno.test("mount fuse args apply noattrcache to FUSE-T mounts only", () => {
  assertEquals(
    buildMountFuseArgs({
      os: "darwin",
      provider: "fuse-t",
      allowOther: false,
      cfcWritebackXattrs: false,
      noattrcache: true,
    }),
    ["fuse_ct", "-o", "noattrcache"],
  );
  for (
    const [os, provider] of [
      ["linux", "linux-libfuse"],
      ["darwin", "macfuse"],
      ["darwin", "unknown"],
    ] as const
  ) {
    assertEquals(
      buildMountFuseArgs({
        os,
        provider,
        allowOther: false,
        cfcWritebackXattrs: false,
        noattrcache: true,
      }),
      ["fuse_ct"],
    );
  }
});

Deno.test("FUSE-T mounts default to a one-second attrcache-timeout", () => {
  assertEquals(
    buildMountFuseArgs({
      os: "darwin",
      provider: "fuse-t",
      allowOther: false,
      cfcWritebackXattrs: false,
      noattrcache: false,
    }),
    ["fuse_ct", "-o", "attrcache-timeout=1"],
  );
  assertEquals(DEFAULT_FUSE_T_ATTRCACHE_TIMEOUT_SECONDS, 1);
  // Explicit zero restores the NFS client's default caching.
  assertEquals(
    buildMountFuseArgs({
      os: "darwin",
      provider: "fuse-t",
      allowOther: false,
      cfcWritebackXattrs: false,
      noattrcache: false,
      attrcacheTimeoutSeconds: 0,
    }),
    ["fuse_ct"],
  );
  // noattrcache suppresses the timeout default.
  assertEquals(
    buildMountFuseArgs({
      os: "darwin",
      provider: "fuse-t",
      allowOther: false,
      cfcWritebackXattrs: false,
      noattrcache: true,
      attrcacheTimeoutSeconds: 5,
    }),
    ["fuse_ct", "-o", "noattrcache"],
  );
  // macFUSE rejects the option, so no default is applied there, and an
  // unresolved provider gets no default either.
  for (const provider of ["macfuse", "unknown"] as const) {
    assertEquals(
      buildMountFuseArgs({
        os: "darwin",
        provider,
        allowOther: false,
        cfcWritebackXattrs: false,
        noattrcache: false,
      }),
      ["fuse_ct"],
    );
  }
});

Deno.test("mount fuse args apply attrcache-timeout to FUSE-T mounts only", () => {
  assertEquals(
    buildMountFuseArgs({
      os: "darwin",
      provider: "fuse-t",
      allowOther: false,
      cfcWritebackXattrs: false,
      noattrcache: false,
      attrcacheTimeoutSeconds: 30,
    }),
    ["fuse_ct", "-o", "attrcache-timeout=30"],
  );
  assertEquals(
    buildMountFuseArgs({
      os: "linux",
      provider: "linux-libfuse",
      allowOther: false,
      cfcWritebackXattrs: false,
      noattrcache: false,
      attrcacheTimeoutSeconds: 30,
    }),
    ["fuse_ct"],
  );
});

Deno.test("attrcache-timeout parses whole seconds within bounds", () => {
  assertEquals(parseAttrcacheTimeoutSeconds(""), undefined);
  assertEquals(parseAttrcacheTimeoutSeconds("1"), 1);
  assertEquals(parseAttrcacheTimeoutSeconds("30"), 30);
  assertEquals(
    parseAttrcacheTimeoutSeconds(String(ATTRCACHE_TIMEOUT_MAX_SECONDS)),
    ATTRCACHE_TIMEOUT_MAX_SECONDS,
  );
  assertEquals(parseAttrcacheTimeoutSeconds("0"), 0);
  assertThrows(() => parseAttrcacheTimeoutSeconds("-1"));
  assertThrows(() => parseAttrcacheTimeoutSeconds("1.5"));
  assertThrows(() => parseAttrcacheTimeoutSeconds("abc"));
  assertThrows(() =>
    parseAttrcacheTimeoutSeconds(String(ATTRCACHE_TIMEOUT_MAX_SECONDS + 1))
  );
  assertThrows(() => parseAttrcacheTimeoutSeconds("1e21"));
});

Deno.test("libfuse search includes the FUSE-T per-user install location", () => {
  assertEquals(
    libfusePaths(env({ HOME: "/Users/alice" })),
    [
      "/usr/local/lib/libfuse-t.dylib",
      "/Users/alice/.fuse-t/usr/local/lib/libfuse-t.dylib",
      "/usr/local/lib/libfuse.2.dylib",
    ],
  );
  assertEquals(
    libfusePaths(env({})),
    [
      "/usr/local/lib/libfuse-t.dylib",
      "/usr/local/lib/libfuse.2.dylib",
    ],
  );
});

Deno.test("mount cache options resolve from their command-line spellings", () => {
  assertEquals(
    resolveMountCacheOptions({ noattrcache: false, attrcacheTimeout: "" }),
    { noattrcache: false, attrcacheTimeoutSeconds: undefined },
  );
  assertEquals(
    resolveMountCacheOptions({ noattrcache: false, attrcacheTimeout: "5" }),
    { noattrcache: false, attrcacheTimeoutSeconds: 5 },
  );
  assertEquals(
    resolveMountCacheOptions({ noattrcache: true, attrcacheTimeout: "" }),
    { noattrcache: true, attrcacheTimeoutSeconds: undefined },
  );
  // An explicit 0 selects untuned caching and is not a "no value" sentinel.
  assertEquals(
    resolveMountCacheOptions({ noattrcache: false, attrcacheTimeout: "0" }),
    { noattrcache: false, attrcacheTimeoutSeconds: 0 },
  );
});

Deno.test("mount cache options reject the mutually exclusive combination", () => {
  assertThrows(
    () =>
      resolveMountCacheOptions({ noattrcache: true, attrcacheTimeout: "1" }),
    Error,
    "mutually exclusive",
  );
  // Even the untuning 0 conflicts: it still asks for a cache regime.
  assertThrows(
    () =>
      resolveMountCacheOptions({ noattrcache: true, attrcacheTimeout: "0" }),
    Error,
    "mutually exclusive",
  );
});

Deno.test("mount cache options reject a flag whose value was dropped", () => {
  // The daemon's parser yields no value for `--attrcache-timeout -1`; that
  // must fail rather than resolve to the default cache regime.
  assertThrows(
    () =>
      resolveMountCacheOptions({
        noattrcache: false,
        attrcacheTimeout: "",
        attrcacheTimeoutGiven: true,
      }),
    Error,
    "Missing value for --attrcache-timeout",
  );
  // Without the flag, an empty value still means "no cache tuning requested".
  assertEquals(
    resolveMountCacheOptions({
      noattrcache: false,
      attrcacheTimeout: "",
      attrcacheTimeoutGiven: false,
    }),
    { noattrcache: false, attrcacheTimeoutSeconds: undefined },
  );
});

Deno.test("mount cache options surface an out-of-range timeout", () => {
  assertThrows(
    () =>
      resolveMountCacheOptions({ noattrcache: false, attrcacheTimeout: "-1" }),
    Error,
    "Invalid --attrcache-timeout value",
  );
});

Deno.test("platform provider reports the implementation openFuse loaded", () => {
  // Neither platform's library is opened by unit tests, so both report the
  // pre-openFuse state. buildMountFuseArgs treats that as "not FUSE-T".
  assertEquals(darwinPlatform.provider(), "unknown");
  assertEquals(linuxPlatform.provider(), "unknown");
  assertEquals(
    buildMountFuseArgs({
      os: "darwin",
      provider: darwinPlatform.provider(),
      allowOther: false,
      cfcWritebackXattrs: false,
      noattrcache: false,
    }),
    ["fuse_ct"],
  );
});

// A fake filesystem for the supervisor status writer, whose write latency the
// test decides so two writes' ordering is chosen rather than raced.
//
// Held writes complete newest first, and a held write applies its content only
// when released. That is an ordering the real filesystem is free to choose, and
// it is the one that breaks an unserialized writer: the write issued first is
// the one that lands last, so it is the one that wins the file. A writer that
// lets only one write be in flight never has a second held write to reorder
// against.
function fakeStatusFilesystem() {
  const files = new Map<string, string>();
  const pending: Array<() => void> = [];
  let holdWrites = false;

  return {
    holdNextWrites() {
      holdWrites = true;
    },
    releaseHeldWrites() {
      holdWrites = false;
      while (pending.length > 0) pending.pop()!();
    },
    writeTextFile(path: string, data: string): Promise<void> {
      if (!holdWrites) {
        files.set(path, data);
        return Promise.resolve();
      }
      return new Promise<void>((resolve) =>
        pending.push(() => {
          files.set(path, data);
          resolve();
        })
      );
    },
    rename(from: string, to: string): Promise<void> {
      files.set(to, files.get(from)!);
      files.delete(from);
      return Promise.resolve();
    },
    remove(path: string): Promise<void> {
      files.delete(path);
      return Promise.resolve();
    },
    published(): string | undefined {
      return files.get("/state/status");
    },
    scratchFilesLeft(): string[] {
      return [...files.keys()].filter((path) => path.endsWith(".tmp"));
    },
  };
}

function statusWriterOver(fs: ReturnType<typeof fakeStatusFilesystem>) {
  return createSupervisorStatusWriter({
    statusPath: "/state/status",
    pid: 321,
    mountpoint: "/tmp/m",
    startedAt: "2026-03-17T00:00:00.000Z",
    now: () => "2026-03-17T00:00:01.000Z",
    writeTextFile: fs.writeTextFile,
    rename: fs.rename,
    remove: fs.remove,
  });
}

Deno.test("supervisor status publishes each state through a rename", () => {
  // The reader must never see a half-written file, so the document lands under a
  // scratch name and is renamed into place rather than written in place.
  const renames: Array<[string, string]> = [];
  const write = createSupervisorStatusWriter({
    statusPath: "/state/status",
    pid: 321,
    mountpoint: "/tmp/m",
    startedAt: "2026-03-17T00:00:00.000Z",
    writeTextFile: () => Promise.resolve(),
    rename: (from, to) => {
      renames.push([from, to]);
      return Promise.resolve();
    },
    remove: () => Promise.resolve(),
  });

  return write("mounted").then(() => {
    assertEquals(renames.length, 1);
    assertEquals(renames[0][1], "/state/status");
    assert(renames[0][0].startsWith("/state/status."));
    assert(renames[0][0].endsWith(".tmp"));
  });
});

Deno.test("supervisor status does not regress when a slow write is still in flight", async () => {
  const fs = fakeStatusFilesystem();
  const write = statusWriterOver(fs);

  // The heartbeat announces `mounted` and its write stalls. The session loop
  // then ends and announces `exited`. The file must settle on the later call,
  // not on whichever write the filesystem happens to finish last.
  fs.holdNextWrites();
  const heartbeat = write("mounted");
  const exited = write("exited", { exitCode: 0 });
  fs.releaseHeldWrites();
  await Promise.all([heartbeat, exited]);

  assertEquals(JSON.parse(fs.published()!).state, "exited");
});

Deno.test("supervisor status settles on exiting when it follows a stalled mounted", async () => {
  const fs = fakeStatusFilesystem();
  const write = statusWriterOver(fs);

  // The readiness report stalls and a signal arrives while it is in flight.
  fs.holdNextWrites();
  const mounted = write("mounted");
  const exiting = write("exiting");
  fs.releaseHeldWrites();
  await Promise.all([mounted, exiting]);

  assertEquals(JSON.parse(fs.published()!).state, "exiting");
});

Deno.test("supervisor status keeps publishing after a write fails", async () => {
  const fs = fakeStatusFilesystem();
  let failNext = true;
  const write = createSupervisorStatusWriter({
    statusPath: "/state/status",
    pid: 321,
    mountpoint: "/tmp/m",
    startedAt: "2026-03-17T00:00:00.000Z",
    writeTextFile: (path, data) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("disk full"));
      }
      return fs.writeTextFile(path, data);
    },
    rename: fs.rename,
    remove: fs.remove,
  });

  // A failed write is reported to its caller and leaves no scratch file, and the
  // states after it still reach the file.
  await assertRejects(() => write("mounted"), Error, "disk full");
  await write("exited", { exitCode: 0 });

  assertEquals(JSON.parse(fs.published()!).state, "exited");
  assertEquals(fs.scratchFilesLeft(), []);
});

Deno.test("supervisor status records when a state was reached, not when it drained", async () => {
  const fs = fakeStatusFilesystem();
  let clock = "2026-03-17T00:00:01.000Z";
  const write = createSupervisorStatusWriter({
    statusPath: "/state/status",
    pid: 321,
    mountpoint: "/tmp/m",
    startedAt: "2026-03-17T00:00:00.000Z",
    now: () => clock,
    writeTextFile: fs.writeTextFile,
    rename: fs.rename,
    remove: fs.remove,
  });

  // Serializing writes means a state can reach the file well after it was
  // reached. The stamp has to come from the call, so time moves on while the
  // write is stalled.
  fs.holdNextWrites();
  const mounted = write("mounted");
  clock = "2026-03-17T00:00:09.000Z";
  fs.releaseHeldWrites();
  await mounted;

  assertEquals(
    JSON.parse(fs.published()!).updatedAt,
    "2026-03-17T00:00:01.000Z",
  );
});

Deno.test("supervisor state is announced on the pipe even when the file write fails", async () => {
  // The pipe announcement is the handshake's channel; a failed status-file write
  // must not stop it, or a parent blocked on the pipe would never wake. The write
  // error still has to reach the caller.
  const published: Array<[string, Record<string, unknown>]> = [];
  const publish = (state: string, extra: Record<string, unknown> = {}) => {
    published.push([state, extra]);
    return Promise.resolve();
  };
  const write = () => Promise.reject(new Error("disk full"));

  await assertRejects(
    () => announceSupervisorState(write, publish, "mounted"),
    Error,
    "disk full",
  );
  assertEquals(published, [["mounted", {}]]);
});

Deno.test("supervisor state records before it announces on the success path", async () => {
  const order: string[] = [];
  const write = (state: string) => {
    order.push(`write:${state}`);
    return Promise.resolve();
  };
  const publish = (state: string) => {
    order.push(`publish:${state}`);
    return Promise.resolve();
  };

  await announceSupervisorState(write, publish, "failed", { error: "x" });
  assertEquals(order, ["write:failed", "publish:failed"]);
});
