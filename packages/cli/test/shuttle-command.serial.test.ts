/**
 * Unit tests for `cf sh`.
 *
 * The command reads a person's flags and hands on what they settled to, so
 * that is what the cases read back: the run is stood in for, and what it was
 * given is the whole of what this command decides.
 */

import { expect } from "@std/expect";
import { isAbsolute } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { sh, shuttleFromCommand } from "../commands/sh.ts";
import type { SpaceConfig } from "../lib/piece.ts";
import { withEnv } from "./utils.ts";

/** The flags a case writes, in the shape Cliffy hands them to the action. */
const OPTIONS = {
  apiUrl: "https://toolshed.example",
  identity: "/keys/shuttle.pkcs8",
  space: "board",
};

/**
 * Helper for the cases below, which runs the action over `options` and returns
 * the connection the shell was opened over.
 */
async function opened(
  options: Partial<typeof OPTIONS>,
): Promise<SpaceConfig | undefined> {
  let config: SpaceConfig | undefined;
  await shuttleFromCommand(options, {
    runShuttle: (given) => {
      config = given;
      return Promise.resolve();
    },
  });
  return config;
}

describe("cf sh", () => {
  it("opens a shell over the connection the flags name", async () => {
    expect(await opened(OPTIONS)).toEqual(OPTIONS);
  });

  it("opens it over an identity path made absolute", async () => {
    const config = await opened({ ...OPTIONS, identity: "./local.key" });
    expect(isAbsolute(config?.identity ?? "")).toBe(true);
  });

  it("opens it over the api URL in its canonical spelling", async () => {
    const config = await opened({
      ...OPTIONS,
      apiUrl: "https://toolshed.example/?stale=1",
    });
    expect(config?.apiUrl).toBe("https://toolshed.example");
  });

  it("refuses a missing identity, and opens nothing", async () => {
    let ran = false;
    await expect(
      shuttleFromCommand({ apiUrl: OPTIONS.apiUrl, space: OPTIONS.space }, {
        runShuttle: () => {
          ran = true;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(
      'Missing required option: "--identity", or "CF_IDENTITY".',
    );
    expect(ran).toBe(false);
  });

  it("refuses through cliffy when the command itself is parsed", async () => {
    // The registered action is the only place the command is wired to the
    // body above it, and nothing else drives it. Parsing with no connection
    // configured runs that action and stops inside the flag reading, so the
    // wiring is exercised without a fabric behind it — the shape
    // `wish-command.serial.test.ts` uses for the same reason.

    await withEnv("CF_IDENTITY", undefined, async () => {
      await withEnv("CF_API_URL", undefined, async () => {
        await withEnv("CF_SPACE", undefined, async () => {
          const exit = Deno.exit;
          const log = console.log;
          const error = console.error;
          let code: number | undefined;
          Deno.exit = ((given?: number): never => {
            code = given ?? 0;
            throw new Error("exit sentinel");
          }) as typeof Deno.exit;
          console.log = () => {};
          console.error = () => {};
          try {
            await sh.parse([]);
          } catch {
            // Cliffy turns the refusal into help output and an exit, which the
            // stand-in above raises out of rather than ending the run.
          } finally {
            Deno.exit = exit;
            console.log = log;
            console.error = error;
          }
          expect(code).toBe(1);
        });
      });
    });
  });

  it("refuses a missing space, and opens nothing", async () => {
    let ran = false;
    await expect(
      shuttleFromCommand({
        apiUrl: OPTIONS.apiUrl,
        identity: OPTIONS.identity,
      }, {
        runShuttle: () => {
          ran = true;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow('Missing required option: "--space".');
    expect(ran).toBe(false);
  });
});
