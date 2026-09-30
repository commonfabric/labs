import {
  assertEquals,
  assertExists,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { CFC_ENFORCEMENT_MODES } from "@commonfabric/runner/cfc";

import { FsTree } from "./tree.ts";
import {
  CfcProjectionAnnotator,
  type CfcProjectionRef,
} from "./annotations.ts";
import {
  applyPreparedCreate,
  applyPreparedExistingWrite,
  applyPreparedMetadataMutation,
  applyPreparedSymlink,
  authorizeCreateWriteback,
  authorizeExistingWriteback,
  authorizeMetadataWriteback,
  authorizeNamespaceMutationWriteback,
  authorizeSymlinkWriteback,
  CFC_COMPAT_WRITEBACK_FINALIZE_XATTR,
  CFC_COMPAT_WRITEBACK_PREPARE_XATTR,
  CFC_WRITEBACK_FINALIZE_XATTR,
  CFC_WRITEBACK_PREPARE_XATTR,
  CfcWritebackStore,
  metadataFieldsForSetattrFlags,
  normalizeCfcWritebackXattrName,
  resolveCfcMode,
  safeReconcileCfcWritebacks,
  shouldEnableCfcAnnotations,
} from "./cfc-writeback.ts";
import {
  FUSE_SET_ATTR_ATIME,
  FUSE_SET_ATTR_CTIME,
  FUSE_SET_ATTR_FILE,
  FUSE_SET_ATTR_GID,
  FUSE_SET_ATTR_MODE,
  FUSE_SET_ATTR_MTIME,
  FUSE_SET_ATTR_SIZE,
  FUSE_SET_ATTR_UID,
} from "./platform.ts";

const SECRET_LABEL = {
  confidentiality: [{ type: "test-label", value: "secret" }],
};

function makeAnnotatedTree(options: { inodeChurn?: boolean } = {}): {
  tree: FsTree;
  parentIno: bigint;
  fileIno: bigint;
  ref: CfcProjectionRef;
} {
  const tree = new FsTree();
  if (options.inodeChurn) {
    tree.addFile(tree.rootIno, "transient", "churn", "string");
  }
  const annotator = new CfcProjectionAnnotator(tree, {
    space: "did:key:zSpace",
    entity: "of:piece",
    rootKind: "pieces",
    cell: "result",
    generation: "generation-1",
    labelView: {
      version: 1,
      entries: [{ path: ["title"], label: SECRET_LABEL }],
    },
  });
  const parentIno = tree.addDir(tree.rootIno, "result", "object");
  annotator.annotateJsonDirectory(parentIno, [], { title: "old" });
  const fileIno = tree.addFile(parentIno, "title", "old", "string");
  annotator.annotateJsonScalar(fileIno, ["title"], "old");
  annotator.annotateEntry(parentIno, "title", fileIno, {
    labelPath: ["title"],
  });
  const ref = tree.getCfcAnnotation(fileIno)?.ref;
  assertExists(ref);
  return { tree, parentIno, fileIno, ref };
}

function prepareJson(
  operation:
    | "write"
    | "truncate"
    | "create"
    | "mkdir"
    | "unlink"
    | "rmdir"
    | "rename-source"
    | "rename-destination"
    | "symlink"
    | "setattr-metadata",
  ref: CfcProjectionRef,
  extraTarget: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    version: 1,
    operation,
    target: { ref, ...extraTarget },
    expectedGeneration: ref.generation,
    labels: {
      contentLabel: SECRET_LABEL,
      nameLabel: SECRET_LABEL,
      existenceLabel: SECRET_LABEL,
      namespaceLabel: SECRET_LABEL,
      metadataLabels: { type: SECRET_LABEL },
    },
  });
}

Deno.test("CFC mode resolution and annotation defaults match runner modes", () => {
  for (const mode of CFC_ENFORCEMENT_MODES) {
    assertEquals(resolveCfcMode({ cliMode: mode }), mode);
    assertEquals(resolveCfcMode({ envMode: mode }), mode);
  }

  assertEquals(
    resolveCfcMode({ cliMode: "observe", envMode: "enforce-strict" }),
    "observe",
  );
  assertEquals(
    resolveCfcMode({ cliMode: undefined, envMode: "enforce-explicit" }),
    "enforce-explicit",
  );
  assertEquals(resolveCfcMode({}), "enforce-strict");
  // An empty string is a source that stated nothing, not a name off the
  // ladder: the mount reads an absent flag as "" and so does an exported but
  // unset environment variable.
  assertEquals(
    resolveCfcMode({ cliMode: "", envMode: "" }),
    "enforce-strict",
  );

  assertEquals(
    shouldEnableCfcAnnotations({
      annotationsRequested: false,
      mode: "disabled",
    }),
    false,
  );
  assertEquals(
    shouldEnableCfcAnnotations({
      annotationsRequested: true,
      mode: "disabled",
    }),
    true,
  );
  assertEquals(
    shouldEnableCfcAnnotations({
      annotationsRequested: false,
      mode: "observe",
    }),
    true,
  );
});

Deno.test("an off-ladder CFC mode is reported rather than coerced", () => {
  // A misspelled enforcing mode is refused, not resolved onto the weakest
  // rung.
  for (
    const [options, source] of [
      [{ cliMode: "enforce-stricct" }, "--cfc-mode"],
      [{ envMode: "enforce-stricct" }, "CF_CFC_MODE"],
    ] as const
  ) {
    const error = assertThrows(
      () => resolveCfcMode(options),
      Error,
      `${source}=enforce-stricct is not a CFC enforcement mode`,
    );
    assertStringIncludes(error.message, CFC_ENFORCEMENT_MODES.join(", "));
  }

  // Only the source that decides is checked, so a flag naming a mode starts a
  // mount whose environment holds something else.
  assertEquals(
    resolveCfcMode({ cliMode: "enforce-strict", envMode: "enforce-stricct" }),
    "enforce-strict",
  );
});

