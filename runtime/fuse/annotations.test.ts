import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import { buildCallableScript } from "./callables.ts";
import {
  CFC_COMPAT_XATTR_PREFIX,
  CFC_FAIL_CLOSED_ATOM_CLASS,
  CFC_TRUSTED_XATTR_PREFIX,
  CfcProjectionAnnotator,
  deriveCfcProjectionGeneration,
  getCfcXattrValue,
  listCfcXattrNames,
} from "./annotations.ts";
import { FsTree } from "./tree.ts";
import { buildJsonTree } from "./tree-builder.ts";

const decoder = new TextDecoder();

const TITLE_LABEL = {
  confidentiality: [{ type: "test-label", value: "title" }],
};
const BODY_LABEL = {
  confidentiality: [{ type: "test-label", value: "body" }],
};
const LINK_LABEL = {
  confidentiality: [{ type: "test-label", value: "link" }],
};
const SCHEMA_LABEL = {
  confidentiality: [{ type: "test-label", value: "schema" }],
};

function makeAnnotator(
  tree: FsTree,
  entries: Array<{
    path: string[];
    label: { confidentiality?: unknown[]; integrity?: unknown[] };
  }> = [],
  generation = "generation-1",
): CfcProjectionAnnotator {
  return new CfcProjectionAnnotator(tree, {
    space: "did:key:zSpace",
    entity: "of:entity-123",
    rootKind: "pieces",
    cell: "result",
    generation,
    labelView: { version: 1, entries },
  });
}

function inoAt(tree: FsTree, path: string[]): bigint {
  let ino = tree.rootIno;
  for (const part of path) {
    const next = tree.lookup(ino, part);
    if (next === undefined) {
      throw new Error(`Missing path segment ${part} in /${path.join("/")}`);
    }
    ino = next;
  }
  return ino;
}

function annotationJson(
  tree: FsTree,
  ino: bigint,
  name: string,
  namespace: "trusted" | "compat" | "both" = "compat",
): unknown {
  const value = getCfcXattrValue(tree, ino, name, {
    enabled: true,
    namespace,
  });
  assertExists(value);
  return JSON.parse(decoder.decode(value));
}

function annotationText(
  tree: FsTree,
  ino: bigint,
  name: string,
  namespace: "trusted" | "compat" | "both" = "compat",
): string {
  const value = getCfcXattrValue(tree, ino, name, {
    enabled: true,
    namespace,
  });
  assertExists(value);
  return decoder.decode(value);
}

Deno.test("CFC annotations use stable refs independent of transient inodes", () => {
  const data = { items: [{ text: "one" }] };
  const labels = [
    { path: ["items", "0", "text"], label: TITLE_LABEL },
  ];

  const firstTree = new FsTree();
  const firstAnnotator = makeAnnotator(firstTree, labels);
  buildJsonTree(
    firstTree,
    firstTree.rootIno,
    "result",
    data,
    undefined,
    0,
    undefined,
    undefined,
    firstAnnotator.jsonContext([]),
  );
  const firstTextIno = inoAt(firstTree, ["result", "items", "0", "text"]);
  const firstRef = firstTree.getCfcAnnotation(firstTextIno)?.ref;
  assertExists(firstRef);

  const secondTree = new FsTree();
  secondTree.addFile(secondTree.rootIno, "unrelated", "x", "string");
  const secondAnnotator = makeAnnotator(secondTree, labels);
  buildJsonTree(
    secondTree,
    secondTree.rootIno,
    "result",
    data,
    undefined,
    0,
    undefined,
    undefined,
    secondAnnotator.jsonContext([]),
  );
  const secondTextIno = inoAt(secondTree, ["result", "items", "0", "text"]);
  const secondRef = secondTree.getCfcAnnotation(secondTextIno)?.ref;
  assertExists(secondRef);

  assert(firstTextIno !== secondTextIno);
  assertEquals(firstRef, secondRef);
});

