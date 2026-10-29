import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import {
  dependencyLayerOf,
  PACKAGE_PARENTS,
  packageDirNamed,
  packageDirOf,
  TOP_LEVEL_PACKAGES,
  withoutPackageParent,
} from "./package-layout.ts";

describe("package-layout", () => {
  describe("packageDirOf()", () => {
    it("returns the parent and the next segment for a path under a parent", () => {
      expect(packageDirOf("runtime/runner/src/cell.ts")).toBe("runtime/runner");
      expect(packageDirOf("runtime/runner")).toBe("runtime/runner");
      expect(packageDirOf("base/data-model/src/x.ts")).toBe(
        "base/data-model",
      );
    });

    it("returns a top-level package for a path under it", () => {
      expect(packageDirOf("patterns/system/home/home.tsx")).toBe("patterns");
      expect(packageDirOf("patterns")).toBe("patterns");
      expect(packageDirOf("connectors/github/host/src/host.ts")).toBe(
        "connectors",
      );
    });

    it("returns undefined for a path in no package", () => {
      for (
        const path of [
          "tasks/test.ts",
          "runtime",
          "runtime/",
          "data-model/README.md",
          "patternsx/a.ts",
          "docs/runtime/a.md",
        ]
      ) {
        expect(packageDirOf(path)).toBe(undefined);
      }
    });
  });

  describe("withoutPackageParent()", () => {
    it("takes the parent off a path under one", () => {
      expect(withoutPackageParent("runtime/runner/src")).toBe("runner/src");
      expect(withoutPackageParent("base/data-model")).toBe(
        "data-model",
      );
    });

    it("returns a path under no parent unchanged", () => {
      expect(withoutPackageParent("patterns")).toBe("patterns");
      expect(withoutPackageParent("connectors/agents/host")).toBe(
        "connectors/agents/host",
      );
      expect(withoutPackageParent("tasks")).toBe("tasks");
    });
  });

  describe("packageDirNamed()", () => {
    async function tree(dirs: string[]): Promise<string> {
      const root = await Deno.makeTempDir({ prefix: "package-layout-" });
      for (const dir of dirs) {
        await Deno.mkdir(join(root, dir), { recursive: true });
      }
      return root;
    }

    it("returns the one package directory going by the name", async () => {
      const root = await tree(["runtime/shell", "patterns"]);
      try {
        expect(packageDirNamed(root, "shell")).toBe("runtime/shell");
        expect(packageDirNamed(root, "patterns")).toBe("patterns");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("throws for a name no package goes by", async () => {
      const root = await tree(["runtime/shell"]);
      try {
        expect(() => packageDirNamed(root, "oven")).toThrow(
          "no package is named oven",
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("throws for a name two packages go by", async () => {
      const root = await tree(["runtime/oven", "base/oven"]);
      try {
        expect(() => packageDirNamed(root, "oven")).toThrow(
          "more than one package is named oven",
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("returns each package of this repository for its name alone", () => {
      // Test records and the package-cycle check name a package without its
      // parent directory, so each package needs a name that no other package
      // has.
      const root = fromFileUrl(new URL("..", import.meta.url));
      const dirs: string[] = [...TOP_LEVEL_PACKAGES];
      for (const parent of PACKAGE_PARENTS) {
        for (const entry of Deno.readDirSync(join(root, parent))) {
          if (entry.isDirectory) dirs.push(`${parent}/${entry.name}`);
        }
      }
      for (const dir of dirs) {
        expect(packageDirNamed(root, withoutPackageParent(dir))).toBe(dir);
      }
    });
  });

  describe("dependencyLayerOf()", () => {
    it("returns an earlier layer for a package that others depend on", () => {
      expect(dependencyLayerOf("base/js-values")).toBeLessThan(
        dependencyLayerOf("dashboard"),
      );
      expect(dependencyLayerOf("base/api")).toBeLessThan(
        dependencyLayerOf("runtime/runner"),
      );
      expect(dependencyLayerOf("connectors")).toBe(
        dependencyLayerOf("patterns"),
      );
    });

    it("throws for a directory that is no package's", () => {
      expect(() => dependencyLayerOf("tasks")).toThrow(
        "tasks is no package directory",
      );
    });
  });
});
