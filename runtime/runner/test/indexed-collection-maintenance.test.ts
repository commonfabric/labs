/**
 * Projects members into the rows an indexed collection stores, and compares
 * rows the way maintenance does before deciding whether to write them.
 */

import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import {
  defineIndexedCollections,
  indexedCollectionDescriptorOf,
  indexedKindOf,
} from "../src/builtins/indexed-collection/definition.ts";
import {
  type MemberRows,
  projectMember,
  sameMemberRows,
} from "../src/builtins/indexed-collection/maintenance.ts";
import { Runtime } from "../src/runtime.ts";

describe("projectMember() column values", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let space: `did:${string}:${string}`;

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase(
      `indexed-collection-maintenance-${crypto.randomUUID()}`,
    );
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Projects a member holding `value` in its one column, `flag`. */
  function project(value: FabricValue): MemberRows["values"] {
    const { tables, index } = defineIndexedCollections({
      items: { columns: { flag: "integer" } },
    });
    const declared = indexedCollectionDescriptorOf({
      id: "db",
      tables,
      index,
    })!;
    const { descriptor } = indexedKindOf(declared, "items");
    const tx = runtime.edit();
    try {
      const member = runtime.getCell(space, "member", undefined, tx);
      member.setRawUntyped({ flag: value });
      return projectMember(tx, "items", descriptor, member).values;
    } finally {
      tx.abort();
    }
  }

  it("reads a boolean as 1 or 0", () => {
    expect(project(true)).toEqual([1]);
    expect(project(false)).toEqual([0]);
  });

  it("keeps a string or a number as it is", () => {
    expect(project("true")).toEqual(["true"]);
    expect(project(0)).toEqual([0]);
  });

  it("reads anything else as null", () => {
    expect(project({ on: true })).toEqual([null]);
    expect(project([true])).toEqual([null]);
  });
});

describe("sameMemberRows()", () => {
  const rows: MemberRows = {
    kind: "items",
    member: "of:a",
    values: ["title", 1],
    relations: [["of:x", "of:y"], []],
    deps: ["of:a", "of:b"],
  };

  it("holds for rows whose references and deps differ only in order", () => {
    expect(
      sameMemberRows(rows, {
        ...rows,
        relations: [["of:y", "of:x"], []],
        deps: ["of:b", "of:a"],
      }),
    ).toBe(true);
  });

  it("does not hold for values in another order", () => {
    expect(sameMemberRows(rows, { ...rows, values: [1, "title"] })).toBe(
      false,
    );
  });

  it("does not hold for a changed value, reference, or dependency", () => {
    expect(sameMemberRows(rows, { ...rows, values: ["title", 2] })).toBe(
      false,
    );
    expect(
      sameMemberRows(rows, { ...rows, relations: [["of:x"], ["of:y"]] }),
    ).toBe(false);
    expect(
      sameMemberRows(rows, { ...rows, relations: [["of:x", "of:y"]] }),
    ).toBe(false);
    expect(sameMemberRows(rows, { ...rows, deps: ["of:a", "of:c"] })).toBe(
      false,
    );
  });
});
