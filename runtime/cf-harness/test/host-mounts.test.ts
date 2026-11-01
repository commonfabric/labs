import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  formatHostMountSpec,
  parseHostMountSpecs,
} from "../src/host-mounts.ts";

describe("host-mounts", () => {
  let root: string;

  beforeEach(async () => {
    root = await Deno.realPath(await Deno.makeTempDir());
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
  });

  it("round-trips both modes through the CLI grammar", async () => {
    for (const mode of ["readonly", "writable"] as const) {
      const mount = {
        name: "documents",
        hostPath: root,
        sandboxPath: "/documents",
        mode,
      };
      const spec = formatHostMountSpec(mount);
      expect(spec).toBe(
        `name=documents,source=${root},target=/documents,mode=${mode}`,
      );
      expect(await parseHostMountSpecs([spec], root)).toEqual([mount]);
    }
  });

  it("refuses fields the grammar would split or trim", () => {
    const mount = {
      name: "documents",
      hostPath: root,
      sandboxPath: "/documents",
      mode: "writable",
    };
    for (const field of ["name", "hostPath", "sandboxPath", "mode"] as const) {
      for (const value of ["a,b", " leading", "trailing "]) {
        expect(() => formatHostMountSpec({ ...mount, [field]: value })).toThrow(
          "--host-mount fields",
        );
      }
    }
  });
});
