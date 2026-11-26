/**
 * Covers `resolveSecret()`, which `cf id derive` and `cf id from-mnemonic`
 * read their secret through, with a stand-in standard input. Serial, since it
 * replaces `console.error` to read the prompt.
 */

import { expect } from "@std/expect";
import { encode } from "@commonfabric/text/utf8";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { resolveSecret } from "../commands/identity.ts";

/** A standard input holding `text`, which is a terminal when `terminal`. */
function stdinOf(text: string, terminal: boolean) {
  return {
    isTerminal: () => terminal,
    readable: new Blob([encode(text)]).stream(),
  };
}

describe("resolveSecret()", () => {
  let errors: string[];
  const originalError = console.error;

  beforeEach(() => {
    errors = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
  });

  afterEach(() => {
    console.error = originalError;
  });

  it("returns an inline value verbatim, reading no standard input", async () => {
    const stdin = stdinOf("from stdin", true);
    expect(await resolveSecret("inline\n", [], "passphrase", stdin)).toBe(
      "inline\n",
    );
    expect(stdin.readable.locked).toBe(false);
    expect(errors).toEqual([]);
  });

  it("returns the file named after `--`, without one trailing newline", async () => {
    const file = await Deno.makeTempFile();
    try {
      await Deno.writeTextFile(file, "from file\n\n");
      expect(
        await resolveSecret(undefined, [file], "passphrase", stdinOf("", true)),
      ).toBe("from file\n");
    } finally {
      await Deno.remove(file);
    }
  });

  it("throws for both an inline value and a file, and for two files", async () => {
    await expect(
      resolveSecret("inline", ["a.txt"], "mnemonic", stdinOf("", false)),
    ).rejects.toThrow(
      "Provide the mnemonic inline or as a -- <file>, not both.",
    );
    await expect(
      resolveSecret(
        undefined,
        ["a.txt", "b.txt"],
        "mnemonic",
        stdinOf("", false),
      ),
    ).rejects.toThrow("Expected a single mnemonic file after `--`.");
  });

  it("reads standard input for `-` or no value, prompting on standard error only at a terminal", async () => {
    expect(
      await resolveSecret("-", [], "passphrase", stdinOf("piped\n", false)),
    ).toBe("piped");
    expect(errors).toEqual([]);
    expect(
      await resolveSecret(undefined, [], "passphrase", stdinOf("typed", true)),
    ).toBe("typed");
    expect(errors).toEqual([
      "Reading passphrase from stdin; type it and press Ctrl-D...",
    ]);
  });

  it("throws naming standard input when it holds nothing but a newline", async () => {
    await expect(
      resolveSecret("-", [], "mnemonic", stdinOf("\n", false)),
    ).rejects.toThrow("No mnemonic provided from stdin.");
  });
});