Deno.test("safe writeback reconciliation records diagnostics without throwing", () => {
  const diagnostics: string[] = [];
  const ok = safeReconcileCfcWritebacks({
    context: "unit test",
    reconcile: () => {
      throw new Error("storage unavailable");
    },
    recordDiagnostics: (messages) => diagnostics.push(...messages),
  });

  assertEquals(ok, false);
  assertEquals(diagnostics, [
    "unit test reconciliation failed: storage unavailable",
  ]);
});

Deno.test("safe writeback reconciliation preserves normal diagnostics", () => {
  const diagnostics: string[] = [];
  const ok = safeReconcileCfcWritebacks({
    context: "unit test",
    reconcile: () => ({
      inspected: 1,
      rebound: 0,
      reapplied: 0,
      finalized: 0,
      stale: 0,
      diagnostics: ["existing diagnostic"],
    }),
    recordDiagnostics: (messages) => diagnostics.push(...messages),
  });

  assertEquals(ok, true);
  assertEquals(diagnostics, ["existing diagnostic"]);
});

Deno.test("FUSE setattr flag constants and metadata field mapping match low-level ABI", () => {
  assertEquals(FUSE_SET_ATTR_MODE, 1 << 0);
  assertEquals(FUSE_SET_ATTR_UID, 1 << 1);
  assertEquals(FUSE_SET_ATTR_GID, 1 << 2);
  assertEquals(FUSE_SET_ATTR_SIZE, 1 << 3);
  assertEquals(FUSE_SET_ATTR_ATIME, 1 << 4);
  assertEquals(FUSE_SET_ATTR_MTIME, 1 << 5);
  assertEquals(FUSE_SET_ATTR_CTIME, 1 << 10);
  assertEquals(FUSE_SET_ATTR_FILE, 1 << 13);
  assertEquals(
    metadataFieldsForSetattrFlags(
      FUSE_SET_ATTR_MODE |
        FUSE_SET_ATTR_UID |
        FUSE_SET_ATTR_GID |
        FUSE_SET_ATTR_MTIME |
        FUSE_SET_ATTR_FILE,
    ),
    ["generation", "gid", "mode", "mtime", "uid"],
  );
  assertEquals(
    metadataFieldsForSetattrFlags(1 << 24),
    [
      "ctime",
      "generation",
      "gid",
      "inode",
      "mode",
      "mtime",
      "nlink",
      "size",
      "type",
      "uid",
    ],
  );
});

Deno.test("writeback prepare parsing accepts namespace operations only by exact name", () => {
  const { parentIno, ref } = makeAnnotatedTree();
  const store = new CfcWritebackStore();

  for (
    const operation of [
      "unlink",
      "rmdir",
      "rename-source",
      "rename-destination",
      "symlink",
    ] as const
  ) {
    assertEquals(
      store.setPreparedXattr(
        parentIno,
        CFC_WRITEBACK_PREPARE_XATTR,
        prepareJson(operation, ref, { name: `${operation}-name` }),
      ).ok,
      true,
      operation,
    );
  }

  assertEquals(
    store.setPreparedXattr(
      parentIno,
      CFC_WRITEBACK_PREPARE_XATTR,
      prepareJson(
        "unlink",
        ref,
        { name: "bad", operation: "rename" },
      ).replace('"unlink"', '"rename"'),
    ).ok,
    false,
  );
});

Deno.test("writeback prepare parsing accepts metadata operation only by exact name", () => {
  const { fileIno, ref } = makeAnnotatedTree();
  const store = new CfcWritebackStore();

  assertEquals(
    store.setPreparedXattr(
      fileIno,
      CFC_WRITEBACK_PREPARE_XATTR,
      prepareJson("setattr-metadata", ref, {
        metadataFields: ["mode", "uid", "mtime"],
      }),
    ).ok,
    true,
  );
  assertEquals(
    store.setPreparedXattr(
      fileIno,
      CFC_WRITEBACK_PREPARE_XATTR,
      prepareJson("setattr-metadata", ref, {
        metadataFields: ["mode"],
      }).replace('"setattr-metadata"', '"setattr"'),
    ).ok,
    false,
  );
});

Deno.test("observe mode logs and allows missing metadata prepare", () => {
  const { tree, fileIno } = makeAnnotatedTree();
  const diagnostics: string[] = [];

  const result = authorizeMetadataWriteback({
    mode: "observe",
    annotation: tree.getCfcAnnotation(fileIno),
    prepared: undefined,
    requestedFields: ["mode", "uid"],
    diagnostics,
  });

  assertEquals(result.allowed, true);
  assertStringIncludes(
    diagnostics.join("\n"),
    "missing prepared CFC writeback metadata",
  );
});

Deno.test("enforce-explicit requires metadata prepare for annotated nodes only", () => {
  const { tree, fileIno } = makeAnnotatedTree();

  assertEquals(
    authorizeMetadataWriteback({
      mode: "enforce-explicit",
      annotation: tree.getCfcAnnotation(fileIno),
      prepared: undefined,
      requestedFields: ["mode"],
    }).allowed,
    false,
  );
  assertEquals(
    authorizeMetadataWriteback({
      mode: "enforce-explicit",
      annotation: undefined,
      prepared: undefined,
      requestedFields: ["mode"],
    }).allowed,
    true,
  );
});

