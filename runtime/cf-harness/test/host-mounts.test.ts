import { expect } from "@std/expect";
import { join } from "@std/path";
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

  describe("parseHostMountSpecs()", () => {
    const parse = (spec: string) => parseHostMountSpecs(spec, root);

    it("returns no mounts where none were given", async () => {
      expect(await parseHostMountSpecs(undefined, root)).toEqual([]);
      expect(await parseHostMountSpecs([], root)).toEqual([]);
    });

    it("returns a read-only mount, skipping empty fields, resolving a relative source and trimming the target's slash", async () => {
      await Deno.mkdir(join(root, "docs"));
      expect(await parse(" ,name=docs,, source=docs ,target=/docs/,")).toEqual(
        [{
          name: "docs",
          hostPath: join(root, "docs"),
          sandboxPath: "/docs",
          mode: "readonly",
        }],
      );
    });

    it("throws for a spec whose fields are not all named and valued", async () => {
      for (
        const [spec, message] of [
          ["  ", "--host-mount requires a non-empty spec"],
          [
            `name=a,${root}`,
            "--host-mount entries must use key=value comma-separated fields",
          ],
          [
            "=a,name=b",
            "--host-mount entries must use key=value comma-separated fields",
          ],
          [
            "name=a,source=",
            "--host-mount fields require non-empty keys and values",
          ],
          ["name=a,name=b", "--host-mount field repeated: name"],
          ["name=a,mdoe=writable", "--host-mount field unknown: mdoe"],
          [
            `name=a,source=${root}`,
            "--host-mount requires name, source, and target fields",
          ],
        ]
      ) {
        await expect(parse(spec)).rejects.toThrow(message);
      }
    });

    it("throws for a name, mode or target the sandbox cannot take", async () => {
      for (
        const [fields, message] of [
          ["name=.hidden,target=/m", "--host-mount name must start with"],
          ["name=m,target=/m,mode=rw", "--host-mount mode must be readonly"],
          ["name=m,target=m", "--host-mount target must be an absolute"],
          ["name=m,target=/", "--host-mount target must be an absolute"],
        ]
      ) {
        await expect(parse(`${fields},source=${root}`)).rejects.toThrow(
          message,
        );
      }
    });

    it("throws for a source that is missing, is not a directory, or is the filesystem root", async () => {
      const file = join(root, "file");
      await Deno.writeTextFile(file, "");
      for (
        const [source, message] of [
          [join(root, "absent"), "--host-mount source must exist"],
          [file, "--host-mount source must be a directory"],
          ["/", "--host-mount source must not be the filesystem root"],
        ]
      ) {
        await expect(parse(`name=m,target=/m,source=${source}`)).rejects
          .toThrow(message);
      }
    });

    it("throws the error itself for a source that cannot be examined", async () => {
      const file = join(root, "file");
      await Deno.writeTextFile(file, "");
      await expect(parse(`name=m,target=/m,source=${file}/under`)).rejects
        .toThrow(Deno.errors.NotADirectory);
    });

    it("throws for two mounts of one name, and not for two of different names", async () => {
      const spec = (name: string, target: string) =>
        `name=${name},source=${root},target=${target}`;
      await expect(
        parseHostMountSpecs([spec("m", "/a"), spec("m", "/b")], root),
      ).rejects.toThrow("--host-mount name repeated: m");
      expect(
        (await parseHostMountSpecs([spec("m", "/a"), spec("n", "/b")], root))
          .map((mount) => mount.name),
      ).toEqual(["m", "n"]);
    });
  });
});
