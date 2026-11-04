import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import {
  describeFiredBackstops,
  firedBackstops,
  type SilentBackstop,
} from "./support/silent-backstop-guard.ts";

const backstop: SilentBackstop = {
  logger: "storage.v2",
  key: "conflict-read-repair-timeout",
  meaning: "the read-repair wait gave up",
};

// Run one fixture file under the package preload the way the task runs a test
// file, and return its combined transcript and whether it passed. The paths
// come from `import.meta.url` through `fromFileUrl` rather than `.pathname`,
// which keeps its percent escapes — a checkout path with a space would reach
// the filesystem as a literal `%20` and the run would fail before the fixture.
async function runFixture(
  fixture: string,
): Promise<{ success: boolean; transcript: string }> {
  const fixtureUrl = new URL(`./support/${fixture}`, import.meta.url);
  const output = await runDenoCommandWithTemporaryLock({
    root: fromFileUrl(new URL("../../../", import.meta.url)),
    cwd: fromFileUrl(new URL("../", import.meta.url)),
    args: (tempLock) => [
      "test",
      "--no-check",
      "--lock",
      tempLock,
      "--frozen=true",
      "--preload=test/clock-preload.ts",
      "--allow-ffi",
      "--allow-env",
      "--allow-read",
      "--allow-write=/tmp,/var/folders",
      fromFileUrl(fixtureUrl),
    ],
    env: { ENV: "test" },
  });
  return {
    success: output.success,
    transcript: `${new TextDecoder().decode(output.stdout)}\n${
      new TextDecoder().decode(output.stderr)
    }`,
  };
}

describe("silent-backstop-guard", () => {
  describe("installSilentBackstopGuard()", () => {
    it("fails a test whose conflict retry could only ride the read-repair backstop", async () => {
      // The fixture is a test built to ride the backstop: its cold replica
      // commits a stale read, and the manual fan-out it never flushes withholds
      // the caught-up frame the retry is gated on, so the read-repair wait in
      // `src/storage/v2.ts` ends only through `CONFLICT_READ_REPAIR_TIMEOUT_MS`.
      // Run under the package preload as the task runs a test file, it fails
      // through the guard the preload installs, and through nothing else: its
      // own assertion — the commit came back as the conflict — holds.
      const { success, transcript } = await runFixture(
        "conflict-read-repair-backstop.fixture.ts",
      );
      expect(
        success,
        `the fixture passed: the backstop carried it silently\n${transcript}`,
      ).toBe(false);
      expect(transcript).toContain("silent backstop fired during this test");
      expect(transcript).toContain(
        'storage.v2 "conflict-read-repair-timeout" fired 1 time',
      );
      expect(transcript).not.toContain("AssertionError");
    });

    it("fails the ride even when a later step resets the logger counters", async () => {
      // A `describe` whose first `it` rides the backstop and whose second `it`
      // resets the logger counters. The guard wraps the whole `describe` as one
      // `Deno.test`, so reading the logger's own count would see it zeroed
      // before the wrapper ran and the ride would pass. The guard records the
      // firing where the reset cannot reach it, so this still fails.
      const { success, transcript } = await runFixture(
        "conflict-read-repair-backstop-reset.fixture.ts",
      );
      expect(
        success,
        `the reset erased the firing: the guard was defeated\n${transcript}`,
      ).toBe(false);
      expect(transcript).toContain("silent backstop fired during this test");
      expect(transcript).toContain(
        'storage.v2 "conflict-read-repair-timeout"',
      );
    });

    it("surfaces both the fired backstop and the body's own failure, keeping the cause", async () => {
      // A body that rides the backstop and also fails its own assertion. The
      // guard's error leads, appends that the body failed, and carries the
      // body's error as the `cause` Deno prints under `Caused by:`.
      const { success, transcript } = await runFixture(
        "conflict-read-repair-backstop-body-fails.fixture.ts",
      );
      expect(
        success,
        `the guard did not fail a body that rode the backstop\n${transcript}`,
      ).toBe(false);
      expect(transcript).toContain("silent backstop fired during this test");
      expect(transcript).toContain("The test body failed as well.");
      expect(transcript).toContain("Caused by:");
      expect(transcript).toContain(
        "the body's own assertion, deliberately failing",
      );
    });
  });

  describe("firedBackstops()", () => {
    const key = `${backstop.logger}\0${backstop.key}`;

    it("returns nothing for a count that did not move", () => {
      expect(
        firedBackstops([backstop], new Map([[key, 3]]), new Map([[key, 3]])),
      ).toEqual([]);
    });

    it("returns the backstop with how many times it fired", () => {
      expect(
        firedBackstops([backstop], new Map([[key, 3]]), new Map([[key, 5]])),
      ).toEqual([{ backstop, fired: 2 }]);
    });

    it("returns nothing for a backstop no logger has counted yet", () => {
      expect(firedBackstops([backstop], new Map(), new Map())).toEqual([]);
    });
  });

  describe("describeFiredBackstops()", () => {
    it("returns the backstop, its count, and its meaning", () => {
      const message = describeFiredBackstops([{ backstop, fired: 2 }]);
      expect(message).toContain("silent backstop fired during this test");
      expect(message).toContain(
        'storage.v2 "conflict-read-repair-timeout" fired 2 times',
      );
      expect(message).toContain(backstop.meaning);
    });
  });
});