Deno.test("enforce-strict rejects missing annotation stale annotation missing prepare and stale metadata prepare", () => {
  const { tree, fileIno, ref } = makeAnnotatedTree();
  const annotation = tree.getCfcAnnotation(fileIno);
  assertExists(annotation);

  assertEquals(
    authorizeMetadataWriteback({
      mode: "enforce-strict",
      annotation: undefined,
      prepared: undefined,
      requestedFields: ["mode"],
    }).allowed,
    false,
  );
  assertEquals(
    authorizeMetadataWriteback({
      mode: "enforce-strict",
      annotation: {
        ...annotation,
        ref: { ...annotation.ref, generation: "stale-ref" },
      },
      prepared: undefined,
      requestedFields: ["mode"],
    }).allowed,
    false,
  );
  assertEquals(
    authorizeMetadataWriteback({
      mode: "enforce-strict",
      annotation,
      prepared: undefined,
      requestedFields: ["mode"],
    }).allowed,
    false,
  );
  assertEquals(
    authorizeMetadataWriteback({
      mode: "enforce-strict",
      annotation,
      prepared: {
        version: 1,
        operation: "setattr-metadata",
        target: { ref },
        expectedGeneration: "stale-generation",
        labels: { metadataLabels: { mode: SECRET_LABEL } },
      },
      requestedFields: ["mode"],
    }).allowed,
    false,
  );
});

Deno.test("metadata prepare must cover requested metadata fields", () => {
  const { tree, fileIno, ref } = makeAnnotatedTree();
  const annotation = tree.getCfcAnnotation(fileIno);
  assertExists(annotation);

  assertEquals(
    authorizeMetadataWriteback({
      mode: "enforce-strict",
      annotation,
      prepared: {
        version: 1,
        operation: "setattr-metadata",
        target: { ref },
        expectedGeneration: ref.generation,
        labels: { metadataLabels: { mode: SECRET_LABEL } },
      },
      requestedFields: ["mode"],
    }).allowed,
    true,
  );
  assertEquals(
    authorizeMetadataWriteback({
      mode: "enforce-strict",
      annotation,
      prepared: {
        version: 1,
        operation: "setattr-metadata",
        target: { ref },
        expectedGeneration: ref.generation,
        labels: { metadataLabels: { mode: SECRET_LABEL } },
      },
      requestedFields: ["mode", "uid"],
    }).allowed,
    false,
  );
});

Deno.test("prepared metadata mutation preserves node data annotations and fail-closes unspecified metadata labels", () => {
  const { tree, fileIno, ref } = makeAnnotatedTree();
  const before = tree.getCfcAnnotation(fileIno);
  assertExists(before);

  applyPreparedMetadataMutation(
    tree,
    fileIno,
    {
      version: 1,
      operation: "setattr-metadata",
      target: { ref },
      expectedGeneration: ref.generation,
      labels: { metadataLabels: { mode: SECRET_LABEL, uid: SECRET_LABEL } },
    },
    ["mode", "uid"],
  );

  const annotation = tree.getCfcAnnotation(fileIno);
  assertExists(annotation);
  assertStringIncludes(annotation.generation, "prepared:sha256:");
  assertEquals(annotation.contentLabel, before.contentLabel);
  assertEquals(annotation.symlink, before.symlink);
  assertEquals(annotation.callable, before.callable);
  assertEquals(annotation.metadataLabels.mode, SECRET_LABEL);
  assertEquals(annotation.metadataLabels.uid, SECRET_LABEL);
  assertStringIncludes(
    JSON.stringify(annotation.metadataLabels.gid),
    "CommonFabricFuseProjectionMetadataIncomplete",
  );
  assertStringIncludes(annotation.incomplete?.reason ?? "", "prepared");
});

Deno.test("mixed size and metadata setattr requires truncate and metadata prepare", () => {
  const { tree, fileIno, ref } = makeAnnotatedTree();
  const annotation = tree.getCfcAnnotation(fileIno);
  assertExists(annotation);
  const truncatePrepare = {
    version: 1 as const,
    operation: "truncate" as const,
    target: { ref },
    expectedGeneration: ref.generation,
    labels: { contentLabel: SECRET_LABEL },
  };
  const metadataPrepare = {
    version: 1 as const,
    operation: "setattr-metadata" as const,
    target: { ref },
    expectedGeneration: ref.generation,
    labels: { metadataLabels: { mode: SECRET_LABEL } },
  };

  assertEquals(
    authorizeExistingWriteback({
      mode: "enforce-strict",
      operation: "truncate",
      annotation,
      prepared: truncatePrepare,
    }).allowed,
    true,
  );
  assertEquals(
    authorizeMetadataWriteback({
      mode: "enforce-strict",
      annotation,
      prepared: undefined,
      requestedFields: ["mode"],
    }).allowed,
    false,
  );
  assertEquals(
    authorizeMetadataWriteback({
      mode: "enforce-strict",
      annotation,
      prepared: metadataPrepare,
      requestedFields: ["mode"],
    }).allowed,
    true,
  );
});

