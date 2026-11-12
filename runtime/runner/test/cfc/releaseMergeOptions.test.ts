import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";

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
});
