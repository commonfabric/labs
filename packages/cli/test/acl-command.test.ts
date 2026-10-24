import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { argv, cf, stripAnsi, withEnv } from "./utils.ts";

function errorText(stderr: string[]): string {
  return stderr.map(stripAnsi).join("\n");
}

describe("cf acl", () => {
  it("reads the space options its environment declarations map", async () => {
    // `--api-url` and `--identity` reach the option parser through the
    // command's `CF_API_URL` and `CF_IDENTITY` declarations. `--space` has a
    // `CF_SPACE` declaration too, and this call sets neither it nor the flag,
    // so the space is the one option left unsupplied.
    const { code, stderr } = await cf(argv`acl ls`, {
      env: {
        CF_API_URL: "https://toolshed.test",
        CF_IDENTITY: "/nonexistent/identity.key",
      },
    });
    expect(code).toBe(1);
    expect(errorText(stderr)).toContain('Missing required option: "--space".');
  });

  it("reports a missing identity on stderr and exits non-zero", async () => {
    const { code, stderr } = await cf(argv`acl ls`);
    expect(code).toBe(1);
    expect(errorText(stderr)).toContain(
      'Missing required option: "--identity", or "CF_IDENTITY".',
    );
  });

  it("reports a missing identity that only the test process declared", async () => {
    // Every test file in a `deno test --parallel` run shares one process
    // environment, so another file's identity and api-url can be set while
    // this one spawns the CLI. The spawned CLI takes its fabric configuration
    // from the test, so the surrounding process leaves no trace in it: the
    // missing identity is still the first thing the command reports.
    await withEnv("CF_API_URL", "https://ambient.test", async () => {
      await withEnv("CF_IDENTITY", "/ambient/identity.key", async () => {
        const { code, stderr } = await cf(argv`acl ls`);
        expect(code).toBe(1);
        expect(errorText(stderr)).toContain(
          'Missing required option: "--identity", or "CF_IDENTITY".',
        );
      });
    });
  });
});
