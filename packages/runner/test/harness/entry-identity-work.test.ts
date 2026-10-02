import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import * as compiler from "../../src/harness/compiler-stack.ts";
import { ensureCompilerStack } from "../../src/harness/deferred-compiler-stack.ts";
import { computeEntryIdentity } from "../../src/harness/entry-identity.ts";

// This file's isolated runtime installs the counting loader; the identity
// parity tests use the real compiler stack in their own file.
const scans = spy(compiler.collectImportSpecifiers);
await ensureCompilerStack(() =>
  Promise.resolve({ ...compiler, collectImportSpecifiers: scans })
);

describe("entry-identity", () => {
  it("bounds import parsing per file independently of the root count", () => {
    const sourceRoots = Array.from({ length: 32 }, (_, i) => `/root-${i}.ts`);
    const files = [
      { name: "/entry.ts", contents: "export default 1;" },
      { name: "/shared.ts", contents: "export const shared = 1;" },
      ...sourceRoots.map((name) => ({
        name,
        contents: 'export { shared } from "./shared.ts";',
      })),
    ];
    const start = scans.calls.length;
    const identity = computeEntryIdentity("/entry.ts", files, { sourceRoots });
    const parsed = scans.calls.slice(start);

    expect(identity).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Closure validation and hashing each need at most one scan per file.
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.length).toBeLessThanOrEqual(2 * files.length);
  });
});
