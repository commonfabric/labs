/**
 * The negative calls in this file are checked by `deno task check`; the
 * runner's test task disables type checking. The exported assertion functions
 * are never called. Runtime cases cover accepted paths and the conversion that
 * removes the document's outer `value` segment.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type DocumentPath,
  type NonDocumentPath,
  toDocumentPath,
  toValuePath,
  type ValuePath,
} from "@commonfabric/memory/v2";

import {
  canonicalizeDocumentPath,
  canonicalizeLogicalPath,
  cfcRecordPath,
  logicalPathToPointer,
} from "../../src/cfc/canonical.ts";
import { ConsumedLabelIndex } from "../../src/cfc/consumed-label-index.ts";
import {
  canonicalizeCfcLogicalPath,
  cfcLabelViewPathKey,
  rebaseCfcLabelView,
} from "../../src/cfc/label-view-core.ts";
import { cfcLabelViewFromMetadata } from "../../src/cfc/label-view-state.ts";
import type { NormalizedFullLink } from "../../src/link-types.ts";
import type {
  Activity,
  IExtendedStorageTransaction,
  IReadActivity,
  IWriteAttempt,
  TransactionWriteDetail,
} from "../../src/storage/interface.ts";

/** Fails to compile if a logical API accepts a document-rooted path. */
export function documentPathsAreRejectedByLogicalApis(
  path: DocumentPath,
  index: ConsumedLabelIndex,
): void {
  // @ts-expect-error document paths require conversion to logical form
  canonicalizeLogicalPath(path);
  // @ts-expect-error pointer keys name logical paths
  logicalPathToPointer(path);
  // @ts-expect-error label-index queries name logical paths
  index.overlapping(path);
  // @ts-expect-error label-view paths are relative to their payload
  canonicalizeCfcLogicalPath(path);
  // @ts-expect-error label-view keys name logical paths
  cfcLabelViewPathKey(path);
  // @ts-expect-error rebasing requires a logical path
  rebaseCfcLabelView(undefined, path);
  // @ts-expect-error metadata lookup requires a logical path
  cfcLabelViewFromMetadata(undefined, path);
}

/** Fails to compile if document conversion accepts an unbranded or value path. */
export function documentConversionRequiresDocumentForm(
  plain: readonly string[],
  value: ValuePath,
): void {
  // @ts-expect-error an unbranded path has no declared document root
  canonicalizeDocumentPath(plain);
  // @ts-expect-error a value path has already left the document root
  canonicalizeDocumentPath(value);
}

/** Fails to compile if a journal address loses its document-path brand. */
export function journalPathsRetainDocumentForm(
  read: IReadActivity,
  attempt: IWriteAttempt,
  detail: TransactionWriteDetail,
  activity: Activity,
): void {
  canonicalizeDocumentPath(read.path);
  canonicalizeDocumentPath(attempt.path);
  canonicalizeDocumentPath(detail.address.path);
  if (activity.write !== undefined) {
    canonicalizeDocumentPath(activity.write.path);
  }
}

/** Fails to compile if a payload API accepts a journal address's path. */
export function journalPathsAreRejectedByPayloadApis(
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  read: IReadActivity,
  detail: TransactionWriteDetail,
): void {
  // @ts-expect-error the payload read prepends `value` to a link's path
  tx.readValueOrThrow({ ...link, path: read.path });
  // @ts-expect-error the payload write prepends `value` to a link's path
  tx.writeValueOrThrow({ ...link, path: detail.address.path }, 1);
}

describe("path-forms", () => {
  it("accepts plain and branded value paths at logical APIs", () => {
    const plain: readonly string[] = ["value", "field"];
    const value = toValuePath(["value", "field"]);
    const paths: NonDocumentPath[] = [plain, value];
    const index = new ConsumedLabelIndex([]);

    for (const path of paths) {
      const canonical: ValuePath = canonicalizeLogicalPath(path);
      expect(canonical).toEqual(["value", "field"]);
      expect(logicalPathToPointer(path)).toBe("/value/field");
      expect(index.overlapping(path)).toEqual([]);
      expect(canonicalizeCfcLogicalPath(path)).toEqual(["value", "field"]);
      expect(cfcLabelViewPathKey(path)).toBe("/value/field");
      expect(rebaseCfcLabelView(undefined, path)).toBeUndefined();
      expect(cfcLabelViewFromMetadata(undefined, path)).toBeUndefined();
    }
  });

  it("converts a document path once and preserves a payload field named `value`", () => {
    const document = toDocumentPath(["value", "value", "field"]);
    const logical = canonicalizeDocumentPath(document);
    expect(logical).toEqual(["value", "field"]);
    const canonical: ValuePath = canonicalizeLogicalPath(logical!);

    expect(canonical).toEqual(["value", "field"]);
    expect(logicalPathToPointer(canonical)).toBe("/value/field");
    expect(Object.isFrozen(logical)).toBe(true);
    expect(document).toEqual(["value", "value", "field"]);
  });

  it("returns the payload root for the document root", () => {
    expect(canonicalizeDocumentPath(toDocumentPath([]))).toEqual([]);
  });

  it("returns no payload path for one of the document's own members", () => {
    expect(canonicalizeDocumentPath(toDocumentPath(["source"])))
      .toBeUndefined();
    expect(canonicalizeDocumentPath(toDocumentPath(["slug"])))
      .toBeUndefined();
    expect(canonicalizeDocumentPath(toDocumentPath(["cfc", "labels"])))
      .toBeUndefined();
  });

  it("records a payload path as `path` and a member's path as `metaPath`", () => {
    expect(cfcRecordPath(toDocumentPath(["value", "slug"]))).toEqual({
      path: ["slug"],
    });
    expect(cfcRecordPath(toDocumentPath(["slug"]))).toEqual({
      metaPath: ["slug"],
    });
  });

  it("records a frozen member path as it stands", () => {
    const meta = toDocumentPath(Object.freeze(["cfc", "labels"]));
    const record = cfcRecordPath(meta);

    expect("metaPath" in record && record.metaPath).toBe(meta);
  });
});
