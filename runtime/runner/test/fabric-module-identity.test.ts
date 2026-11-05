import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { Source } from "@commonfabric/js-compiler";
import {
  computeFabricModuleIdentities,
  computeModuleIdentities,
  FABRIC_MOUNT_ROOT,
  type FabricMount,
} from "../src/sandbox/module-record-compiler.ts";
import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";

// These tests drive the sync identity-hash internals directly (below the async
// flow boundaries that normally load the deferred compiler stack).
await ensureCompilerStack();

const OTHER_HASH = "Bvcny13Rj8q-2ClANy_-k0ikWWQcXx7QTdsiqGfrC1c";

function source(name: string, contents: string): Source {
  return { name, contents };
}

function mountPath(entryIdentity: string, filename: string): string {
  return `${FABRIC_MOUNT_ROOT}${entryIdentity}${filename}`;
}

function mount(entryIdentity: string): FabricMount {
  return {
    entryIdentity,
    entryPath: mountPath(entryIdentity, "/main.tsx"),
    specifiers: [`cf:pattern:${entryIdentity}`],
  };
}

describe("computeFabricModuleIdentities", () => {
  it("preserves published subtree identities and keeps pins in authored identity", () => {
    const subtree = [
      source(
        "/main.tsx",
        `import { value } from "./util.ts";\nexport const imported = value;`,
      ),
      source("/util.ts", `export const value = 7;`),
    ];
    const standalone = computeModuleIdentities(subtree);
    const entryIdentity = standalone.get("/main.tsx")!;

    const mounted = [
      source(
        "/host.tsx",
        `import { imported } from "cf:pattern:${entryIdentity}";\nexport const host = imported;`,
      ),
      source(mountPath(entryIdentity, "/main.tsx"), subtree[0].contents),
      source(mountPath(entryIdentity, "/util.ts"), subtree[1].contents),
    ];
    const identities = computeFabricModuleIdentities(mounted, [
      mount(entryIdentity),
    ]);

    expect(identities.get(mountPath(entryIdentity, "/main.tsx"))).toBe(
      standalone.get("/main.tsx"),
    );
    expect(identities.get(mountPath(entryIdentity, "/util.ts"))).toBe(
      standalone.get("/util.ts"),
    );

    const repinned = [
      source(
        "/host.tsx",
        `import { imported } from "cf:pattern:${OTHER_HASH}";\nexport const host = imported;`,
      ),
      mounted[1],
      mounted[2],
    ];
    const repinnedIdentities = computeFabricModuleIdentities(repinned, [
      mount(entryIdentity),
    ]);

    expect(repinnedIdentities.get("/host.tsx")).not.toBe(
      identities.get("/host.tsx"),
    );
  });

  it("throws when a mounted entry does not hash back to its identity", () => {
    const subtree = [
      source("/main.tsx", `export const value = 1;`),
    ];
    const entryIdentity = computeModuleIdentities(subtree).get("/main.tsx")!;
    const tampered = [
      source("/host.tsx", `export const host = 1;`),
      source(mountPath(entryIdentity, "/main.tsx"), `export const value = 2;`),
    ];

    expect(() =>
      computeFabricModuleIdentities(tampered, [mount(entryIdentity)])
    )
      .toThrow("integrity failure");
  });

  it("throws for files under the fabric mount root with no matching mount", () => {
    const orphan = [
      source("/host.tsx", `export const host = 1;`),
      source(
        `${FABRIC_MOUNT_ROOT}${OTHER_HASH}/main.tsx`,
        `export const x = 1;`,
      ),
    ];

    expect(() => computeFabricModuleIdentities(orphan, [])).toThrow(
      "corrupt fabric mount assembly",
    );
  });

  it("keeps two mounts with the same stored filenames independent", () => {
    const first = [source("/main.tsx", `export const value = 1;`)];
    const second = [source("/main.tsx", `export const value = 2;`)];
    const firstIdentities = computeModuleIdentities(first);
    const secondIdentities = computeModuleIdentities(second);
    const firstEntry = firstIdentities.get("/main.tsx")!;
    const secondEntry = secondIdentities.get("/main.tsx")!;
    const mounted = [
      source("/host.tsx", `export const host = 1;`),
      source(mountPath(firstEntry, "/main.tsx"), first[0].contents),
      source(mountPath(secondEntry, "/main.tsx"), second[0].contents),
    ];

    const identities = computeFabricModuleIdentities(mounted, [
      mount(firstEntry),
      mount(secondEntry),
    ]);

    expect(identities.get(mountPath(firstEntry, "/main.tsx"))).toBe(
      firstEntry,
    );
    expect(identities.get(mountPath(secondEntry, "/main.tsx"))).toBe(
      secondEntry,
    );
  });
});
