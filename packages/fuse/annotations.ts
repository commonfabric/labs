import { encodeHex } from "@std/encoding/hex";

import { CFC_FUSE_ATOM_CLASS, cfcAtom } from "@commonfabric/api/cfc";
import { sha256 } from "@commonfabric/content-hash";
import { isLinkRef } from "@commonfabric/runner/shared";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import type { CallableKind } from "./callables.ts";

export type CfcProjectionKind =
  | "value"
  | "dir"
  | "aggregate-json"
  | "fs-projection"
  | "symlink"
  | "callable"
  | "piece-meta"
  | "pieces-manifest"
  | "space-meta"
  | "source";

export type CfcRootKind = "pieces" | "entities";
export type CfcCellKind = "input" | "result";
export type CfcPathSegment = string | number;

export type CfcLabel = {
  confidentiality?: unknown[];
  integrity?: unknown[];
};

export type CfcLabelView = {
  version: 1;
  entries: Array<{
    path: string[];
    label: CfcLabel;
  }>;
};

export type CfcProjectionRef = {
  type: "common-fabric-fuse-ref-v1";
  space: string;
  entity?: string;
  rootKind?: CfcRootKind;
  cell?: CfcCellKind;
  path: CfcPathSegment[];
  projection: CfcProjectionKind;
  generation: string;
};

export type CfcMetadataLabels = {
  type: CfcLabel;
  mode: CfcLabel;
  size: CfcLabel;
  mtime: CfcLabel;
  ctime: CfcLabel;
  generation: CfcLabel;
  uid: CfcLabel;
  gid: CfcLabel;
  nlink: CfcLabel;
  inode: CfcLabel;
};

export type CfcDirectoryEntryAnnotation = {
  name: string;
  nameDigest: string;
  childRef: CfcProjectionRef;
  kind: "file" | "dir" | "symlink" | "callable";
  nameLabel: CfcLabel;
  existenceLabel: CfcLabel;
  metadataLabels: CfcMetadataLabels;
};

export type CfcDirectoryEntriesAnnotation = {
  version: 1;
  entries: CfcDirectoryEntryAnnotation[];
};

export type CfcDerivedSlotsAnnotation = {
  version: 1;
  slots: [];
  status: "no-trusted-derived-slots";
};

export type CfcCallableAnnotation = {
  version: 1;
  callableKind: CallableKind;
  cell: CfcCellKind;
  key: string;
  descriptor: {
    contentLabel: CfcLabel;
    generation: string;
  };
  schemaLabel: CfcLabel;
  invocation: {
    boundary: "common-fabric-runtime";
    authority: "not-conveyed-by-file-bytes";
  };
};

export type CfcSymlinkAnnotation = {
  version: 1;
  target: string;
  linkTextLabel: CfcLabel;
  targetIdentityLabel: CfcLabel;
};

export type CfcIncompleteAnnotation = {
  reason: string;
  paths: string[];
};

export type CfcNodeAnnotation = {
  version: 1;
  ref: CfcProjectionRef;
  generation: string;
  contentLabel?: CfcLabel;
  metadataLabels: CfcMetadataLabels;
  namespaceLabel?: CfcLabel;
  entries?: CfcDirectoryEntriesAnnotation;
  derivedSlots: CfcDerivedSlotsAnnotation;
  callable?: CfcCallableAnnotation;
  symlink?: CfcSymlinkAnnotation;
  incomplete?: CfcIncompleteAnnotation;
};

export type CfcProjectionBase = {
  space: string;
  entity?: string;
  rootKind?: CfcRootKind;
  cell?: CfcCellKind;
  generation: string;
  labelView?: CfcLabelView;
};

export type CfcProjectionGenerationInput =
  & Omit<
    CfcProjectionBase,
    "generation"
  >
  & {
    value?: unknown;
    profileVersion?: string;
  };

export type CfcJsonAnnotationContext = {
  annotator: CfcProjectionAnnotator;
  path: CfcPathSegment[];
};

type AnnotatableNode = {
  kind: "file" | "dir" | "symlink" | "callable";
  cfc?: CfcNodeAnnotation;
};

type AnnotatableTree = {
  getNode(ino: bigint): AnnotatableNode | undefined;
  setCfcAnnotation(ino: bigint, annotation: CfcNodeAnnotation): void;
  setCfcEntryAnnotation(
    parentIno: bigint,
    name: string,
    entry: CfcDirectoryEntryAnnotation,
  ): void;
};

