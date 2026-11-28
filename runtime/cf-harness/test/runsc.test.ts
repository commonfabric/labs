import { expect } from "@std/expect";

import {
  canonicalHostPathForTestingOnly,
  type HostPathReader,
} from "../src/sandbox/runsc.ts";
import { describe, it } from "@commonfabric/test-support/test";

/**
 * A filesystem held in memory: each path maps to the target of the symbolic
 * link at it, or to `null` for a directory. `/` is a directory. The entries
 * of `overrides` replace the reader's calls of the same name.
 */
const memoryReader = (
  entries: Record<string, string | null>,
  overrides: Partial<HostPathReader> = {},
): HostPathReader => ({
  lstat: (path) => {
    if (!(path in entries)) throw new Deno.errors.NotFound(path);
    const target = entries[path];
    return { isSymlink: target !== null, isDirectory: target === null };
  },
  readLink: (path) => entries[path] ?? "",
  realPath: (path) => path,
  ...overrides,
});

describe("runsc", () => {
  describe("canonicalHostPathForTestingOnly()", () => {
    const filesystem = {
      "/srv": null,
      "/srv/data": null,
      "/srv/link": "/srv/data",
    };

    it("follows a link it can read, and refuses a link that cannot be read", () => {
      expect(canonicalHostPathForTestingOnly(
        "path",
        "/srv/link/x",
        memoryReader(filesystem),
      )).toBe("/srv/data/x");
      const unreadable = memoryReader(filesystem, {
        readLink: (path) => {
          throw new Deno.errors.PermissionDenied(`cannot read ${path}`);
        },
      });
      expect(() =>
        canonicalHostPathForTestingOnly("path", "/srv/link/x", unreadable)
      ).toThrow(
        "path /srv/link/x cannot be resolved: the symbolic link /srv/link " +
          "could not be read (cannot read /srv/link)",
      );
      // A path that passes through no link never reads one.
      expect(canonicalHostPathForTestingOnly("path", "/srv/data/x", unreadable))
        .toBe("/srv/data/x");
    });

    it("refuses a link whose target is empty, which leads nowhere, unlike one whose target is `.`", () => {
      expect(() =>
        canonicalHostPathForTestingOnly(
          "path",
          "/srv/link/x",
          memoryReader({ "/srv": null, "/srv/link": "" }),
        )
      ).toThrow(
        "path /srv/link/x leads through a symbolic link whose target does not " +
          "exist (/srv/link)",
      );
      expect(canonicalHostPathForTestingOnly(
        "path",
        "/srv/link/x",
        memoryReader({ "/srv": null, "/srv/link": "." }),
      )).toBe("/srv/x");
    });

    it("appends the names that do not exist yet to the real path of what does", () => {
      const caseFolding = memoryReader(filesystem, {
        realPath: (path) => path.toUpperCase(),
      });
      expect(canonicalHostPathForTestingOnly(
        "path",
        "/srv/link/new/file",
        caseFolding,
      )).toBe("/SRV/DATA/new/file");
    });

    it("refuses a path whose real path cannot be found", () => {
      const vanishing = memoryReader(filesystem, {
        realPath: (path) => {
          throw new Deno.errors.NotFound(`no ${path}`);
        },
      });
      expect(() =>
        canonicalHostPathForTestingOnly("store", "/srv/link/x", vanishing)
      ).toThrow(
        "store /srv/link/x cannot be resolved: /srv/data could not be " +
          "examined (no /srv/data)",
      );
    });
  });
});