Deno.test("symlink writeback authorization binds target name generation and identity", () => {
  const { tree, parentIno } = makeAnnotatedTree();
  const parentAnnotation = tree.getCfcAnnotation(parentIno);
  assertExists(parentAnnotation);
  const targetIdentity = { path: ["target"], space: "did:key:zSpace" };
  const prepared = {
    version: 1 as const,
    operation: "symlink" as const,
    target: {
      parentRef: parentAnnotation.ref,
      name: "link",
      targetText: "../target",
      targetIdentity,
    },
    expectedGeneration: parentAnnotation.generation,
    labels: { contentLabel: SECRET_LABEL },
  };

  assertEquals(
    authorizeSymlinkWriteback({
      mode: "enforce-strict",
      parentAnnotation,
      prepared,
      name: "link",
      targetText: "../target",
      targetIdentity: { space: "did:key:zSpace", path: ["target"] },
    }).allowed,
    true,
  );
  assertEquals(
    authorizeSymlinkWriteback({
      mode: "enforce-strict",
      parentAnnotation,
      prepared: { ...prepared, target: { ...prepared.target, name: "other" } },
      name: "link",
      targetText: "../target",
      targetIdentity,
    }).allowed,
    false,
  );
  assertEquals(
    authorizeSymlinkWriteback({
      mode: "enforce-strict",
      parentAnnotation,
      prepared,
      name: "link",
      targetText: "../different",
      targetIdentity,
    }).allowed,
    false,
  );
  assertEquals(
    authorizeSymlinkWriteback({
      mode: "enforce-strict",
      parentAnnotation,
      prepared: {
        ...prepared,
        expectedGeneration: "stale-generation",
      },
      name: "link",
      targetText: "../target",
      targetIdentity,
    }).allowed,
    false,
  );
});

Deno.test("observe mode logs and allows missing symlink prepare", () => {
  const { tree, parentIno } = makeAnnotatedTree();
  const diagnostics: string[] = [];

  const result = authorizeSymlinkWriteback({
    mode: "observe",
    parentAnnotation: tree.getCfcAnnotation(parentIno),
    prepared: undefined,
    name: "link",
    targetText: "../target",
    diagnostics,
  });

  assertEquals(result.allowed, true);
  assertStringIncludes(
    diagnostics.join("\n"),
    "missing prepared CFC writeback metadata",
  );
});

Deno.test("enforce-explicit requires symlink prepare only for annotated parents", () => {
  const { tree, parentIno } = makeAnnotatedTree();

  assertEquals(
    authorizeSymlinkWriteback({
      mode: "enforce-explicit",
      parentAnnotation: tree.getCfcAnnotation(parentIno),
      prepared: undefined,
      name: "link",
      targetText: "../target",
    }).allowed,
    false,
  );
  assertEquals(
    authorizeSymlinkWriteback({
      mode: "enforce-explicit",
      parentAnnotation: undefined,
      prepared: undefined,
      name: "link",
      targetText: "../target",
    }).allowed,
    true,
  );
});

Deno.test("enforce-strict rejects missing malformed and stale symlink prepare", () => {
  const { tree, parentIno } = makeAnnotatedTree();
  const parentAnnotation = tree.getCfcAnnotation(parentIno);
  assertExists(parentAnnotation);

  assertEquals(
    authorizeSymlinkWriteback({
      mode: "enforce-strict",
      parentAnnotation,
      prepared: undefined,
      name: "link",
      targetText: "../target",
    }).allowed,
    false,
  );
  assertEquals(
    authorizeSymlinkWriteback({
      mode: "enforce-strict",
      parentAnnotation,
      prepared: {
        version: 1,
        operation: "create",
        target: {
          parentRef: parentAnnotation.ref,
          name: "link",
          targetText: "../target",
        },
        expectedGeneration: parentAnnotation.generation,
        labels: {},
      },
      name: "link",
      targetText: "../target",
    }).allowed,
    false,
  );
  assertEquals(
    authorizeSymlinkWriteback({
      mode: "enforce-strict",
      parentAnnotation,
      prepared: {
        version: 1,
        operation: "symlink",
        target: {
          parentRef: parentAnnotation.ref,
          name: "link",
          targetText: "../target",
        },
        expectedGeneration: "stale-generation",
        labels: {},
      },
      name: "link",
      targetText: "../target",
    }).allowed,
    false,
  );
});

Deno.test("prepared symlink annotation is conservative and incomplete", () => {
  const { tree, parentIno } = makeAnnotatedTree();
  const parentAnnotation = tree.getCfcAnnotation(parentIno);
  assertExists(parentAnnotation);
  const prepared = {
    version: 1 as const,
    operation: "symlink" as const,
    target: {
      parentRef: parentAnnotation.ref,
      name: "link",
      targetText: "../target",
    },
    expectedGeneration: parentAnnotation.generation,
    labels: {
      contentLabel: SECRET_LABEL,
      nameLabel: SECRET_LABEL,
      existenceLabel: SECRET_LABEL,
      linkTextLabel: SECRET_LABEL,
      targetIdentityLabel: SECRET_LABEL,
    },
  };

  const childIno = applyPreparedSymlink(
    tree,
    parentIno,
    "link",
    "../target",
    prepared,
  );
  const child = tree.getNode(childIno);
  assertEquals(child?.kind, "symlink");
  const annotation = tree.getCfcAnnotation(childIno);
  assertExists(annotation);
  assertEquals(annotation.ref.projection, "symlink");
  assertStringIncludes(annotation.generation, "prepared:sha256:");
  assertEquals(annotation.contentLabel, SECRET_LABEL);
  assertEquals(annotation.symlink?.target, "../target");
  assertEquals(annotation.symlink?.linkTextLabel, SECRET_LABEL);
  assertEquals(annotation.symlink?.targetIdentityLabel, SECRET_LABEL);
  assertStringIncludes(annotation.incomplete?.reason ?? "", "prepared");
  assertEquals(
    tree.getCfcAnnotation(parentIno)?.entries?.entries.some((entry) =>
      entry.name === "link" && entry.kind === "symlink"
    ),
    true,
  );
});