Deno.test("CFC aggregate JSON annotations join descendant labels", () => {
  const tree = new FsTree();
  const annotator = makeAnnotator(tree, [
    { path: ["title"], label: TITLE_LABEL },
    { path: ["nested", "body"], label: BODY_LABEL },
  ]);

  buildJsonTree(
    tree,
    tree.rootIno,
    "result",
    { title: "hello", nested: { body: "secret" } },
    undefined,
    0,
    undefined,
    undefined,
    annotator.jsonContext([]),
  );

  const resultJsonIno = inoAt(tree, ["result.json"]);
  const label = tree.getCfcAnnotation(resultJsonIno)?.contentLabel;
  assertEquals(label?.confidentiality, [
    TITLE_LABEL.confidentiality![0],
    BODY_LABEL.confidentiality![0],
  ]);
});

Deno.test("CFC directory entries include child refs and entry labels", () => {
  const tree = new FsTree();
  const annotator = makeAnnotator(tree, [
    { path: ["title"], label: TITLE_LABEL },
  ]);

  buildJsonTree(
    tree,
    tree.rootIno,
    "result",
    { title: "hello" },
    undefined,
    0,
    undefined,
    undefined,
    annotator.jsonContext([]),
  );

  const resultIno = inoAt(tree, ["result"]);
  const titleIno = inoAt(tree, ["result", "title"]);
  const entries = tree.getCfcAnnotation(resultIno)?.entries?.entries ?? [];
  const titleEntry = entries.find((entry) => entry.name === "title");
  assertExists(titleEntry);
  assertEquals(titleEntry.kind, "file");
  assertEquals(titleEntry.childRef, tree.getCfcAnnotation(titleIno)?.ref);
  assertEquals(titleEntry.nameLabel, TITLE_LABEL);
  assertEquals(titleEntry.existenceLabel, TITLE_LABEL);
  assertExists(titleEntry.metadataLabels.size);
});

Deno.test("CFC symlink annotations include link text and target metadata", () => {
  const tree = new FsTree();
  const annotator = makeAnnotator(tree, [
    { path: ["ref"], label: LINK_LABEL },
  ]);

  buildJsonTree(
    tree,
    tree.rootIno,
    "result",
    { ref: { "/": { "link@1": { id: "of:target" } } } },
    () => "../../../entities/of:target",
    0,
    undefined,
    undefined,
    annotator.jsonContext([]),
  );

  const linkIno = inoAt(tree, ["result", "ref"]);
  const annotation = tree.getCfcAnnotation(linkIno);
  assertExists(annotation);
  assertEquals(annotation.ref.projection, "symlink");
  assertEquals(annotation.symlink?.target, "../../../entities/of:target");
  assertEquals(annotation.symlink?.linkTextLabel, LINK_LABEL);
  assertEquals(
    annotation.contentLabel?.confidentiality?.[0],
    LINK_LABEL.confidentiality![0],
  );
});

Deno.test("CFC callable annotations separate descriptor bytes from invocation authority", () => {
  const tree = new FsTree();
  const annotator = makeAnnotator(tree);
  const resultIno = tree.addDir(tree.rootIno, "result", "object");
  annotator.annotateJsonDirectory(resultIno, [], {});

  const callableIno = tree.addCallable(
    resultIno,
    "search.tool",
    "tool",
    "search",
    "result",
    buildCallableScript("/tmp/cf-exec", undefined, "string"),
  );
  annotator.annotateCallable(callableIno, ["search"], {
    callableKind: "tool",
    cellKey: "search",
    cellProp: "result",
    schemaLabel: SCHEMA_LABEL,
  });

  const annotation = tree.getCfcAnnotation(callableIno);
  assertExists(annotation);
  assertEquals(annotation.ref.projection, "callable");
  assertEquals(
    annotation.callable?.descriptor.contentLabel,
    annotation.contentLabel,
  );
  assertEquals(
    annotation.callable?.invocation.boundary,
    "common-fabric-runtime",
  );
  assertEquals(
    annotation.callable?.invocation.authority,
    "not-conveyed-by-file-bytes",
  );
  assertEquals(annotation.callable?.schemaLabel, SCHEMA_LABEL);
});