export const CFC_TRUSTED_XATTR_PREFIX = "trusted.cfc.";
export const CFC_COMPAT_XATTR_PREFIX = "user.commonfabric.cfc.";
export const CFC_FAIL_CLOSED_ATOM_CLASS =
  CFC_FUSE_ATOM_CLASS.ProjectionMetadataIncomplete;
export const CFC_FUSE_PROJECTION_PROFILE_VERSION =
  "common-fabric-fuse-projection-v1";

const encoder = new TextEncoder();

const CFC_PUBLIC_LABEL: CfcLabel = {};
const CFC_FAIL_CLOSED_LABEL: CfcLabel = {
  confidentiality: [
    cfcAtom.caveat(
      "metadata-incomplete",
      cfcAtom.resource(CFC_FAIL_CLOSED_ATOM_CLASS),
    ),
  ],
};
const CFC_TOPOLOGY_LABEL: CfcLabel = {
  confidentiality: [
    cfcAtom.resource(CFC_FUSE_ATOM_CLASS.TopologyObservation, undefined, {
      profile: "CfcGVisorSandboxProfile",
      kind: "inode-identity",
    }),
  ],
};

const emptyDerivedSlots = (): CfcDerivedSlotsAnnotation => ({
  version: 1,
  slots: [],
  status: "no-trusted-derived-slots",
});

function labelKeys(): Array<keyof CfcLabel> {
  return ["confidentiality", "integrity"];
}

function canonicalPath(path: readonly CfcPathSegment[]): string[] {
  return path.map(String);
}

function pathPointer(path: readonly CfcPathSegment[]): string {
  return "/" + canonicalPath(path).join("/");
}