Deno.test("observe mode logs and allows missing prepared writeback metadata", () => {
  const { tree, fileIno } = makeAnnotatedTree();
  const diagnostics: string[] = [];

  const result = authorizeExistingWriteback({
    mode: "observe",
    operation: "write",
    annotation: tree.getCfcAnnotation(fileIno),
    prepared: undefined,
    diagnostics,
  });

  assertEquals(result.allowed, true);
  assertEquals(result.requiresPrepare, false);
  assertStringIncludes(
    diagnostics.join("\n"),
    "missing prepared CFC writeback",
  );
});

Deno.test("enforce-explicit blocks annotated writes but allows unannotated paths", () => {
  const { tree, fileIno } = makeAnnotatedTree();

  assertEquals(
    authorizeExistingWriteback({
      mode: "enforce-explicit",
      operation: "write",
      annotation: tree.getCfcAnnotation(fileIno),
      prepared: undefined,
    }).allowed,
    false,
  );
  assertEquals(
    authorizeExistingWriteback({
      mode: "enforce-explicit",
      operation: "write",
      annotation: undefined,
      prepared: undefined,
    }).allowed,
    true,
  );
});

Deno.test("enforce-strict blocks missing, malformed, and stale writeback state", () => {
  const { tree, fileIno, ref } = makeAnnotatedTree();
  const annotation = tree.getCfcAnnotation(fileIno);

  assertEquals(
    authorizeExistingWriteback({
      mode: "enforce-strict",
      operation: "write",
      annotation: undefined,
      prepared: undefined,
    }).allowed,
    false,
  );

  assertEquals(
    authorizeExistingWriteback({
      mode: "enforce-strict",
      operation: "write",
      annotation,
      prepared: {
        version: 1,
        operation: "create",
        target: { ref },
        expectedGeneration: ref.generation,
        labels: {},
      },
    }).allowed,
    false,
  );

  assertEquals(
    authorizeExistingWriteback({
      mode: "enforce-strict",
      operation: "write",
      annotation,
      prepared: {
        version: 1,
        operation: "write",
        target: { ref },
        expectedGeneration: "stale-generation",
        labels: {},
      },
    }).allowed,
    false,
  );
});

Deno.test("prepared existing-file write applies conservative labels and can remain after failure", () => {
  const { tree, fileIno, ref } = makeAnnotatedTree();
  const store = new CfcWritebackStore();
  const prepared = store.setPreparedXattr(
    fileIno,
    CFC_WRITEBACK_PREPARE_XATTR,
    prepareJson("write", ref),
  );
  assertEquals(prepared.ok, true);

  const authorization = authorizeExistingWriteback({
    mode: "enforce-strict",
    operation: "write",
    annotation: tree.getCfcAnnotation(fileIno),
    prepared: store.getPrepared(fileIno, "write"),
  });
  assertEquals(authorization.allowed, true);
  if (!authorization.allowed) throw new Error(authorization.reason);
  assertExists(authorization.prepared);
  applyPreparedExistingWrite(tree, fileIno, authorization.prepared);

  const annotation = tree.getCfcAnnotation(fileIno);
  assertExists(annotation);
  assertStringIncludes(annotation.generation, "prepared:sha256:");
  assertEquals(annotation.contentLabel, SECRET_LABEL);

  // No finalize call simulates runner write failure after prepare: the
  // conservative prepared annotation remains in place.
  assertStringIncludes(tree.getCfcAnnotation(fileIno)!.generation, "prepared:");
});

Deno.test("parent-prepared create and mkdir gate occupancy-sensitive paths", () => {
  const { tree, parentIno } = makeAnnotatedTree();
  const parentAnnotation = tree.getCfcAnnotation(parentIno);
  assertExists(parentAnnotation);

  tree.addFile(parentIno, "occupied", "hidden", "string");

  assertEquals(
    authorizeCreateWriteback({
      mode: "enforce-strict",
      operation: "create",
      parentAnnotation,
      prepared: undefined,
      name: "occupied",
    }).allowed,
    false,
  );

  const store = new CfcWritebackStore();
  const parentRef = parentAnnotation.ref;
  const prepared = store.setPreparedXattr(
    parentIno,
    CFC_WRITEBACK_PREPARE_XATTR,
    prepareJson("create", parentRef, { name: "fresh" }),
  );
  assertEquals(prepared.ok, true);
  const authorization = authorizeCreateWriteback({
    mode: "enforce-strict",
    operation: "create",
    parentAnnotation,
    prepared: store.getPrepared(parentIno, "create", "fresh"),
    name: "fresh",
  });
  assertEquals(authorization.allowed, true);
  if (!authorization.allowed) throw new Error(authorization.reason);
  assertExists(authorization.prepared);

  applyPreparedCreate(tree, parentIno, "fresh", "file", authorization.prepared);
  const childIno = tree.lookup(parentIno, "fresh");
  assertExists(childIno);
  assertStringIncludes(
    tree.getCfcAnnotation(parentIno)!.generation,
    "prepared:",
  );
  assertStringIncludes(
    tree.getCfcAnnotation(childIno)!.generation,
    "prepared:",
  );

  const preparedParentRef = tree.getCfcAnnotation(parentIno)!.ref;
  const mkdirPrepared = store.setPreparedXattr(
    parentIno,
    CFC_WRITEBACK_PREPARE_XATTR,
    prepareJson("mkdir", preparedParentRef, { name: "dir" }),
  );
  assertEquals(mkdirPrepared.ok, true);
  assertEquals(
    authorizeCreateWriteback({
      mode: "enforce-strict",
      operation: "mkdir",
      parentAnnotation: tree.getCfcAnnotation(parentIno),
      prepared: store.getPrepared(parentIno, "mkdir", "dir"),
      name: "dir",
    }).allowed,
    true,
  );
});

