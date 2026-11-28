import { expect } from "@std/expect";

import type { MergeablePushMisuseKind } from "../../src/policy/mod.ts";
import { collectMergeablePushMisuses } from "../first-callback.ts";
import { describe, it } from "@commonfabric/test-support/test";

function classifyPushes(source: string): MergeablePushMisuseKind[] {
  return collectMergeablePushMisuses(source).map(({ kind }) => kind);
}

describe("mergeable-push-classification", () => {
  it("leaves a push read-independent when the read's name appears only as a member or binding name", () => {
    // Every `existing` in the pushed value names a property, a member, a
    // method, or a parameter; none refers to the read.
    expect(
      classifyPushes(
        `const fn = (input) => {
            const existing = input.key("users").get();
            input.key("users").push({
              existing: input.existing,
              existing() { return 1; },
              pick: (existing) => 0,
            });
          };`,
      ),
    ).toEqual([]);

    expect(
      classifyPushes(
        `const fn = (input) => {
            const existing = input.key("users").get();
            input.key("users").push({ name: "a", after: existing });
          };`,
      ),
    ).toEqual(["read-dependent-push"]);
  });

  it("reports a push guarded by a check on an alias of the collection as read-dependent", () => {
    expect(
      classifyPushes(
        `const fn = (input) => {
            const users = input.key("users");
            const snapshot = users.get();
            if (isFull(users)) return;
            users.push({ name: "a" });
          };`,
      ),
    ).toEqual(["read-dependent-push"]);

    expect(
      classifyPushes(
        `const fn = (input) => {
            const users = input.key("users");
            const snapshot = users.get();
            if (isFull(input.key("log"))) return;
            users.push({ name: "a" });
          };`,
      ),
    ).toEqual([]);
  });

  it("reports a push in either branch of an if on the read as read-dependent", () => {
    expect(
      classifyPushes(
        `const fn = (input) => {
            const existing = input.key("users").get();
            if (existing.length > 3) input.key("users").push({ name: "a" });
          };`,
      ),
    ).toEqual(["read-dependent-push"]);

    expect(
      classifyPushes(
        `const fn = (input) => {
            const existing = input.key("users").get();
            if (existing.length > 3) {
              report(input.key("log").get());
            } else {
              input.key("users").push({ name: "a" });
            }
          };`,
      ),
    ).toEqual(["read-dependent-push"]);

    expect(
      classifyPushes(
        `const fn = (input) => {
            const existing = input.key("users").get();
            if (input.key("enabled").get()) input.key("users").push({ name: "a" });
          };`,
      ),
    ).toEqual([]);
  });
});
