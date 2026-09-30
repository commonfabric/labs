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
  logicalPathToPointer,
} from "../../src/cfc/canonical.ts";
import { ConsumedLabelIndex } from "../../src/cfc/consumed-label-index.ts";
import {
  canonicalizeCfcLogicalPath,
  cfcLabelViewPathKey,
  rebaseCfcLabelView,
} from "../../src/cfc/label-view-core.ts";
import { cfcLabelViewFromMetadata } from "../../src/cfc/label-view-state.ts";
import type {
  Activity,
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
    const logical: ValuePath = canonicalizeDocumentPath(document);
    const canonical: ValuePath = canonicalizeLogicalPath(logical);

    expect(logical).toEqual(["value", "field"]);
    expect(canonical).toEqual(["value", "field"]);
    expect(logicalPathToPointer(canonical)).toBe("/value/field");
    expect(Object.isFrozen(logical)).toBe(true);
    expect(document).toEqual(["value", "value", "field"]);
  });
});