export function canonicalCfcJsonStringify(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (!isObjectOrArray(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${
      value.map((entry) => canonicalCfcJsonStringify(entry)).join(",")
    }]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${
    keys.map((key) =>
      `${JSON.stringify(key)}:${canonicalCfcJsonStringify(record[key])}`
    )
      .join(",")
  }}`;
}

function stableStringify(value: unknown): string {
  return canonicalCfcJsonStringify(value);
}

function generationDigestValue(
  value: unknown,
  seen = new WeakMap<object, string>(),
  path: string[] = [],
): unknown {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return value;
    case "undefined":
      return {
        type: "common-fabric-projection-non-json-v1",
        kind: "undefined",
      };
    case "bigint":
      return {
        type: "common-fabric-projection-non-json-v1",
        kind: "bigint",
        value: value.toString(),
      };
    case "symbol":
      return {
        type: "common-fabric-projection-non-json-v1",
        kind: "symbol",
        description: value.description ?? null,
      };
    case "function":
      return {
        type: "common-fabric-projection-non-json-v1",
        kind: "function",
      };
    case "object":
      break;
  }

  const object = value as object;
  const existing = seen.get(object);
  if (existing !== undefined) {
    return {
      type: "common-fabric-projection-cycle-v1",
      path: existing,
    };
  }

  seen.set(object, pathPointer(path));
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        generationDigestValue(entry, seen, [...path, String(index)])
      );
    }

    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = generationDigestValue(record[key], seen, [...path, key]);
    }
    return out;
  } finally {
    seen.delete(object);
  }
}

function canonicalLabelView(
  labelView: CfcLabelView | undefined,
): CfcLabelView | undefined {
  if (!labelView) return undefined;
  return {
    version: 1,
    entries: [...labelView.entries].map((entry) => ({
      path: canonicalPath(entry.path),
      label: canonicalLabelForGeneration(entry.label),
    })).sort((left, right) =>
      pathPointer(left.path).localeCompare(pathPointer(right.path))
    ),
  };
}

export function deriveCfcProjectionGeneration(
  input: CfcProjectionGenerationInput,
): string {
  const digestInput = {
    type: "common-fabric-fuse-projection-generation-v1",
    profileVersion: input.profileVersion ??
      CFC_FUSE_PROJECTION_PROFILE_VERSION,
    annotationSchema: {
      refType: "common-fabric-fuse-ref-v1",
      nodeVersion: 1,
    },
    identity: {
      space: input.space,
      entity: input.entity,
      rootKind: input.rootKind,
      cell: input.cell,
    },
    value: generationDigestValue(input.value),
    cfcMetadata: input.labelView === undefined
      ? {
        status: "missing",
      }
      : {
        status: "present",
        labelView: canonicalLabelView(input.labelView),
      },
  };
  return `sha256:${
    encodeHex(sha256(encoder.encode(stableStringify(digestInput))))
  }`;
}

function cloneLabel(label: CfcLabel): CfcLabel {
  const cloned: CfcLabel = {};
  for (const key of labelKeys()) {
    const values = label[key];
    if (Array.isArray(values) && values.length > 0) {
      cloned[key] = [...values];
    }
  }
  return cloned;
}

function canonicalLabelForGeneration(label: CfcLabel): CfcLabel {
  const canonical: CfcLabel = {};
  for (const key of labelKeys()) {
    const values = label[key];
    if (!Array.isArray(values) || values.length === 0) continue;
    const byCanonical = new Map<string, unknown>();
    for (const value of values) {
      byCanonical.set(stableStringify(value), value);
    }
    canonical[key] = [...byCanonical.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => value);
  }
  return canonical;
}

/**
 * `joinLabels` over a list. Takes the labels as an array so that a join over
 * as many labels as a value has nodes stays within the argument limit.
 */
export function joinLabelList(
  labels: ReadonlyArray<CfcLabel | undefined>,
): CfcLabel {
  const joined: CfcLabel = {};
  for (const key of labelKeys()) {
    const seen = new Set<string>();
    const values: unknown[] = [];
    for (const label of labels) {
      const labelValues = label?.[key];
      if (!Array.isArray(labelValues)) continue;
      for (const value of labelValues) {
        const canonical = stableStringify(value);
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        values.push(value);
      }
    }
    if (values.length > 0) {
      joined[key] = values;
    }
  }
  return joined;
}

export function joinLabels(...labels: Array<CfcLabel | undefined>): CfcLabel {
  return joinLabelList(labels);
}

function failClosedLabel(): CfcLabel {
  return cloneLabel(CFC_FAIL_CLOSED_LABEL);
}

export function cfcFailClosedLabel(): CfcLabel {
  return failClosedLabel();
}

function labelWithFailClosed(label: CfcLabel | undefined): CfcLabel {
  return joinLabels(label, failClosedLabel());
}

function labelViewEntriesAt(
  labelView: CfcLabelView | undefined,
  path: readonly CfcPathSegment[],
): CfcLabel[] {
  if (!labelView) return [];
  const target = canonicalPath(path);
  return labelView.entries
    .filter((entry) =>
      entry.path.length === target.length &&
      entry.path.every((segment, index) => segment === target[index])
    )
    .map((entry) => cloneLabel(entry.label));
}

function isLeafValue(value: unknown): boolean {
  return !isObjectOrArray(value) || isLinkRef(value);
}

export function cfcDirectoryEntryKind(
  node: Pick<AnnotatableNode, "kind">,
): CfcDirectoryEntryAnnotation["kind"] {
  if (node.kind === "dir") return "dir";
  if (node.kind === "symlink") return "symlink";
  if (node.kind === "callable") return "callable";
  return "file";
}

function targetIdentityLabel(target: string): CfcLabel {
  return {
    confidentiality: [
      cfcAtom.resource(CFC_FUSE_ATOM_CLASS.SymlinkTarget, undefined, {
        target,
      }),
    ],
  };
}

function defaultMetadataLabels(contentLabel?: CfcLabel): CfcMetadataLabels {
  const content = contentLabel ?? failClosedLabel();
  return {
    type: content,
    mode: content,
    size: content,
    mtime: content,
    ctime: content,
    generation: content,
    uid: CFC_PUBLIC_LABEL,
    gid: CFC_PUBLIC_LABEL,
    nlink: CFC_TOPOLOGY_LABEL,
    inode: CFC_TOPOLOGY_LABEL,
  };
}

export function cfcDirectoryEntryNameDigest(name: string): string {
  // FNV-1a is used only as a deterministic placeholder for parent-local entry
  // keys in this first slice. It is explicitly not trusted-derived-name
  // evidence; derivedSlots remains empty unless a trusted source provides it.
  let hash = 0x811c9dc5;
  for (const byte of encoder.encode(name)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}

export class CfcProjectionAnnotator {
  readonly #tree: AnnotatableTree;
  readonly #base: CfcProjectionBase;

  constructor(
    tree: AnnotatableTree,
    base: CfcProjectionBase,
  ) {
    this.#tree = tree;
    this.#base = base;
  }

  jsonContext(path: CfcPathSegment[]): CfcJsonAnnotationContext {
    return { annotator: this, path: [...path] };
  }

  childContext(
    context: CfcJsonAnnotationContext,
    segment: CfcPathSegment,
  ): CfcJsonAnnotationContext {
    return { annotator: this, path: [...context.path, segment] };
  }

  ref(
    projection: CfcProjectionKind,
    path: readonly CfcPathSegment[],
    overrides: Partial<CfcProjectionRef> = {},
  ): CfcProjectionRef {
    const ref: CfcProjectionRef = {
      type: "common-fabric-fuse-ref-v1",
      space: this.#base.space,
      ...(this.#base.entity === undefined ? {} : { entity: this.#base.entity }),
      ...(this.#base.rootKind === undefined
        ? {}
        : { rootKind: this.#base.rootKind }),
      ...(this.#base.cell === undefined ? {} : { cell: this.#base.cell }),
      path: [...path],
      projection,
      generation: this.#base.generation,
    };
    for (
      const [key, value] of Object.entries(overrides) as Array<
        [keyof CfcProjectionRef, CfcProjectionRef[keyof CfcProjectionRef]]
      >
    ) {
      if (value === undefined) {
        delete ref[key];
      } else {
        ref[key] = value as never;
      }
    }
    return ref;
  }

  labelAt(path: readonly CfcPathSegment[]): CfcLabel {
    const labels = labelViewEntriesAt(this.#base.labelView, path);
    if (labels.length === 0) {
      return failClosedLabel();
    }
    return joinLabels(...labels);
  }

  /**
   * The label covering `value` and everything under it: the labels of its
   * leaves, joined. A value already met along the way contributes the
   * fail-closed label instead of being walked again.
   *
   * The walk holds its own stack of nodes still to visit rather than
   * recursing, so a value nests as deeply as it likes without reaching the
   * call stack's limit. Nodes come off that stack in the order a depth-first
   * walk reaches them, which is the order `joinLabelList` keeps.
   */
  subtreeLabel(
    value: unknown,
    path: readonly CfcPathSegment[],
    seen = new WeakSet<object>(),
  ): CfcLabel {
    interface PendingNode {
      value: unknown;
      path: readonly CfcPathSegment[];
    }
    const contributions: CfcLabel[] = [];
    const pending: PendingNode[] = [{ value, path }];

    while (pending.length > 0) {
      const node = pending.pop()!;

      if (isLeafValue(node.value)) {
        contributions.push(this.labelAt(node.path));
        continue;
      }

      if (isObjectOrArray(node.value)) {
        if (seen.has(node.value)) {
          contributions.push(labelWithFailClosed(this.labelAt(node.path)));
          continue;
        }
        seen.add(node.value);
      }

      // Children go on in reverse so the last one pushed — the first child —
      // is the next one taken.
      if (Array.isArray(node.value)) {
        if (node.value.length === 0) {
          contributions.push(this.labelAt(node.path));
          continue;
        }
        for (let index = node.value.length - 1; index >= 0; index--) {
          pending.push({
            value: node.value[index],
            path: [...node.path, index],
          });
        }
        continue;
      }

      // Everything left is a record: a leaf, a link ref and an array each
      // took an arm above.
      const entries = Object.entries(node.value as Record<string, unknown>);
      if (entries.length === 0) {
        contributions.push(this.labelAt(node.path));
        continue;
      }
      for (let index = entries.length - 1; index >= 0; index--) {
        const [key, entry] = entries[index];
        pending.push({ value: entry, path: [...node.path, key] });
      }
    }

    return contributions.length === 1
      ? contributions[0]
      : joinLabelList(contributions);
  }

  namespaceLabel(value: unknown, path: readonly CfcPathSegment[]): CfcLabel {
    if (Array.isArray(value)) {
      if (value.length === 0) return this.labelAt(path);
      return joinLabels(
        ...value.map((_entry, index) => this.labelAt([...path, index])),
      );
    }

    if (isObjectNotArray(value) && !isLinkRef(value)) {
      const keys = Object.keys(value);
      if (keys.length === 0) return this.labelAt(path);
      return joinLabels(...keys.map((key) => this.labelAt([...path, key])));
    }

    return this.labelAt(path);
  }

  annotateJsonScalar(
    ino: bigint,
    path: readonly CfcPathSegment[],
    value: unknown,
  ): void {
    const contentLabel = this.subtreeLabel(value, path);
    this.#setNodeAnnotation(ino, {
      ref: this.ref("value", path),
      contentLabel,
      metadataLabels: defaultMetadataLabels(contentLabel),
      incomplete: this.#incompleteIfFailClosed(contentLabel, path),
    });
  }

  annotateJsonDirectory(
    ino: bigint,
    path: readonly CfcPathSegment[],
    value: unknown,
  ): void {
    const namespaceLabel = this.namespaceLabel(value, path);
    this.#setNodeAnnotation(ino, {
      ref: this.ref("dir", path),
      namespaceLabel,
      entries: { version: 1, entries: [] },
      metadataLabels: defaultMetadataLabels(namespaceLabel),
      incomplete: this.#incompleteIfFailClosed(namespaceLabel, path),
    });
  }

  annotateJsonAggregate(
    ino: bigint,
    path: readonly CfcPathSegment[],
    value: unknown,
  ): void {
    const contentLabel = this.subtreeLabel(value, path);
    this.#setNodeAnnotation(ino, {
      ref: this.ref("aggregate-json", path),
      contentLabel,
      metadataLabels: defaultMetadataLabels(contentLabel),
      incomplete: this.#incompleteIfFailClosed(contentLabel, path),
    });
  }

  annotateJsonSymlink(
    ino: bigint,
    path: readonly CfcPathSegment[],
    target: string,
  ): void {
    const linkTextLabel = this.labelAt(path);
    const targetLabel = targetIdentityLabel(target);
    const contentLabel = joinLabels(linkTextLabel, targetLabel);
    this.#setNodeAnnotation(ino, {
      ref: this.ref("symlink", path),
      contentLabel,
      metadataLabels: defaultMetadataLabels(contentLabel),
      symlink: {
        version: 1,
        target,
        linkTextLabel,
        targetIdentityLabel: targetLabel,
      },
      incomplete: this.#incompleteIfFailClosed(contentLabel, path),
    });
  }

  annotateCallable(
    ino: bigint,
    path: readonly CfcPathSegment[],
    options: {
      callableKind: CallableKind;
      cellKey: string;
      cellProp: CfcCellKind;
      schemaLabel?: CfcLabel;
    },
  ): void {
    const schemaLabel = options.schemaLabel
      ? cloneLabel(options.schemaLabel)
      : CFC_PUBLIC_LABEL;
    const descriptorLabel = joinLabels(schemaLabel);
    this.#setNodeAnnotation(ino, {
      ref: this.ref("callable", path, { cell: options.cellProp }),
      contentLabel: descriptorLabel,
      metadataLabels: defaultMetadataLabels(descriptorLabel),
      callable: {
        version: 1,
        callableKind: options.callableKind,
        cell: options.cellProp,
        key: options.cellKey,
        descriptor: {
          contentLabel: descriptorLabel,
          generation: this.#base.generation,
        },
        schemaLabel,
        invocation: {
          boundary: "common-fabric-runtime",
          authority: "not-conveyed-by-file-bytes",
        },
      },
    });
  }

  annotateSynthetic(
    ino: bigint,
    options: {
      projection: CfcProjectionKind;
      path: readonly CfcPathSegment[];
      contentLabel?: CfcLabel;
      namespaceLabel?: CfcLabel;
      ref?: Partial<CfcProjectionRef>;
    },
  ): void {
    const contentLabel = options.contentLabel ?? failClosedLabel();
    this.#setNodeAnnotation(ino, {
      ref: this.ref(options.projection, options.path, options.ref),
      contentLabel,
      namespaceLabel: options.namespaceLabel,
      metadataLabels: defaultMetadataLabels(contentLabel),
      incomplete: this.#incompleteIfFailClosed(contentLabel, options.path),
    });
  }

  annotateEntry(
    parentIno: bigint,
    name: string,
    childIno: bigint,
    options: {
      labelPath?: readonly CfcPathSegment[];
      nameLabel?: CfcLabel;
      existenceLabel?: CfcLabel;
    } = {},
  ): void {
    const child = this.#tree.getNode(childIno);
    if (!child?.cfc) return;
    const labelPath = options.labelPath ?? child.cfc.ref.path;
    const defaultEntryLabel = this.labelAt(labelPath);
    this.#tree.setCfcEntryAnnotation(parentIno, name, {
      name,
      nameDigest: cfcDirectoryEntryNameDigest(name),
      childRef: child.cfc.ref,
      kind: cfcDirectoryEntryKind(child),
      nameLabel: options.nameLabel ?? defaultEntryLabel,
      existenceLabel: options.existenceLabel ?? defaultEntryLabel,
      metadataLabels: child.cfc.metadataLabels,
    });
  }

  #setNodeAnnotation(
    ino: bigint,
    annotation: Omit<
      CfcNodeAnnotation,
      "version" | "generation" | "derivedSlots"
    >,
  ): void {
    this.#tree.setCfcAnnotation(ino, {
      version: 1,
      generation: this.#base.generation,
      derivedSlots: emptyDerivedSlots(),
      ...annotation,
    });
  }

  #incompleteIfFailClosed(
    label: CfcLabel,
    path: readonly CfcPathSegment[],
  ): CfcIncompleteAnnotation | undefined {
    const canonicalFailClosed = stableStringify(CFC_FAIL_CLOSED_LABEL);
    const containsFailClosed = (label.confidentiality ?? []).some((entry) =>
      stableStringify({ confidentiality: [entry] }) === canonicalFailClosed ||
      stableStringify(entry).includes(CFC_FAIL_CLOSED_ATOM_CLASS)
    );
    return containsFailClosed
      ? {
        reason: "authoritative runner path-granular CFC metadata unavailable",
        paths: [pathPointer(path)],
      }
      : undefined;
  }
}

const CFC_XATTR_FIELDS = [
  "ref",
  "generation",
  "contentLabel",
  "metadataLabels",
  "namespaceLabel",
  "entries",
  "derivedSlots",
  "callable",
  "symlink",
] as const;

type CfcXattrField = typeof CFC_XATTR_FIELDS[number];

export type CfcXattrNamespace = "trusted" | "compat" | "both";

export type CfcXattrOptions = {
  enabled: boolean;
  namespace: CfcXattrNamespace;
};

type XattrTree = {
  getCfcAnnotation(ino: bigint): CfcNodeAnnotation | undefined;
};

function namespacePrefixes(namespace: CfcXattrNamespace): string[] {
  if (namespace === "trusted") return [CFC_TRUSTED_XATTR_PREFIX];
  if (namespace === "compat") return [CFC_COMPAT_XATTR_PREFIX];
  return [CFC_TRUSTED_XATTR_PREFIX, CFC_COMPAT_XATTR_PREFIX];
}

function fieldForXattrName(
  name: string,
  namespace: CfcXattrNamespace,
): CfcXattrField | null {
  for (const prefix of namespacePrefixes(namespace)) {
    if (!name.startsWith(prefix)) continue;
    const field = name.slice(prefix.length);
    if ((CFC_XATTR_FIELDS as readonly string[]).includes(field)) {
      return field as CfcXattrField;
    }
  }
  return null;
}

function annotationField(
  annotation: CfcNodeAnnotation,
  field: CfcXattrField,
): unknown {
  return annotation[field];
}

export function listCfcXattrNames(
  tree: XattrTree,
  ino: bigint,
  options: CfcXattrOptions,
): string[] {
  if (!options.enabled) return [];
  const annotation = tree.getCfcAnnotation(ino);
  if (!annotation) return [];

  const fields = CFC_XATTR_FIELDS.filter((field) =>
    annotationField(annotation, field) !== undefined
  );
  return namespacePrefixes(options.namespace).flatMap((prefix) =>
    fields.map((field) => `${prefix}${field}`)
  );
}

export function getCfcXattrValue(
  tree: XattrTree,
  ino: bigint,
  name: string,
  options: CfcXattrOptions,
): Uint8Array | null {
  if (!options.enabled) return null;
  const field = fieldForXattrName(name, options.namespace);
  if (field === null) return null;

  const annotation = tree.getCfcAnnotation(ino);
  if (!annotation) return null;

  const value = annotationField(annotation, field);
  if (value === undefined) return null;
  if (typeof value === "string") return encoder.encode(value);
  return encoder.encode(stableStringify(value));
}