Deno.test("observe mode logs and allows missing namespace mutation prepare", () => {
  const { tree, parentIno } = makeAnnotatedTree();
  const diagnostics: string[] = [];

  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "observe",
      operation: "unlink",
      parentAnnotation: tree.getCfcAnnotation(parentIno),
      prepared: undefined,
      name: "missing-child",
      diagnostics,
    }).allowed,
    true,
  );
  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "observe",
      operation: "rename-source",
      parentAnnotation: tree.getCfcAnnotation(parentIno),
      prepared: undefined,
      name: "old",
      pairedName: "new",
      diagnostics,
    }).allowed,
    true,
  );
  assertStringIncludes(
    diagnostics.join("\n"),
    "missing prepared CFC writeback metadata",
  );
});

Deno.test("enforce-explicit requires namespace prepare only for annotated parents", () => {
  const { tree, parentIno } = makeAnnotatedTree();

  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-explicit",
      operation: "unlink",
      parentAnnotation: tree.getCfcAnnotation(parentIno),
      prepared: undefined,
      name: "title",
    }).allowed,
    false,
  );
  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-explicit",
      operation: "unlink",
      parentAnnotation: undefined,
      prepared: undefined,
      name: "ordinary",
    }).allowed,
    true,
  );
});

Deno.test("enforce-strict rejects missing malformed and stale namespace prepare", () => {
  const { tree, parentIno } = makeAnnotatedTree();
  const parentAnnotation = tree.getCfcAnnotation(parentIno);
  assertExists(parentAnnotation);

  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-strict",
      operation: "rmdir",
      parentAnnotation,
      prepared: undefined,
      name: "dir",
    }).allowed,
    false,
  );
  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-strict",
      operation: "rmdir",
      parentAnnotation,
      prepared: {
        version: 1,
        operation: "unlink",
        target: { parentRef: parentAnnotation.ref, name: "dir" },
        expectedGeneration: parentAnnotation.generation,
        labels: {},
      },
      name: "dir",
    }).allowed,
    false,
  );
  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-strict",
      operation: "rmdir",
      parentAnnotation,
      prepared: {
        version: 1,
        operation: "rmdir",
        target: { parentRef: parentAnnotation.ref, name: "other" },
        expectedGeneration: parentAnnotation.generation,
        labels: {},
      },
      name: "dir",
    }).allowed,
    false,
  );
  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-strict",
      operation: "rmdir",
      parentAnnotation,
      prepared: {
        version: 1,
        operation: "rmdir",
        target: { parentRef: parentAnnotation.ref, name: "dir" },
        expectedGeneration: "stale-generation",
        labels: {},
      },
      name: "dir",
    }).allowed,
    false,
  );
});

Deno.test("namespace prepare gates before occupancy-sensitive lookup", () => {
  const { tree, parentIno } = makeAnnotatedTree();
  const parentAnnotation = tree.getCfcAnnotation(parentIno);
  assertExists(parentAnnotation);

  const result = authorizeNamespaceMutationWriteback({
    mode: "enforce-strict",
    operation: "unlink",
    parentAnnotation,
    prepared: undefined,
    name: "does-not-exist",
  });

  assertEquals(result.allowed, false);
  if (result.allowed) throw new Error("expected namespace writeback rejection");
  assertStringIncludes(result.reason, "prepared CFC writeback metadata");
});

Deno.test("rename prepare validation binds source and destination parent generations and names", () => {
  const { tree, parentIno } = makeAnnotatedTree();
  const destinationParentIno = tree.addDir(tree.rootIno, "other", "object");
  const parentAnnotation = tree.getCfcAnnotation(parentIno);
  assertExists(parentAnnotation);
  tree.setCfcAnnotation(destinationParentIno, {
    ...parentAnnotation,
    ref: {
      ...parentAnnotation.ref,
      path: ["other"],
      generation: "generation-2",
    },
    generation: "generation-2",
  });
  const destinationAnnotation = tree.getCfcAnnotation(destinationParentIno);
  assertExists(destinationAnnotation);

  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-strict",
      operation: "rename-source",
      parentAnnotation,
      prepared: {
        version: 1,
        operation: "rename-source",
        target: {
          parentRef: parentAnnotation.ref,
          name: "title",
          sourceName: "title",
          destinationName: "renamed",
        },
        expectedGeneration: parentAnnotation.generation,
        labels: {},
      },
      name: "title",
      pairedName: "renamed",
    }).allowed,
    true,
  );
  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-strict",
      operation: "rename-destination",
      parentAnnotation: destinationAnnotation,
      prepared: {
        version: 1,
        operation: "rename-destination",
        target: {
          parentRef: destinationAnnotation.ref,
          name: "renamed",
          sourceName: "title",
          destinationName: "renamed",
        },
        expectedGeneration: destinationAnnotation.generation,
        labels: {},
      },
      name: "renamed",
      pairedName: "title",
    }).allowed,
    true,
  );
  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-strict",
      operation: "rename-destination",
      parentAnnotation: destinationAnnotation,
      prepared: {
        version: 1,
        operation: "rename-destination",
        target: {
          parentRef: parentAnnotation.ref,
          name: "renamed",
          sourceName: "title",
          destinationName: "renamed",
        },
        expectedGeneration: parentAnnotation.generation,
        labels: {},
      },
      name: "renamed",
      pairedName: "title",
    }).allowed,
    false,
  );
  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-strict",
      operation: "rename-destination",
      parentAnnotation: destinationAnnotation,
      prepared: {
        version: 1,
        operation: "rename-destination",
        target: {
          parentRef: destinationAnnotation.ref,
          name: "other",
          sourceName: "title",
          destinationName: "other",
        },
        expectedGeneration: destinationAnnotation.generation,
        labels: {},
      },
      name: "renamed",
      pairedName: "title",
    }).allowed,
    false,
  );
});

