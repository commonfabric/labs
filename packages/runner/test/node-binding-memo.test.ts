import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { NormalizedFullLink } from "../src/link-types.ts";
import {
  nodeBindingInputsWeight,
  NodeBindingMemo,
  type NodeBindingSubject,
} from "../src/node-binding-memo.ts";
import { ImmutableCellStore } from "../src/immutable-cell.ts";
import type { URI } from "../src/sigil-types.ts";
import { acquireSchemaRegistryLease } from "../src/schema-registry.ts";

const SPACE = "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi";

/** A link into the document `id` in `SPACE`, with `rest` over its defaults. */
function linkTo(
  id: string,
  rest: Partial<Pick<NormalizedFullLink, "path" | "scope" | "schema">> = {},
): NormalizedFullLink {
  return {
    space: SPACE,
    id: `of:${id}`,
    path: rest.path ?? [],
    scope: rest.scope ?? "space",
    ...(rest.schema !== undefined && { schema: rest.schema }),
  };
}

/** A subject over fresh node and pattern objects, with `overrides` applied. */
function subject(
  overrides: Partial<NodeBindingSubject> = {},
): NodeBindingSubject {
  return {
    node: {},
    pattern: {},
    resultLink: linkTo("result"),
    argumentLink: linkTo("argument"),
    variant: "javascript",
    ...overrides,
  };
}

/** A memo of numbers wide enough that no case here reaches a bound. */
function memo(): NodeBindingMemo<{ n: number }> {
  return new NodeBindingMemo({ capacity: 100, maxWeight: 1_000_000 });
}

