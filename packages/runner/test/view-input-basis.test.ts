import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { deepFreeze } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import {
  componentReadSchema,
  ProfileBadgeSchema,
} from "../src/component-read-contract.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler/types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  viewInputBasis,
  ViewInputBasisCache,
  viewInputFingerprint,
} from "../src/view-input-basis.ts";

const signer = await Identity.fromPassphrase("view input basis");
const space = signer.did();

describe("view input basis", () => {
  it("rechecks mutable values and path reachability when reusing fingerprints", () => {
    const cache = new ViewInputBasisCache();
    const mutable = { nested: { count: 1 } };
    const shallow = Object.freeze(mutable);
    const document = { value: shallow };
    const basis = viewInputBasis([{
      space,
      id: "of:cache",
      type: "application/json",
      path: ["value"],
    }], () => document)[0];
    expect(cache.matches(document, basis)).toBe(true);
    shallow.nested.count = 2;
    expect(cache.matches(document, basis)).toBe(false);

    const absent = {
      id: "of:cache",
      scope: "space" as const,
      path: ["value", "nested", "missing"],
      fingerprint: viewInputFingerprint({ value: {} }, [
        "value",
        "nested",
        "missing",
      ]),
    };
    expect(cache.matches({ value: {} }, absent)).toBe(true);
    expect(cache.matches({ value: { nested: {} } }, absent)).toBe(false);
    expect(cache.matches({ value: {} }, absent)).toBe(true);
  });

  it("rechecks changed primitives and replacement frozen values", () => {
    const cache = new ViewInputBasisCache();
    for (const value of [0, "text", Object.freeze({ count: 1 })]) {
      const document = { value };
      const basis = {
        id: "of:cache",
        scope: "space" as const,
        path: ["value"],
        fingerprint: viewInputFingerprint(document, ["value"]),
      };
      expect(cache.matches(document, basis)).toBe(true);
      expect(cache.matches(document, basis)).toBe(true);
      expect(
        cache.matches(
          { value: typeof value === "number" ? -0 : undefined },
          basis,
        ),
      )
        .toBe(false);
      expect(cache.matches(document, basis)).toBe(true);
      expect(cache.matches({ value: Object.freeze({ count: 2 }) }, basis)).toBe(
        false,
      );
    }
  });

  it("observes nothing again when a basis is checked over the deep-frozen document it was last observed in", () => {
    const cache = new ViewInputBasisCache();
    const nested = deepFreeze({ count: 1 });
    let observedAgain = false;
    let armed = false;
    const value = Object.defineProperty({}, "nested", {
      enumerable: true,
      get: () => {
        if (armed) observedAgain = true;
        return nested;
      },
    });
    const document = deepFreeze({ value });
    const basis = viewInputBasis([{
      space,
      id: "of:cache",
      type: "application/json",
      path: ["value", "nested"],
    }], () => document)[0];
    expect(cache.matches(document, basis)).toBe(true);
    armed = true;
    expect(cache.matches(document, basis)).toBe(true);
    expect(observedAgain).toBe(false);
  });

  it("observes again a frozen document whose interior is not frozen", () => {
    const cache = new ViewInputBasisCache();
    const interior = { count: 1 };
    const document = Object.freeze({ value: interior });
    const basis = viewInputBasis([{
      space,
      id: "of:cache",
      type: "application/json",
      path: ["value", "count"],
    }], () => document)[0];
    expect(cache.matches(document, basis)).toBe(true);
    interior.count = 2;
    expect(cache.matches(document, basis)).toBe(false);
  });

  it("observes another document version afresh, matching an equal value and refusing a changed one", () => {
    const cache = new ViewInputBasisCache();
    const first = deepFreeze({ value: { nested: { count: 1 } } });
    const basis = viewInputBasis([{
      space,
      id: "of:cache",
      type: "application/json",
      path: ["value", "nested"],
    }], () => first)[0];
    expect(cache.matches(first, basis)).toBe(true);
    expect(cache.matches(first, basis)).toBe(true);
    const changed = deepFreeze({ value: { nested: { count: 2 } } });
    expect(cache.matches(changed, basis)).toBe(false);
    expect(cache.matches(changed, basis)).toBe(false);
    expect(cache.matches(first, basis)).toBe(true);
    // An equal value in another document version matches as well.
    expect(
      cache.matches(deepFreeze({ value: { nested: { count: 1 } } }), basis),
    )
      .toBe(true);
  });

  it("retains the same currency checks after compacting ancestor reads", () => {
    const reads = [
      ["value", "nested"],
      ["value", "nested", "child"],
      ["value", "nested", "missing"],
      ["value", "nested", "child"],
      ["value", "sibling"],
    ].map((path) => ({
      space,
      id: "of:basis" as const,
      type: "application/json" as const,
      path,
    }));
    const initial = { value: { nested: { child: 1 }, sibling: 2 } };
    const basis = viewInputBasis(reads, () => initial);
    expect(basis.map((read) => read.path)).toEqual([
      ["value", "nested"],
      ["value", "sibling"],
    ]);
    for (
      const next of [
        initial,
        { value: { nested: { child: 2 }, sibling: 2 } },
        { value: { nested: { child: 1, missing: undefined }, sibling: 2 } },
        { value: { nested: { child: 1 }, sibling: 3 } },
        { value: { nested: { child: 1 }, sibling: 2, unrelated: 4 } },
        { value: { sibling: 2 } },
        undefined,
      ]
    ) {
      expect(
        basis.every((read) =>
          viewInputFingerprint(next, read.path) === read.fingerprint
        ),
      ).toBe(reads.every((read) =>
        viewInputFingerprint(next, read.path) ===
          viewInputFingerprint(initial, read.path)
      ));
    }
    expect(viewInputBasis([
      { ...reads[0], scope: "user" },
      { ...reads[1], scope: "session" },
    ], () => initial)).toHaveLength(2);
  });
  it("distinguishes a missing path that has gained a reachable ancestor", () => {
    const path = ["value", "nested", "missing"];
    expect(viewInputFingerprint({ value: {} }, path)).not.toBe(
      viewInputFingerprint({ value: { nested: {} } }, path),
    );
    expect(
      viewInputFingerprint({ value: { input: 1, sibling: 2 } }, [
        "value",
        "input",
      ]),
    ).toBe(
      viewInputFingerprint({ value: { input: 1, sibling: 3 } }, [
        "value",
        "input",
      ]),
    );
  });

  it("matches explicit component projections and controller schema precedence", () => {
    const supplied = { type: "object", properties: {} } as const;
    expect(componentReadSchema("cf-profile-badge", "profile", supplied, {}))
      .toBe(ProfileBadgeSchema);
    expect(componentReadSchema("cf-input", "value", supplied, {})).toBe(
      supplied,
    );
    expect(componentReadSchema("cf-input", "value", false, {})).toEqual({
      type: "string",
    });
    expect(componentReadSchema("cf-map", "zoom", false, {})).toBe(false);
    expect(
      componentReadSchema("cf-autocomplete", "value", undefined, {
        multiple: true,
      }),
    ).toEqual({ type: "array", items: { type: "string" } });
  });

  it("revokes successful producer evidence after a body throws undefined", async () => {
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    let cancel: (() => void) | undefined;
    try {
      runtime.scheduler.setViewConsumers(space, [runtime.scopeKeyIdentity]);
      const input = runtime.getCell<number>(space, "input", undefined);
      const output = runtime.getCell<number>(space, "output", undefined);
      await runtime.editWithRetry((tx) => input.withTx(tx).set(3));
      let fail = false;
      const action = Object.assign((tx: Parameters<Action>[0]) => {
        const value = input.withTx(tx).get();
        if (fail) throw undefined;
        output.withTx(tx).set(value * 2);
      }, {
        viewNodeId: "producer",
        viewPiece: output.getAsNormalizedFullLink(),
        module: { type: "javascript", implementation: () => {} },
      }) as Action;
      const commits: Promise<unknown>[] = [];
      const original = runtime.scheduler.recordViewActionOutcome.bind(
        runtime.scheduler,
      );
      const observations = stub(
        runtime.scheduler,
        "recordViewActionOutcome",
        (...args) => {
          original(...args);
          commits.push(args[4]);
        },
      );
      cancel = runtime.scheduler.subscribe(action, { isEffect: true });
      await runtime.idle();
      await storage.synced();
      await output.pull();
      await Promise.all(commits.splice(0));
      expect(output.get()).toBe(6);
      const successful = runtime.scheduler.viewExecutionNodes(
        space,
        runtime.scopeKeyIdentity,
      )[0]!;
      expect(successful.current).toBe(true);
      expect(
        runtime.scheduler.viewExecutionNodes(space, runtime.scopeKeyIdentity)[0]
          ?.log,
      )
        .toBe(successful.log);
      fail = true;
      await runtime.editWithRetry((tx) => input.withTx(tx).set(4));
      await runtime.idle();
      await storage.synced();
      await output.pull();
      await Promise.all(commits.splice(0));
      expect(output.get()).toBe(6);
      const failed = runtime.scheduler.viewExecutionNodes(
        space,
        runtime.scopeKeyIdentity,
      )[0]!;
      expect(failed.current).toBe(false);
      expect(failed.log).not.toBe(successful.log);
      expect(successful.current).toBe(true);
      observations.restore();
    } finally {
      cancel?.();
      await runtime.dispose({ closeStorage: false });
      await storage.close();
    }
  });
});