Deno.test("CFC annotations fail closed when runner path metadata is missing", () => {
  const tree = new FsTree();
  const annotator = makeAnnotator(tree);

  buildJsonTree(
    tree,
    tree.rootIno,
    "result",
    { title: "hello" },
    undefined,
    0,
    undefined,
    undefined,
    annotator.jsonContext([]),
  );

  const titleIno = inoAt(tree, ["result", "title"]);
  const label = tree.getCfcAnnotation(titleIno)?.contentLabel;
  assert(
    JSON.stringify(label).includes(CFC_FAIL_CLOSED_ATOM_CLASS),
    "missing labels must carry the fail-closed CFC caveat",
  );
});

Deno.test("CFC xattr compatibility namespace is opt-in", () => {
  const tree = new FsTree();
  const annotator = makeAnnotator(tree, [
    { path: ["title"], label: TITLE_LABEL },
  ]);

  buildJsonTree(
    tree,
    tree.rootIno,
    "result",
    { title: "hello" },
    undefined,
    0,
    undefined,
    undefined,
    annotator.jsonContext([]),
  );

  const titleIno = inoAt(tree, ["result", "title"]);
  assertEquals(
    listCfcXattrNames(tree, titleIno, { enabled: false, namespace: "compat" }),
    [],
  );

  const names = listCfcXattrNames(tree, titleIno, {
    enabled: true,
    namespace: "compat",
  });
  assert(names.includes(`${CFC_COMPAT_XATTR_PREFIX}ref`));

  const ref = annotationJson(tree, titleIno, `${CFC_COMPAT_XATTR_PREFIX}ref`);
  assertEquals((ref as { projection?: string }).projection, "value");
});

Deno.test("CFC projection generation is deterministic over value, labels, and profile version", () => {
  const base = {
    space: "did:key:zSpace",
    entity: "of:entity-123",
    rootKind: "pieces" as const,
    cell: "result" as const,
    value: { title: "hello" },
    labelView: {
      version: 1 as const,
      entries: [{ path: ["title"], label: TITLE_LABEL }],
    },
  };

  const first = deriveCfcProjectionGeneration(base);
  const reorderedLabel = deriveCfcProjectionGeneration({
    ...base,
    labelView: {
      version: 1,
      entries: [{ label: TITLE_LABEL, path: ["title"] }],
    },
  });
  const valueChanged = deriveCfcProjectionGeneration({
    ...base,
    value: { title: "goodbye" },
  });
  const labelChanged = deriveCfcProjectionGeneration({
    ...base,
    labelView: {
      version: 1,
      entries: [{ path: ["title"], label: BODY_LABEL }],
    },
  });
  const profileChanged = deriveCfcProjectionGeneration({
    ...base,
    profileVersion: "common-fabric-fuse-projection-v2-test",
  });

  assertEquals(first, reorderedLabel);
  assert(first.startsWith("sha256:"));
  assertNotEquals(first, valueChanged);
  assertNotEquals(first, labelChanged);
  assertNotEquals(first, profileChanged);
});

