import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import { describe, it } from "@commonfabric/test-support/test";

import { releaseMergeOptions } from "../../src/cfc/prepare.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("cfc-release-merge-options");

describe("releaseMergeOptions()", () => {
  describe("adoptsStamp", () => {
    it("returns whether a claim is stamped with a module of the released program, whatever else its binding holds", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      try {
        const tx = runtime.edit();
        const options = releaseMergeOptions(
          tx,
          { space: signer.did(), id: "of:released" as URI, scope: "space" },
          {},
          ["released-module"],
        );
        const stamped = (binding: Record<string, unknown>) => ({
          __ctWriterIdentityOf: binding,
        });
        expect(
          options.adoptsStamp?.(stamped({
            moduleIdentity: "released-module",
            file: "/main.tsx",
            path: ["write"],
          })),
        ).toBe(true);
        // A binding naming no file or path is still the module's stamp.
        expect(
          options.adoptsStamp?.(stamped({ moduleIdentity: "released-module" })),
        )
          .toBe(true);
        expect(
          options.adoptsStamp?.(stamped({
            moduleIdentity: "other-module",
            file: "/main.tsx",
            path: ["write"],
          })),
        ).toBe(false);
        expect(
          options.adoptsStamp?.(
            stamped({ file: "/main.tsx", path: ["write"] }),
          ),
        )
          .toBe(false);
        expect(options.adoptsStamp?.(["builtin"])).toBe(false);
        tx.abort();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });

  describe("beneathStoredLink", () => {
    /**
     * Stores a document whose `items` holds a reference, then runs `write`
     * in a transaction and returns, for each of `paths`, whether the options
     * that transaction's release merges with take it to lie beneath a
     * reference the document stored.
     */
    async function beneathStoredLink(
      write: (
        tx: ReturnType<Runtime["edit"]>,
        released: ReturnType<Runtime["getCell"]>,
      ) => void,
      paths: readonly (readonly string[])[],
    ): Promise<boolean[]> {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      try {
        const seed = runtime.edit();
        const linked = runtime.getCell(signer.did(), "linked", undefined, seed);
        linked.set({ name: "linked" });
        const released = runtime.getCell(
          signer.did(),
          "released",
          undefined,
          seed,
        );
        released.set({ items: [linked], note: "plain" });
        expect((await seed.commit().settled).error).toBeUndefined();

        const tx = runtime.edit();
        try {
          write(tx, released);
          const { id } = released.getAsNormalizedFullLink();
          const options = releaseMergeOptions(
            tx,
            { space: signer.did(), id, scope: "space" },
            {},
            [],
          );
          return paths.map((path) => options.beneathStoredLink!(path));
        } finally {
          tx.abort();
        }
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    }

    const paths = [
      ["items", "0", "name"],
      ["items", "*", "name"],
      ["note", "name"],
    ];

    it("returns whether a position lies beneath one that held only references", async () => {
      expect(await beneathStoredLink(() => {}, paths)).toEqual([
        true,
        true,
        false,
      ]);
    });

    it("returns false everywhere once the transaction replaced the whole document", async () => {
      expect(
        await beneathStoredLink((tx, released) => {
          tx.writeOrThrow({ ...released.getAsNormalizedFullLink(), path: [] }, {
            value: { items: [], note: "replaced" },
          });
        }, paths),
      ).toEqual([false, false, false]);
    });

    it("returns false beneath a member whose state before the transaction can't be told", async () => {
      // The member's own write came after one beneath it, so what it held
      // first is not what the document stored.

      expect(
        await beneathStoredLink((tx, released) => {
          const item = released.getAsNormalizedFullLink();
          tx.writeValueOrThrow({ ...item, path: ["items", "0", "name"] }, "x");
          tx.writeValueOrThrow({ ...item, path: ["items", "0"] }, "y");
        }, paths),
      ).toEqual([false, false, false]);
    });
  });
});
