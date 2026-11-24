/**
 * Completion cases that replace process-wide state, `console.log` or
 * `MEMORY_DIR`, so this file runs serially.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { completion } from "../commands/completion.ts";
import { resolveCompletionLine } from "../lib/completion/line.ts";
import { tokenizeLine } from "../lib/completion/mod.ts";
import { liveCandidates } from "../lib/completion/providers.ts";
import { main } from "../commands/main.ts";
import { captureStderr, withEnv } from "./utils.ts";

/** Runs `cf completion complete` for `cf pie`, with `log` as `console.log`. */
async function completePie(log: (...data: unknown[]) => void): Promise<void> {
  const original = console.log;
  console.log = log;
  try {
    await completion.parse(["complete", "--cword", "1", "--", "cf", "pie"]);
  } finally {
    console.log = original;
  }
}

describe("completion", () => {
  it("prints the candidates for the line", async () => {
    const printed: unknown[][] = [];

    await completePie((...data) => printed.push(data));

    expect(printed).toEqual([["piece"]]);
  });

  it("returns, reporting nothing, when stdout refuses the candidates", async () => {
    let attempted = 0;

    const stderr = await captureStderr(() =>
      completePie(() => {
        attempted++;
        throw new Deno.errors.BrokenPipe("the shell has gone");
      })
    );

    expect(attempted).toBe(1);
    expect(stderr).toEqual([]);
  });

  it("offers a space whose store sits under two directories once", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const did = "did:key:zCompletionTwoRootsFixture";
      const other = "did:key:zCompletionOneRootFixture";
      await Deno.mkdir(`${dir}/worktree`);
      await Deno.mkdir(`${dir}/checkout`);
      await Deno.writeTextFile(`${dir}/worktree/${did}.sqlite`, "");
      await Deno.writeTextFile(`${dir}/checkout/${did}.sqlite`, "");
      await Deno.writeTextFile(`${dir}/checkout/${other}.sqlite`, "");

      const text = "cf inspect summary ";
      const { words, cword } = tokenizeLine(text, text.length);
      let values: string[] = [];
      await withEnv("MEMORY_DIR", dir, async () => {
        const result = await liveCandidates(
          resolveCompletionLine(main, words, cword),
        );
        values = result.candidates.map((candidate) => candidate.value);
      });

      expect(values.filter((value) => value === did)).toEqual([did]);
      expect(values.filter((value) => value === other)).toEqual([other]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});