Deno.test("CFC golden xattr contract covers namespaces, value formats, and optional fields", () => {
  const tree = new FsTree();
  const value = {
    title: "hello",
    items: ["a", "b"],
    ref: { "/": { "link@1": { id: "of:target" } } },
  };
  const labels = [
    { path: ["title"], label: TITLE_LABEL },
    { path: ["items", "0"], label: BODY_LABEL },
    { path: ["items", "1"], label: BODY_LABEL },
    { path: ["ref"], label: LINK_LABEL },
  ];
  const generation = deriveCfcProjectionGeneration({
    space: "did:key:zSpace",
    entity: "of:entity-123",
    rootKind: "pieces",
    cell: "result",
    value,
    labelView: { version: 1, entries: labels },
  });
  const annotator = makeAnnotator(tree, labels, generation);

  buildJsonTree(
    tree,
    tree.rootIno,
    "result",
    value,
    () => "../../../entities/of:target",
    0,
    undefined,
    undefined,
    annotator.jsonContext([]),
  );
  const resultIno = inoAt(tree, ["result"]);
  const titleIno = inoAt(tree, ["result", "title"]);
  const itemsIno = inoAt(tree, ["result", "items"]);
  const resultJsonIno = inoAt(tree, ["result.json"]);
  const linkIno = inoAt(tree, ["result", "ref"]);

  const callableIno = tree.addCallable(
    resultIno,
    "search.tool",
    "tool",
    "search",
    "result",
    buildCallableScript("/tmp/cf-exec", undefined, "string"),
  );
  annotator.annotateCallable(callableIno, ["search"], {
    callableKind: "tool",
    cellKey: "search",
    cellProp: "result",
    schemaLabel: SCHEMA_LABEL,
  });
  annotator.annotateEntry(resultIno, "search.tool", callableIno, {
    labelPath: ["search"],
  });

  const manifestIno = tree.addFile(
    tree.rootIno,
    "pieces.json",
    JSON.stringify([{ id: "of:entity-123", name: "note" }], null, 2),
    "object",
  );
  annotator.annotateSynthetic(manifestIno, {
    projection: "pieces-manifest",
    path: ["pieces.json"],
    contentLabel: TITLE_LABEL,
    ref: { cell: undefined, rootKind: "pieces" },
  });

  const bothNames = listCfcXattrNames(tree, titleIno, {
    enabled: true,
    namespace: "both",
  });
  assert(bothNames.includes(`${CFC_TRUSTED_XATTR_PREFIX}ref`));
  assert(bothNames.includes(`${CFC_COMPAT_XATTR_PREFIX}ref`));

  assertEquals(
    annotationText(
      tree,
      titleIno,
      `${CFC_TRUSTED_XATTR_PREFIX}generation`,
      "trusted",
    ),
    generation,
  );
  assertThrows(() =>
    JSON.parse(
      annotationText(
        tree,
        titleIno,
        `${CFC_TRUSTED_XATTR_PREFIX}generation`,
        "trusted",
      ),
    )
  );

  const trustedRef = annotationJson(
    tree,
    titleIno,
    `${CFC_TRUSTED_XATTR_PREFIX}ref`,
    "trusted",
  ) as { generation?: string; projection?: string };
  const compatRef = annotationJson(
    tree,
    titleIno,
    `${CFC_COMPAT_XATTR_PREFIX}ref`,
    "compat",
  );
  assertEquals(trustedRef, compatRef);
  assertEquals(trustedRef.generation, generation);
  assertEquals(trustedRef.projection, "value");

  const titleNames = listCfcXattrNames(tree, titleIno, {
    enabled: true,
    namespace: "trusted",
  });
  assert(!titleNames.includes(`${CFC_TRUSTED_XATTR_PREFIX}entries`));
  assert(!titleNames.includes(`${CFC_TRUSTED_XATTR_PREFIX}namespaceLabel`));
  assert(!titleNames.includes(`${CFC_TRUSTED_XATTR_PREFIX}callable`));

  const dirEntries = annotationJson(
    tree,
    itemsIno,
    `${CFC_TRUSTED_XATTR_PREFIX}entries`,
    "trusted",
  ) as {
    entries?: Array<{ name?: string; childRef?: { generation?: string } }>;
  };
  assertEquals(dirEntries.entries?.map((entry) => entry.name).sort(), [
    "0",
    "1",
  ]);
  assertEquals(
    dirEntries.entries?.every((entry) =>
      entry.childRef?.generation === generation
    ),
    true,
  );

  const aggregateLabel = annotationJson(
    tree,
    resultJsonIno,
    `${CFC_TRUSTED_XATTR_PREFIX}contentLabel`,
    "trusted",
  );
  assertEquals(
    (aggregateLabel as { confidentiality?: unknown[] }).confidentiality,
    [
      TITLE_LABEL.confidentiality![0],
      BODY_LABEL.confidentiality![0],
      LINK_LABEL.confidentiality![0],
    ],
  );

  const symlinkLabel = annotationJson(
    tree,
    linkIno,
    `${CFC_TRUSTED_XATTR_PREFIX}contentLabel`,
    "trusted",
  );
  assertEquals(
    (symlinkLabel as { confidentiality?: unknown[] }).confidentiality,
    [
      LINK_LABEL.confidentiality![0],
      {
        type: "https://commonfabric.org/cfc/atom/Resource",
        class: "CommonFabricFuseSymlinkTarget",
        subject: "did:web:commonfabric.org#runtime",
        scope: { target: "../../../entities/of:target" },
      },
    ],
  );

  const symlinkRef = annotationJson(
    tree,
    linkIno,
    `${CFC_TRUSTED_XATTR_PREFIX}ref`,
    "trusted",
  ) as { projection?: string; generation?: string };
  assertEquals(symlinkRef.projection, "symlink");
  assertEquals(symlinkRef.generation, generation);
  const symlink = annotationJson(
    tree,
    linkIno,
    `${CFC_TRUSTED_XATTR_PREFIX}symlink`,
    "trusted",
  ) as {
    target?: string;
    linkTextLabel?: unknown;
    targetIdentityLabel?: unknown;
  };
  assertEquals(symlink.target, "../../../entities/of:target");
  assertEquals(symlink.linkTextLabel, LINK_LABEL);
  assertEquals(
    (symlink.targetIdentityLabel as { confidentiality?: unknown[] })
      .confidentiality,
    [
      {
        type: "https://commonfabric.org/cfc/atom/Resource",
        class: "CommonFabricFuseSymlinkTarget",
        subject: "did:web:commonfabric.org#runtime",
        scope: { target: "../../../entities/of:target" },
      },
    ],
  );

  const callable = annotationJson(
    tree,
    callableIno,
    `${CFC_TRUSTED_XATTR_PREFIX}callable`,
    "trusted",
  ) as {
    descriptor?: { generation?: string };
    invocation?: { authority?: string };
  };
  assertEquals(callable.descriptor?.generation, generation);
  assertEquals(callable.invocation?.authority, "not-conveyed-by-file-bytes");

  const manifestRef = annotationJson(
    tree,
    manifestIno,
    `${CFC_TRUSTED_XATTR_PREFIX}ref`,
    "trusted",
  ) as { projection?: string; generation?: string };
  assertEquals(manifestRef.projection, "pieces-manifest");
  assertEquals(manifestRef.generation, generation);
});

