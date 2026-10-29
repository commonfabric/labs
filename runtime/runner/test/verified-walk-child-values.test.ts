import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { verifiedWalkChildValues } from "../src/harness/executable-registry.ts";

// The verified-value walks (recordVerifiedFunctions / annotateVerifiedPatterns /
// collectAssociatedFunctions) recurse through `verifiedWalkChildValues`, which
// has to handle both export shapes it can meet. A plain CommonJS exports object
// carries data properties; a SES module namespace carries *live-binding
// accessors* (no `value`). The walk must follow those accessors, otherwise
// verified functions and their binding metadata
// (`__cfVerifiedBindingIdentity`) are never registered, leaving the writer's
// verified binding identity unresolved and breaking CFC `writeAuthorizedBy` for
// trusted-action writes.

const collect = (
  value: object,
): unknown[] => [...verifiedWalkChildValues(value)];

describe("verifiedWalkChildValues()", () => {
  it("yields data property values (plain CommonJS export shape)", () => {
    const fn = () => {};
    const exportsObj = { a: fn, b: 7, c: { nested: true } };
    const yielded = collect(exportsObj);
    expect(yielded).toContain(fn);
    expect(yielded).toContain(7);
    expect(yielded.length).toBe(3);
  });

  it("follows live-binding accessors on module namespaces (ESM export shape)", () => {
    const handler = () => {};
    // Mimic a SES module namespace: tagged `[object Module]` with exports
    // exposed as getters (live bindings) rather than data properties.
    const ns: Record<PropertyKey, unknown> = {};
    Object.defineProperty(ns, Symbol.toStringTag, {
      value: "Module",
      configurable: false,
    });
    Object.defineProperty(ns, "commit", {
      get: () => handler,
      enumerable: true,
    });
    Object.defineProperty(ns, "__esModule", {
      get: () => true,
      enumerable: true,
    });

    expect(Object.prototype.toString.call(ns)).toBe("[object Module]");
    const yielded = collect(ns);
    expect(yielded).toContain(handler);
  });

  it("does NOT invoke getters on ordinary (non-module) objects", () => {
    let invoked = false;
    const obj = {};
    Object.defineProperty(obj, "trap", {
      get: () => {
        invoked = true;
        return {};
      },
      enumerable: true,
    });
    const yielded = collect(obj);
    expect(invoked).toBe(false);
    expect(yielded.length).toBe(0);
  });

  it("does NOT invoke a Symbol.toStringTag getter while detecting module namespaces", () => {
    // Detecting a module namespace performs no [[Get]] on @@toStringTag; one
    // would run user getters as a side effect on every walked value.
    let tagInvoked = false;
    let exportInvoked = false;
    const obj = {};
    Object.defineProperty(obj, Symbol.toStringTag, {
      get: () => {
        tagInvoked = true;
        return "Module"; // a real namespace uses a data property, not a getter
      },
      enumerable: false,
    });
    Object.defineProperty(obj, "export", {
      get: () => {
        exportInvoked = true;
        return () => {};
      },
      enumerable: true,
    });

    const yielded = collect(obj);
    // The toStringTag getter must never run; the object is not a real module
    // namespace, so its accessor export must not be followed either.
    expect(tagInvoked).toBe(false);
    expect(exportInvoked).toBe(false);
    expect(yielded.length).toBe(0);
  });

  it("does NOT treat an ordinary object with a casual toStringTag 'Module' as a namespace", () => {
    // A real Module Namespace Exotic Object exposes @@toStringTag as a
    // non-writable/non-enumerable/non-configurable data property. An ordinary
    // object that merely assigns `[Symbol.toStringTag] = "Module"` (writable,
    // enumerable, configurable) must NOT be classified as a namespace, so its
    // accessor properties' getters are never invoked.
    let exportInvoked = false;
    const obj: Record<PropertyKey, unknown> = {
      [Symbol.toStringTag]: "Module",
    };
    Object.defineProperty(obj, "export", {
      get: () => {
        exportInvoked = true;
        return () => {};
      },
      enumerable: true,
    });
    const yielded = collect(obj);
    expect(exportInvoked).toBe(false);
    // Only the data property (the toStringTag string) is yielded, not the
    // accessor export.
    expect(yielded).toEqual(["Module"]);
  });

  it("ignores a live binding that throws on read", () => {
    const ns: Record<PropertyKey, unknown> = {};
    Object.defineProperty(ns, Symbol.toStringTag, { value: "Module" });
    Object.defineProperty(ns, "boom", {
      get: () => {
        throw new Error("unreadable");
      },
      enumerable: true,
    });
    const good = () => {};
    Object.defineProperty(ns, "ok", { get: () => good, enumerable: true });
    const yielded = collect(ns);
    expect(yielded).toContain(good);
  });
});
