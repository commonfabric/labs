import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { describe, it } from "@commonfabric/test-support/test";

describe("provision-ingest-channel", () => {
  describe("as a program", () => {
    // Runs the script as a program, which is how an operator meets it: the
    // arguments it is given reach `main`, and the process exits with the code
    // `main` returns. Each case is refused at validation, which happens before a
    // runtime is built, so nothing here needs a memory server.

    const run = async (args: string[]) => {
      const { code, stdout, stderr } = await runDenoCommandWithTemporaryLock({
        root: fromFileUrl(new URL("../../..", import.meta.url)),
        cwd: fromFileUrl(new URL("..", import.meta.url)),
        args: (lockPath) => [
          "run",
          "--lock",
          lockPath,
          "-A",
          fromFileUrl(
            new URL("./provision-ingest-channel.ts", import.meta.url),
          ),
          ...args,
        ],
      });
      const decoder = new TextDecoder();
      return {
        code,
        stdout: decoder.decode(stdout),
        stderr: decoder.decode(stderr),
      };
    };

    it("exits 2 and names the bad --space it was given", async () => {
      const result = await run(["--space", "not-a-did", "--install-id", "p-1"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Invalid --space 'not-a-did'");
      expect(result.stdout).not.toContain("Ingest channel provisioned");
    });

    it("reports a bad --install-id rather than the space when the space is valid", async () => {
      const result = await run([
        "--space",
        "did:key:z6MkspaceProvisionAAAA",
        "--install-id",
        "bad id",
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Invalid --install-id 'bad id'");
      expect(result.stderr).not.toContain("Invalid --space");
      expect(result.stdout).not.toContain("Ingest channel provisioned");
    });
  });
});