Deno.test("CFC generation changes on value or label metadata changes without inode-sensitive refs", () => {
  const labels = [{ path: ["title"], label: TITLE_LABEL }];
  const build = (value: unknown, labelEntries = labels) => {
    const tree = new FsTree();
    tree.addFile(tree.rootIno, "inode-churn", "x", "string");
    const generation = deriveCfcProjectionGeneration({
      space: "did:key:zSpace",
      entity: "of:entity-123",
      rootKind: "pieces",
      cell: "result",
      value,
      labelView: { version: 1, entries: labelEntries },
    });
    const annotator = makeAnnotator(tree, labelEntries, generation);
    buildJsonTree(
      tree,
      tree.rootIno,
      "result",
      value,
      undefined,
      0,
      undefined,
      undefined,
      annotator.jsonContext([]),
    );
    const titleIno = inoAt(tree, ["result", "title"]);
    return {
      ref: tree.getCfcAnnotation(titleIno)?.ref,
      generation: tree.getCfcAnnotation(titleIno)?.generation,
    };
  };

  const original = build({ title: "hello" });
  const same = build({ title: "hello" });
  const valueChanged = build({ title: "goodbye" });
  const labelChanged = build({ title: "hello" }, [
    { path: ["title"], label: BODY_LABEL },
  ]);

  assertEquals(original.ref, same.ref);
  assertEquals(original.generation, same.generation);
  assertNotEquals(original.generation, valueChanged.generation);
  assertNotEquals(original.generation, labelChanged.generation);
});

