/**
 * `Manifest` owns one temporary directory per run and hands out the two paths
 * inside it. What is pinned here is that the directory is there while the run
 * needs it, that it is gone afterwards, and that its name says what made it,
 * which is what `temporary-directories.test.ts` reads a finished run against.
 */

import { existsSync } from "@std/fs/exists";
import { basename, dirname } from "@std/path";
import { expect } from "@std/expect";

import { applyDefaults } from "../config.ts";
import { Manifest, RUN_DIRECTORY_PREFIX } from "../manifest.ts";
import { describe, it } from "@commonfabric/test-support/test";

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

      it("holds the project, tests, and configuration it was made for", async () => {
        const manifest = await Manifest.create(PROJECT_DIR, ["a.test.ts"]);

        try {
          expect(manifest.projectDir).toBe(PROJECT_DIR);
          expect(manifest.tests).toEqual(["a.test.ts"]);
          expect(manifest.config).toEqual(applyDefaults({}));
          expect(manifest.requestedPort).toBe(0);
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

      it("removes the temporary directory and rethrows when a directory inside it cannot be made", async () => {
        const failure = new Error("no room for the profile");
        const made: string[] = [];
        const makeDirectory = async (path: string) => {
          if (basename(path) === "profile") throw failure;
          await Deno.mkdir(path);
          made.push(path);
        };

        await expect(Manifest.create(PROJECT_DIR, [], makeDirectory))
          .rejects.toBe(failure);

        expect(made.map((path) => basename(path))).toEqual(["server"]);
        const runDirectory = dirname(made[0]);
        expect(basename(runDirectory))
          .toMatch(new RegExp(`^${RUN_DIRECTORY_PREFIX}`));
        expect(existsSync(runDirectory)).toBe(false);
      });

      it("leaves the temporary directory in place when both directories are made", async () => {
        const made: string[] = [];
        const manifest = await Manifest.create(
          PROJECT_DIR,
          [],
          async (path) => {
            await Deno.mkdir(path);
            made.push(path);
          },
        );

        try {
          expect(made).toEqual([manifest.serverDir, manifest.profileDir]);
          expect(existsSync(dirname(manifest.serverDir))).toBe(true);
        } finally {
          await manifest.remove();
        }
      });
    });
  });
});
