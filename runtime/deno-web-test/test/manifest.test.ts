/**
 * `Manifest` owns one temporary directory per run and hands out the two paths
 * inside it. What is pinned here is that the directory is there while the run
 * needs it, that it is gone afterwards, and that its name says what made it,
 * which is what `temporary-directories.test.ts` reads a finished run against.
 */

import { existsSync } from "@std/fs/exists";
import { basename, dirname } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Manifest, RUN_DIRECTORY_PREFIX } from "../manifest.ts";

/** A directory with no `deno-web-test.config.ts`, so the run takes defaults. */
const PROJECT_DIR = import.meta.dirname as string;

describe("Manifest", () => {
  describe("instance members", () => {
    describe("remove()", () => {
      it("removes the server and profile directories and the one holding them", async () => {
        const manifest = await Manifest.create(PROJECT_DIR, []);
        const runDirectory = dirname(manifest.serverDir);

        await manifest.remove();

        expect(existsSync(manifest.serverDir)).toBe(false);
        expect(existsSync(manifest.profileDir)).toBe(false);
        expect(existsSync(runDirectory)).toBe(false);
      });
    });
  });

  describe("static members", () => {
    describe("create()", () => {
      it("makes the server and profile directories inside one temporary directory", async () => {
        const manifest = await Manifest.create(PROJECT_DIR, []);

        try {
          expect(Deno.statSync(manifest.serverDir).isDirectory).toBe(true);
          expect(Deno.statSync(manifest.profileDir).isDirectory).toBe(true);
          expect(dirname(manifest.serverDir))
            .toBe(dirname(manifest.profileDir));
        } finally {
          await manifest.remove();
        }
      });

      it("names that directory with the run-directory prefix", async () => {
        const manifest = await Manifest.create(PROJECT_DIR, []);

        try {
          expect(basename(dirname(manifest.serverDir)))
            .toMatch(new RegExp(`^${RUN_DIRECTORY_PREFIX}`));
        } finally {
          await manifest.remove();
        }
      });
    });
  });
});
