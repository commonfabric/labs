import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { deepFreeze } from "@commonfabric/data-model";
import type { MemorySpace } from "@commonfabric/memory/interface";

import { preparedDigestFor } from "../../src/cfc/canonical.ts";
import type { PreparedDigestInput } from "../../src/cfc/types.ts";

const space: MemorySpace = "did:key:digest-test";
const address = (id: string, path: string[] = []) => ({
  space,
  scope: "space" as const,
  id: `of:${id}`,
  path,
});
const empty = (): PreparedDigestInput => ({
  consumedReads: [],
  attemptedWrites: [],
  writes: [],
  writeAttemptLog: [],
  triggerReads: [],
  dereferenceTraces: [],
  writePolicyInputs: [],
});

describe("preparedDigestFor()", () => {
  it("observes nested mutation beneath a shallow-frozen record", () => {
    const value = { text: "first" };
    const policy = Object.freeze({ kind: "custom" as const, name: "p", value });
    const input = { ...empty(), writePolicyInputs: [policy] };
    const digest = preparedDigestFor(input);
    value.text = "second";
    expect(preparedDigestFor(input)).not.toBe(digest);
    expect(Object.isFrozen(value)).toBe(false);
  });

  it("preserves canonical paths, trace set semantics, and policy multiplicity", () => {
    const policy = deepFreeze({
      kind: "custom" as const,
      name: "p",
      target: address("write", ["nested"]),
      value: "payload",
    });
    const trace = deepFreeze({
      source: address("source", ["link"]),
      target: address("target"),
      kind: "value" as const,
    });
    const input = {
      ...empty(),
      writePolicyInputs: [policy],
      dereferenceTraces: [trace],
    };
    const digest = preparedDigestFor(input);
    expect(preparedDigestFor({
      ...input,
      writePolicyInputs: [{ ...policy, target: address("write", ["nested"]) }],
      dereferenceTraces: [trace, {
        ...trace,
        source: address("source", ["link"]),
      }],
    })).toBe(digest);
    // A leading `value` names a payload field of that name, a different path.
    expect(preparedDigestFor({
      ...input,
      writePolicyInputs: [{
        ...policy,
        target: address("write", ["value", "nested"]),
      }],
    })).not.toBe(digest);
    expect(preparedDigestFor({
      ...input,
      dereferenceTraces: [{
        ...trace,
        source: address("source", ["value", "link"]),
      }],
    })).not.toBe(digest);
    expect(preparedDigestFor({ ...input, writePolicyInputs: [policy, policy] }))
      .not.toBe(digest);
  });
});
