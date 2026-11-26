import { expect } from "@std/expect";
import { join } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

const cliPackageDir = join(import.meta.dirname!, "..");
const repoRoot = join(cliPackageDir, "..", "..");
const scriptPath = join(cliPackageDir, "support", "profiling", "cf-profile.ts");

/** Runs `cf-profile` with `args`, returning its exit code and output. */
async function cfProfile(args: string[]) {
  const output = await runDenoCommandWithTemporaryLock({
    root: repoRoot,
    cwd: cliPackageDir,
    args: (lockPath) => [
      "run",
      `--lock=${lockPath}`,
      "--frozen=true",
      "-A",
      scriptPath,
      ...args,
    ],
  });
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

describe("cf-profile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "cf-profile-" });
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true });
  });

  it("starts the profile at the start pattern and stops it when the command exits", async () => {
    const profilePath = join(dir, "profile.cpuprofile");

    const result = await cfProfile([
      `--profile-output=${profilePath}`,
      "--profile-start-pattern=Usage",
      "--help",
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect((await Deno.stat(profilePath)).size).toBeGreaterThan(0);
    const meta = JSON.parse(
      await Deno.readTextFile(join(dir, "profile.meta.json")),
    );
    expect(meta.profileStartPattern).toBe("Usage");
    expect(meta.profileStopPattern).toBeUndefined();
    expect(meta.cliStatus.success).toBe(true);
    expect(meta.captureStatus.success).toBe(true);
  });

  it("reports a start pattern the command never prints, and exits with the capture's code", async () => {
    const profilePath = join(dir, "profile.cpuprofile");

    const result = await cfProfile([
      `--profile-output=${profilePath}`,
      "--profile-start-pattern=NeverPrinted",
      "--help",
    ]);

    const meta = JSON.parse(
      await Deno.readTextFile(join(dir, "profile.meta.json")),
    );
    expect(meta.cliStatus.success).toBe(true);
    expect(meta.captureStatus.success).toBe(false);
    expect(result.stderr).toContain(
      "Profile start pattern was not observed: NeverPrinted",
    );
    expect(result.code).toBe(meta.captureStatus.code);
    expect(result.code).not.toBe(0);
  });

  it("exits with the command's code when the command fails", async () => {
    const profilePath = join(dir, "profile.cpuprofile");

    const result = await cfProfile([
      `--profile-output=${profilePath}`,
      "no-such-command",
    ]);

    const meta = JSON.parse(
      await Deno.readTextFile(join(dir, "profile.meta.json")),
    );
    expect(meta.cliStatus.success).toBe(false);
    expect(meta.captureStatus.success).toBe(true);
    expect(result.code).toBe(meta.cliStatus.code);
    expect(result.code).not.toBe(0);
  });

  it("exits with the capture's code when the profile cannot be written", async () => {
    // The profile's path is a directory, so writing the profile fails.
    const profilePath = join(dir, "profile.cpuprofile");
    await Deno.mkdir(profilePath);

    const result = await cfProfile([
      `--profile-output=${profilePath}`,
      "--profile-stop-pattern=Usage",
      "--help",
    ]);

    const meta = JSON.parse(
      await Deno.readTextFile(join(dir, "profile.meta.json")),
    );
    expect(meta.captureStatus.success).toBe(false);
    expect(result.code).toBe(meta.captureStatus.code);
    expect(result.code).not.toBe(0);
  });
});