describe("node-binding-memo", () => {
  describe("bindingFor()", () => {
    it("evicts native inputs by payload weight despite their compact identifiers", () => {
      const store = new ImmutableCellStore();
      try {
        const first = store.create({ payload: "a".repeat(10_000) });
        const second = store.create({ payload: "b".repeat(10_000) });
        const bindings = new NodeBindingMemo<URI>({
          capacity: 100,
          maxWeight: 30_000,
          weigh: nodeBindingInputsWeight,
        });
        const a = subject();
        const b = subject();
        bindings.bindingFor(a, () => first.id);
        bindings.bindingFor(b, () => second.id);
        expect(first.id.length + second.id.length).toBeLessThan(300);
        expect(bindings.size).toBe(1);
        expect(bindings.bindingFor(a, () => "of:evicted")).toBe("of:evicted");
        expect(bindings.bindingFor(b, () => "of:missing")).toBe(second.id);
      } finally {
        store.dispose();
      }
    });

    it("returns the binding it holds for a subject it has bound", () => {
      const bindings = memo();
      const bound = subject();
      const first = bindings.bindingFor(bound, () => ({ n: 1 }));
      const second = bindings.bindingFor({ ...bound }, () => ({ n: 2 }));

      expect(second).toBe(first);
      expect(bindings.size).toBe(1);
    });

    it("returns the held binding for links equal in address and schema content", () => {
      const bindings = memo();
      const node = {};
      const pattern = {};
      const schema = () => ({ type: "object", properties: { a: {} } }) as const;
      const first = bindings.bindingFor(
        subject({
          node,
          pattern,
          resultLink: linkTo("result", { schema: schema() }),
          argumentLink: linkTo("argument"),
        }),
        () => ({ n: 1 }),
      );
      const second = bindings.bindingFor(
        subject({
          node,
          pattern,
          resultLink: linkTo("result", { schema: schema() }),
          argumentLink: linkTo("argument"),
        }),
        () => ({ n: 2 }),
      );

      expect(second).toBe(first);
    });

    it("returns the held binding for a pattern named by one content identity and a node by its position", () => {
      // Two pattern objects of one content identity hold the same nodes at
      // the same positions, so a subject naming the pattern by that
      // identity and the node by its position reaches one binding from
      // either object.
      const bindings = memo();
      const first = bindings.bindingFor(
        subject({ node: 2, pattern: "fid1:tree\0default" }),
        () => ({ n: 1 }),
      );
      const second = bindings.bindingFor(
        subject({ node: 2, pattern: "fid1:tree\0default" }),
        () => ({ n: 2 }),
      );

      expect(second).toBe(first);
      expect(bindings.size).toBe(1);
    });

    it("computes a binding for a node position apart from one for an object", () => {
      // A position and an object standing for a node never share a key,
      // whatever number the memo gives the object.
      const bindings = memo();
      const node = {};
      bindings.bindingFor(subject({ node }), () => ({ n: 1 }));

      expect(bindings.bindingFor(subject({ node: 0 }), () => ({ n: 2 })).n)
        .toBe(2);
      expect(bindings.size).toBe(2);
    });

    describe("binds again for a subject that differs", () => {
      // Each case binds one subject, then a second that differs from it in
      // the one member named, and reads what the second call returns.

      const base = subject();
      const cases: [string, Partial<NodeBindingSubject>][] = [
        ["node", { node: {} }],
        ["node position", { node: 1 }],
        ["pattern", { pattern: {} }],
        ["pattern identity", { pattern: "fid1:other\0default" }],
        ["implementation", { implementation: {} }],
        ["implementation identity", { implementation: "fid1:child\0row" }],
        ["variant", { variant: "raw:map" }],
        ["result document", { resultLink: linkTo("other") }],
        ["result path", { resultLink: linkTo("result", { path: ["a"] }) }],
        ["result scope", { resultLink: linkTo("result", { scope: "user" }) }],
        [
          "result schema",
          { resultLink: linkTo("result", { schema: { type: "string" } }) },
        ],
        ["argument document", { argumentLink: linkTo("other") }],
        [
          "argument schema",
          { argumentLink: linkTo("argument", { schema: { type: "number" } }) },
        ],
        ["argument presence", { argumentLink: undefined }],
      ];
      for (const [member, difference] of cases) {
        it(`computes a second binding when the ${member} differs`, () => {
          const bindings = memo();
          const first = bindings.bindingFor(base, () => ({ n: 1 }));
          const second = bindings.bindingFor(
            { ...base, ...difference },
            () => ({ n: 2 }),
          );

          expect(first.n).toBe(1);
          expect(second.n).toBe(2);
          expect(bindings.size).toBe(2);
        });
      }
    });

    it("computes a path's binding apart from that of a document id holding the path's characters", () => {
      // A key built by joining members with a separator would hold these two
      // under one entry.

      const bindings = memo();
      const node = {};
      const pattern = {};
      const first = bindings.bindingFor(
        subject({ node, pattern, resultLink: linkTo("a", { path: ["b"] }) }),
        () => ({ n: 1 }),
      );
      const second = bindings.bindingFor(
        subject({ node, pattern, resultLink: linkTo('a",["b') }),
        () => ({ n: 2 }),
      );

      expect(first.n).toBe(1);
      expect(second.n).toBe(2);
    });

    it("holds nothing for a subject whose bind throws", () => {
      const bindings = memo();
      const bound = subject();
      const failure = new Error("cannot bind");

      expect(() =>
        bindings.bindingFor(bound, () => {
          throw failure;
        })
      ).toThrow(failure);
      expect(bindings.size).toBe(0);
      expect(bindings.bindingFor(bound, () => ({ n: 3 })).n).toBe(3);
    });

    it("binds again once the schema registry has cleared", () => {
      const bindings = memo();
      const bound = subject();
      const first = bindings.bindingFor(bound, () => ({ n: 1 }));
      // The last lease out clears the registry, which starts a new epoch.
      acquireSchemaRegistryLease()();
      const second = bindings.bindingFor(bound, () => ({ n: 2 }));

      expect(first.n).toBe(1);
      expect(second.n).toBe(2);
      expect(bindings.size).toBe(1);
    });

    it("drops the least recently used binding past its capacity", () => {
      const bindings = new NodeBindingMemo<{ n: number }>({
        capacity: 2,
        maxWeight: 1_000_000,
      });
      const [a, b, c] = [subject(), subject(), subject()];
      bindings.bindingFor(a, () => ({ n: 1 }));
      bindings.bindingFor(b, () => ({ n: 2 }));
      // A use of `a` leaves `b` the least recently used.
      bindings.bindingFor(a, () => ({ n: 10 }));
      bindings.bindingFor(c, () => ({ n: 3 }));

      expect(bindings.size).toBe(2);
      expect(bindings.bindingFor(a, () => ({ n: 11 })).n).toBe(1);
      expect(bindings.bindingFor(b, () => ({ n: 12 })).n).toBe(12);
    });

    it("drops bindings past the weight its `weigh` reports", () => {
      const bindings = new NodeBindingMemo<{ n: number }>({
        capacity: 100,
        maxWeight: 2_000,
        weigh: (binding) => binding.n,
      });
      const [a, b] = [subject(), subject()];
      bindings.bindingFor(a, () => ({ n: 1_500 }));
      bindings.bindingFor(b, () => ({ n: 1_500 }));

      expect(bindings.size).toBe(1);
      expect(bindings.bindingFor(b, () => ({ n: 7 })).n).toBe(1_500);
    });
  });

  describe("clear()", () => {
    it("drops every binding held", () => {
      const bindings = memo();
      const bound = subject();
      bindings.bindingFor(bound, () => ({ n: 1 }));
      bindings.clear();

      expect(bindings.size).toBe(0);
      expect(bindings.bindingFor(bound, () => ({ n: 2 })).n).toBe(2);
    });
  });
});