Deno.test("same-parent rename can use one prepare record covering both names", () => {
  const { tree, parentIno } = makeAnnotatedTree();
  const parentAnnotation = tree.getCfcAnnotation(parentIno);
  assertExists(parentAnnotation);
  const prepared = {
    version: 1 as const,
    operation: "rename-source" as const,
    target: {
      sourceParentRef: parentAnnotation.ref,
      name: "title",
      destinationName: "renamed",
    },
    expectedGeneration: parentAnnotation.generation,
    labels: {},
  };

  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-strict",
      operation: "rename-source",
      parentAnnotation,
      prepared,
      name: "title",
      pairedName: "renamed",
      allowPairedRenamePrepare: true,
    }).allowed,
    true,
  );
  assertEquals(
    authorizeNamespaceMutationWriteback({
      mode: "enforce-strict",
      operation: "rename-destination",
      parentAnnotation,
      prepared,
      name: "renamed",
      pairedName: "title",
      allowPairedRenamePrepare: true,
    }).allowed,
    true,
  );
});

Deno.test("writeback xattrs accept trusted names and compat transport names", () => {
  assertEquals(
    normalizeCfcWritebackXattrName(CFC_COMPAT_WRITEBACK_PREPARE_XATTR),
    CFC_WRITEBACK_PREPARE_XATTR,
  );
  assertEquals(
    normalizeCfcWritebackXattrName(CFC_COMPAT_WRITEBACK_FINALIZE_XATTR),
    CFC_WRITEBACK_FINALIZE_XATTR,
  );
  assertEquals(normalizeCfcWritebackXattrName("user.example"), null);

  const { fileIno, ref } = makeAnnotatedTree();
  const store = new CfcWritebackStore();

  assertEquals(
    store.setPreparedXattr(
      fileIno,
      CFC_COMPAT_WRITEBACK_PREPARE_XATTR,
      prepareJson("write", ref),
    ).ok,
    true,
  );
  assertExists(store.getPrepared(fileIno, "write"));
  assertEquals(
    store.setPreparedXattr(fileIno, CFC_WRITEBACK_PREPARE_XATTR, "{").ok,
    false,
  );
  assertEquals(
    store.setPreparedXattr(
      fileIno,
      CFC_WRITEBACK_PREPARE_XATTR,
      prepareJson("write", ref),
    ).ok,
    true,
  );
  assertExists(store.getPrepared(fileIno, "write"));
  assertEquals(
    store.setFinalizeXattr(
      fileIno,
      CFC_COMPAT_WRITEBACK_FINALIZE_XATTR,
      JSON.stringify({
        version: 1,
        operation: "write",
        committedGeneration: "generation-2",
      }),
    ).ok,
    true,
  );
  assertEquals(store.getPrepared(fileIno, "write"), undefined);

  const { parentIno, ref: parentRef } = makeAnnotatedTree();
  assertEquals(
    store.setPreparedXattr(
      parentIno,
      CFC_WRITEBACK_PREPARE_XATTR,
      prepareJson("create", parentRef, { name: "fresh" }),
    ).ok,
    true,
  );
  assertExists(store.getPrepared(parentIno, "create", "fresh"));
  assertEquals(
    store.setFinalizeXattr(
      parentIno,
      CFC_WRITEBACK_FINALIZE_XATTR,
      JSON.stringify({
        version: 1,
        operation: "create",
        committedGeneration: "generation-2",
      }),
    ).ok,
    true,
  );
  assertEquals(store.getPrepared(parentIno, "create", "fresh"), undefined);
});