Deno.test("subtree labels cover nesting deeper than the call stack", () => {
  // A label walk that recurses per level overflows well before this depth.
  const depth = 20_000;
  let chain: Record<string, unknown> = { title: "bottom" };
  const titlePath: string[] = ["chain"];
  for (let level = 0; level < depth; level++) chain = { next: chain };
  for (let level = 0; level < depth; level++) titlePath.push("next");
  titlePath.push("title");

  const tree = new FsTree();
  const annotator = makeAnnotator(tree, [
    { path: titlePath, label: TITLE_LABEL },
    { path: ["tag"], label: BODY_LABEL },
  ]);

  // The label of a leaf buried below the stack's depth reaches the root, and
  // joins with the labels of the leaves the walk reaches on its way.
  assertEquals(
    annotator.subtreeLabel({ chain, tag: "shallow" }, []).confidentiality,
    [...TITLE_LABEL.confidentiality, ...BODY_LABEL.confidentiality],
  );
});

Deno.test("an unlabeled leaf fails a deep subtree label closed", () => {
  const depth = 20_000;
  let chain: Record<string, unknown> = { title: "bottom" };
  for (let level = 0; level < depth; level++) chain = { next: chain };

  const tree = new FsTree();
  const annotator = makeAnnotator(tree, [{ path: ["tag"], label: BODY_LABEL }]);
  const label = annotator.subtreeLabel({ chain, tag: "shallow" }, []);

  assert(
    JSON.stringify(label).includes(CFC_FAIL_CLOSED_ATOM_CLASS),
    "an unlabeled leaf below the stack's depth must fail the join closed",
  );
  assertEquals(
    label.confidentiality?.slice(-1),
    BODY_LABEL.confidentiality,
  );
});

Deno.test("a value met twice fails its second subtree label closed", () => {
  const tree = new FsTree();
  const annotator = makeAnnotator(tree, [
    { path: ["first", "text"], label: TITLE_LABEL },
    { path: ["second", "text"], label: BODY_LABEL },
  ]);
  const shared = { text: "same" };

  const label = annotator.subtreeLabel({ first: shared, second: shared }, []);

  // The first visit walks into the object and picks up its leaf's label. The
  // second meets an object already seen, so it labels the whole of `second`
  // at once and fails closed rather than walking it again.
  assertEquals(label.confidentiality?.[0], TITLE_LABEL.confidentiality[0]);
  assert(
    JSON.stringify(label).includes(CFC_FAIL_CLOSED_ATOM_CLASS),
    "the repeated value must fail closed",
  );
  assertEquals(
    JSON.stringify(label).includes(JSON.stringify(BODY_LABEL.confidentiality)),
    false,
    "the repeated value must not pick up the label of the path it repeats at",
  );
});

Deno.test("an empty container takes the label of its own path", () => {
  const tree = new FsTree();
  const annotator = makeAnnotator(tree, [
    { path: ["items"], label: TITLE_LABEL },
    { path: ["meta"], label: BODY_LABEL },
  ]);

  // An empty array and an empty object have no leaves to contribute a label,
  // so each stands for itself.
  assertEquals(
    annotator.subtreeLabel([], ["items"]).confidentiality,
    TITLE_LABEL.confidentiality,
  );
  assertEquals(
    annotator.subtreeLabel({}, ["meta"]).confidentiality,
    BODY_LABEL.confidentiality,
  );
  assertEquals(
    annotator.subtreeLabel({ items: [], meta: {} }, []).confidentiality,
    [...TITLE_LABEL.confidentiality, ...BODY_LABEL.confidentiality],
  );
});
