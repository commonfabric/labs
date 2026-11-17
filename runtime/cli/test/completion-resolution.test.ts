/**
 * Completion cases that need no fabric and no environment: how a line is
 * tokenized and resolved to a slot, what `complete()` emits for a slot that
 * takes nothing, and which target a line's own words name.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Command } from "@cliffy/command";

import {
  resolveCompletionLine,
  stripInvocationPrefix,
} from "../lib/completion/line.ts";
import { complete, tokenizeLine } from "../lib/completion/mod.ts";
import {
  descendProjection,
  resolvePieceContext,
} from "../lib/completion/providers.ts";
import { main } from "../commands/main.ts";

/** A tree with two short flags, one boolean and one taking a value. */
function fixtureTree() {
  return new Command()
    .name("cf")
    .command(
      "get",
      new Command()
        .description("read")
        .option("-q, --quiet", "no value")
        .option("-s, --space <space:string>", "a space")
        .arguments("<path:string>"),
    )
    .reset();
}

/** Resolves `text`, cursor at its end, against `root`. */
function resolve(text: string, root = fixtureTree()) {
  const { words, cword } = tokenizeLine(text, text.length);
  return resolveCompletionLine(root, words, cword);
}

describe("completion-resolution", () => {
  describe("tokenizeLine()", () => {
    it("takes the character after a backslash inside double quotes literally", () => {
      expect(tokenizeLine('cf get "a\\"b" ', 15)).toEqual({
        words: ["cf", "get", 'a"b', ""],
        cword: 3,
      });
    });

    it("keeps a backslash inside single quotes", () => {
      expect(tokenizeLine("cf get 'a\\b' ", 13)).toEqual({
        words: ["cf", "get", "a\\b", ""],
        cword: 3,
      });
    });
  });

  describe("resolveCompletionLine()", () => {
    it("completes the value of the last flag of a bundle written just before the cursor", () => {
      const line = resolve("cf get -qs ");

      expect(line.slot?.kind).toBe("option-value");
      expect(line.slot?.kind === "option-value" && line.slot.option.name)
        .toBe("space");
    });

    it("completes the positional after a bundle whose last flag takes no value", () => {
      const line = resolve("cf get -sq ");

      expect(line.slot?.kind).toBe("argument");
      expect([...line.flags].sort()).toEqual(["quiet", "space"]);
      expect(line.options.size).toBe(0);
    });

    it("reads a bundle with an unknown letter as an opaque word", () => {
      const line = resolve("cf get -qz ");

      expect(line.slot?.kind).toBe("argument");
      expect(line.slot?.kind === "argument" && line.slot.index).toBe(0);
      expect(line.flags.size).toBe(0);
    });

    it("resolves an inline value of an undeclared option to no slot", () => {
      expect(resolve("cf get --nope=").slot).toBeNull();
    });

    it("resolves an inline value of a boolean option to no slot", () => {
      expect(resolve("cf get --quiet=").slot).toBeNull();
    });

    it("resolves an inline value of a value-taking option to its slot, with the prefix", () => {
      const slot = resolve("cf get --space=").slot;

      expect(slot?.kind).toBe("option-value");
      expect(slot?.kind === "option-value" && slot.inlinePrefix)
        .toBe("--space=");
    });
  });

  describe("stripInvocationPrefix()", () => {
    it("skips the flags between `task` and the task name", () => {
      expect(
        stripInvocationPrefix(["deno", "task", "--quiet", "cf", "piece"]),
      ).toEqual({ words: ["cf", "piece"], removed: 3 });
    });

    it("leaves a task line whose flags run to its end unchanged", () => {
      const words = ["deno", "task", "--quiet"];

      expect(stripInvocationPrefix(words)).toEqual({ words, removed: 0 });
    });
  });

  describe("complete()", () => {
    it("returns no lines for a slot that takes nothing", async () => {
      const { words, cword } = tokenizeLine("cf get --nope=", 14);

      expect(await complete(fixtureTree(), words, cword, "zsh")).toEqual([]);
    });

    it("returns the flags for the option-name slot beside it", async () => {
      const { words, cword } = tokenizeLine("cf get --q", 10);

      expect(await complete(fixtureTree(), words, cword, "bash")).toEqual([
        "--quiet",
      ]);
    });
  });

  describe("descendProjection()", () => {
    it("returns `undefined` for a path that continues past a scalar", () => {
      expect(descendProjection({ title: "Board" }, ["title", "length"]))
        .toBeUndefined();
    });

    it("returns the value a path names inside objects", () => {
      expect(descendProjection({ meta: { owner: "me" } }, ["meta", "owner"]))
        .toBe("me");
    });
  });

  describe("resolvePieceContext()", () => {
    function contextOf(text: string) {
      return resolvePieceContext(resolve(text, main));
    }

    it("reads the piece from the second segment of a `--url`", () => {
      expect(contextOf("cf cell get -i /k --url http://h:1/sp/pc ")).toEqual({
        apiUrl: "http://h:1",
        space: "sp",
        identity: "/k",
        jsonOutput: true,
        piece: "pc",
      });
    });

    it("returns `null` for a `--url` that names no piece", () => {
      expect(contextOf("cf cell get -i /k --url http://h:1/sp ")).toBeNull();
    });

    it("returns `null` for a `--url` that does not parse", () => {
      expect(contextOf("cf cell get -i /k --url 'http://[' ")).toBeNull();
    });

    it("returns `null` for a reference that does not parse", () => {
      expect(contextOf("cf cell get -i /k -a http://h:1 -s sp --cell / "))
        .toBeNull();
    });

    it("returns `null` for a reference whose connection does not resolve", () => {
      expect(contextOf("cf cell get --cell /my-piece -i /k --url bad "))
        .toBeNull();
    });

    it("reads a reference whose connection resolves", () => {
      expect(
        contextOf("cf cell get -i /k -a http://h:1 -s sp --cell /my-piece "),
      ).toEqual({
        apiUrl: "http://h:1",
        space: "sp",
        identity: "/k",
        jsonOutput: true,
        piece: "my-piece",
      });
    });
  });
});