Deno.test("writeback recovery store persists crash-point states", async () => {
  const path = await Deno.makeTempFile();
  try {
    const { fileIno, ref } = makeAnnotatedTree();
    const store = new CfcWritebackStore({ storagePath: path });
    const prepared = store.setPreparedXattr(
      fileIno,
      CFC_WRITEBACK_PREPARE_XATTR,
      prepareJson("write", ref),
    );
    assertEquals(prepared.ok, true);
    assertEquals(store.snapshot().records[0].status, "pending-prepare");

    store.markMutationApplied(fileIno, "write");
    assertEquals(store.snapshot().records[0].status, "mutation-applied");

    store.markRunnerCommitFailed(fileIno, "write", "transport closed");
    assertEquals(store.snapshot().records[0].status, "runner-commit-failed");
    assertStringIncludes(
      store.snapshot().records[0].diagnostics.join("\n"),
      "transport closed",
    );

    const restarted = new CfcWritebackStore({ storagePath: path });
    assertEquals(
      restarted.snapshot().records[0].status,
      "runner-commit-failed",
    );

    restarted.markReadyForExactRecomputation(fileIno, "write");
    assertEquals(
      restarted.snapshot().records[0].status,
      "ready-for-exact-recomputation",
    );

    restarted.markFinalizedPendingCleanup(fileIno, "write");
    assertEquals(
      restarted.snapshot().records[0].status,
      "finalized-pending-cleanup",
    );
  } finally {
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("writeback recovery records malformed and unsupported prepare metadata", () => {
  const { fileIno } = makeAnnotatedTree();
  const store = new CfcWritebackStore();

  assertEquals(
    store.setPreparedXattr(fileIno, CFC_WRITEBACK_PREPARE_XATTR, "{").ok,
    false,
  );
  assertEquals(
    store.setPreparedXattr(fileIno, "trusted.cfc.unsupported", "{}").ok,
    false,
  );

  const snapshot = store.snapshot();
  assertEquals(
    snapshot.records.map((record) => record.status),
    ["malformed-prepare", "malformed-prepare"],
  );
  assertStringIncludes(
    snapshot.records.map((record) => record.diagnostics.join("\n")).join("\n"),
    "invalid prepare metadata",
  );
  assertStringIncludes(
    snapshot.records.map((record) => record.diagnostics.join("\n")).join("\n"),
    "unsupported writeback xattr",
  );
});

Deno.test("writeback reconciliation reapplies prepared labels after inode rebuild", async () => {
  const path = await Deno.makeTempFile();
  try {
    const { fileIno, ref } = makeAnnotatedTree();
    const store = new CfcWritebackStore({ storagePath: path });
    assertEquals(
      store.setPreparedXattr(
        fileIno,
        CFC_WRITEBACK_PREPARE_XATTR,
        prepareJson("write", ref),
      ).ok,
      true,
    );
    store.markMutationApplied(fileIno, "write");

    const rebuilt = makeAnnotatedTree({ inodeChurn: true });
    assertEquals(rebuilt.fileIno === fileIno, false);
    const restarted = new CfcWritebackStore({ storagePath: path });
    const result = restarted.reconcileTree(rebuilt.tree);

    assertEquals(result.reapplied, 1);
    assertStringIncludes(
      rebuilt.tree.getCfcAnnotation(rebuilt.fileIno)!.generation,
      "prepared:sha256:",
    );
    assertEquals(
      restarted.snapshot().records[0].status,
      "mutation-applied",
    );
  } finally {
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("writeback reconciliation finalizes exact annotations when ready for recomputation", () => {
  const { tree, fileIno, ref } = makeAnnotatedTree();
  const store = new CfcWritebackStore();
  assertEquals(
    store.setPreparedXattr(
      fileIno,
      CFC_WRITEBACK_PREPARE_XATTR,
      prepareJson("write", ref),
    ).ok,
    true,
  );
  store.markReadyForExactRecomputation(fileIno, "write");

  const exact = tree.getCfcAnnotation(fileIno)!;
  tree.setCfcAnnotation(fileIno, {
    ...exact,
    generation: "generation-2",
    ref: { ...exact.ref, generation: "generation-2" },
    incomplete: undefined,
  });

  const result = store.reconcileTree(tree);

  assertEquals(result.finalized, 1);
  assertEquals(store.snapshot().records, []);
  assertEquals(tree.getCfcAnnotation(fileIno)!.generation, "generation-2");
});

Deno.test("writeback reconciliation cleans finalize-before-cleanup records after exact rebuild", () => {
  const { tree, fileIno, ref } = makeAnnotatedTree();
  const store = new CfcWritebackStore();
  assertEquals(
    store.setPreparedXattr(
      fileIno,
      CFC_WRITEBACK_PREPARE_XATTR,
      prepareJson("write", ref),
    ).ok,
    true,
  );
  store.markMutationApplied(fileIno, "write");
  store.markReadyForExactRecomputation(fileIno, "write");
  store.markFinalizedPendingCleanup(fileIno, "write");

  const exact = tree.getCfcAnnotation(fileIno)!;
  tree.setCfcAnnotation(fileIno, {
    ...exact,
    generation: "generation-2",
    ref: { ...exact.ref, generation: "generation-2" },
    incomplete: undefined,
  });

  const result = store.reconcileTree(tree);

  assertEquals(result.finalized, 1);
  assertEquals(store.snapshot().records, []);
  assertEquals(tree.getCfcAnnotation(fileIno)!.generation, "generation-2");
});

Deno.test("writeback reconciliation marks stale generations without lowering labels", () => {
  const { tree, fileIno, ref } = makeAnnotatedTree();
  const store = new CfcWritebackStore();
  assertEquals(
    store.setPreparedXattr(
      fileIno,
      CFC_WRITEBACK_PREPARE_XATTR,
      prepareJson("write", ref),
    ).ok,
    true,
  );

  const exact = tree.getCfcAnnotation(fileIno)!;
  tree.setCfcAnnotation(fileIno, {
    ...exact,
    generation: "generation-2",
    ref: { ...exact.ref, generation: "generation-2" },
    incomplete: undefined,
  });

  const result = store.reconcileTree(tree);

  assertEquals(result.stale, 1);
  assertEquals(store.snapshot().records[0].status, "stale-generation");
  assertStringIncludes(
    tree.getCfcAnnotation(fileIno)!.generation,
    "prepared:sha256:",
  );
});
