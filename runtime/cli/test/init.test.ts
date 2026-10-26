import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { exists } from "@std/fs/exists";
import { argv, cf, checkStderr } from "./utils.ts";

describe("cli init", () => {
  it("Initializes workspace", async () => {
    // Tasks always run with deno.jsonc directory as CWD
    // make sure to clean up files
    const root = join(import.meta.dirname!, "..");
    expect(await exists(join(root, "tsconfig.json"))).toEqual(false);
    expect(await exists(join(root, ".cf-types"))).toEqual(false);
    expect(await exists(join(root, ".cf-docs"))).toEqual(false);

    try {
      const { code, stdout, stderr } = await cf(argv`init`);
      checkStderr(stderr);
      expect(stdout.length).toBe(0);
      expect(code).toBe(0);

      const types = join(root, ".cf-types");
      expect(await exists(join(root, "tsconfig.json"))).toEqual(true);
      expect(await exists(join(root, ".cf-docs"))).toEqual(true);
      expect(await exists(join(types, "commonfabric", "index.d.ts"))).toEqual(
        true,
      );
      expect(await exists(join(types, "cf-env", "index.d.ts"))).toEqual(
        true,
      );
      expect(await exists(join(types, "react", "jsx-runtime", "index.d.ts")))
        .toEqual(true);
    } finally {
      await Deno.remove(join(root, "tsconfig.json"), { recursive: true });
      await Deno.remove(join(root, ".cf-types"), { recursive: true });
      await Deno.remove(join(root, ".cf-docs"), { recursive: true });
    }
  });
});
