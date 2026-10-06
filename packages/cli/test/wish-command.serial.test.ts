import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ValidationError } from "@cliffy/command";
import { Identity } from "@commonfabric/identity";
import { decode } from "@commonfabric/utils/encoding";
import {
  parseScopeFlags,
  wish,
  wishAction,
  type WishCommandDeps,
} from "../commands/wish.ts";
import { setQuietMode } from "../commands/piece.ts";
import type { WishReadConfig, WishReadResult } from "../lib/wish.ts";
import { CellSelectionError } from "../lib/cell-selection.ts";
import { captureStderr, withEnv } from "./utils.ts";

// Drives the `cf wish` action body in-process with a stubbed readWish/exit
// (same idiom as test/inspect-remote.serial.test.ts), so flag handling, config
// shaping, JSON output and the error/exit paths are covered without a live
// server. The wish resolution itself is covered in test/wish.test.ts.

/**
 * Stub readWish that records the config and returns a canned result, or
 * rejects with `throws` — the shape a selection that fails against what the
 * wish resolved to arrives in.
 */
function stubDeps(result: WishReadResult, throws?: Error): {
  deps: WishCommandDeps;
  calls: WishReadConfig[];
  exits: number[];
} {
  const calls: WishReadConfig[] = [];
  const exits: number[] = [];
  return {
    deps: {
      readWish: (config: WishReadConfig) => {
        calls.push(config);
        if (throws) return Promise.reject(throws);
        return Promise.resolve(result);
      },
      exit: (code: number) => {
        exits.push(code);
      },
    },
    calls,
    exits,
  };
}

/** Capture what render() writes to stdout during `fn`. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  let captured = "";
  const original = Deno.stdout.writeSync;
  Deno.stdout.writeSync = (data: Uint8Array): number => {
    captured += decode(data);
    return data.length;
  };
  try {
    await fn();
  } finally {
    Deno.stdout.writeSync = original;
  }
  return captured;
}

async function makeTempKeyFile(): Promise<{ path: string; did: string }> {
  const path = await Deno.makeTempFile({ suffix: ".key" });
  const pkcs8 = await Identity.generatePkcs8();
  await Deno.writeFile(path, pkcs8);
  const did = (await Identity.fromPkcs8(await Deno.readFile(path))).did();
  return { path, did };
}

const BASE_OPTIONS = {
  apiUrl: "http://127.0.0.1:8000",
  identity: "/nonexistent-but-unread.key",
  space: "some-space",
};

describe("cf wish command action", () => {
  afterEach(() => {
    setQuietMode(false);
  });

  it("rejects a missing identity with a ValidationError", async () => {
    await expect(
      wishAction({ apiUrl: "http://127.0.0.1:8000" }, "#profile"),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a missing api-url with a ValidationError", async () => {
    await expect(
      wishAction({ identity: "./some.key" }, "#profile"),
    ).rejects.toThrow(ValidationError);
  });

  it("passes target, normalized api-url and explicit space to readWish", async () => {
    const { deps, calls, exits } = stubDeps({ result: { name: "Ada" } });
    const out = await captureStdout(() =>
      wishAction({ ...BASE_OPTIONS, quiet: true }, "#profile", deps)
    );

    expect(calls.length).toBe(1);
    expect(calls[0].query).toBe("#profile");
    expect(calls[0].space).toBe("some-space");
    expect(calls[0].apiUrl).toBe("http://127.0.0.1:8000");
    expect(calls[0].jsonOutput).toBe(true);
    // Explicit --space means the identity file is never read.
    expect(calls[0].identity.endsWith("nonexistent-but-unread.key")).toBe(true);
    expect(exits).toEqual([]);
    expect(JSON.parse(out)).toEqual({ name: "Ada" });
  });

  it("defaults --space to the identity keyfile's DID (home space)", async () => {
    const { path, did } = await makeTempKeyFile();
    try {
      const { deps, calls } = stubDeps({ result: "Ada" });
      await captureStdout(() =>
        wishAction(
          { apiUrl: "http://127.0.0.1:8000", identity: path },
          "#profileName",
          deps,
        )
      );
      expect(calls[0].space).toBe(did);
    } finally {
      await Deno.remove(path);
    }
  });

  it("parses --path into segments and narrows --scope values", async () => {
    const { deps, calls } = stubDeps({ result: [] });
    await captureStdout(() =>
      wishAction(
        { ...BASE_OPTIONS, path: "elements/0/title", scope: ["~", "profile"] },
        "#recipes",
        deps,
      )
    );
    expect(calls[0].path).toEqual(["elements", "0", "title"]);
    expect(calls[0].scope).toEqual(["~", "profile"]);

    // No --scope flags → undefined (builtin default), not [].
    const second = stubDeps({ result: [] });
    await captureStdout(() =>
      wishAction({ ...BASE_OPTIONS, scope: [] }, "#recipes", second.deps)
    );
    expect(second.calls[0].scope).toBeUndefined();
  });

  it("rejects an invalid --scope value with a ValidationError", () => {
    expect(() => parseScopeFlags(["bogus"])).toThrow(ValidationError);
    // Valid forms narrow without error.
    const did = "did:key:z6MkmXicY3H1CHNfZvRrb2JcbNSrP1mgfKVeZW3bCN8TTvA1";
    expect(parseScopeFlags(["~", ".", "profile", did])).toEqual([
      "~",
      ".",
      "profile",
      did,
    ]);
    expect(parseScopeFlags(undefined)).toBeUndefined();
  });

  it("prints the wish error to stderr and exits 1 on an empty result", async () => {
    const { deps, exits } = stubDeps({
      result: null,
      error: "No profile exists yet",
    });
    const errors = await captureStderr(() =>
      captureStdout(() => wishAction(BASE_OPTIONS, "#profile", deps)).then(
        (out) => {
          // Nothing rendered on stdout when the read failed.
          expect(out).toBe("");
        },
      )
    );
    expect(exits).toEqual([1]);
    expect(errors.join("\n")).toContain('wish "#profile"');
    expect(errors.join("\n")).toContain("No profile exists yet");
  });

  it("reports a malformed selection through the exit seam, not Deno.exit", async () => {
    const { deps, calls, exits } = stubDeps({ result: { name: "Ada" } });

    const errors = await captureStderr(() =>
      captureStdout(() =>
        wishAction({ ...BASE_OPTIONS, filter: "" }, "#profile", deps)
      ).then((out) => expect(out).toBe(""))
    );

    // Reaching the assertions at all is half the point: a direct `Deno.exit`
    // on this path takes the test runner down rather than failing, so an
    // earlier version of it could not be covered from here.
    expect(exits).toEqual([1]);
    expect(errors.join("\n")).toContain("--filter predicate must not be empty");
    // Refused before the wish was issued, so no read was attempted.
    expect(calls).toEqual([]);
  });

  it("reports a selection that fails against the target through the seam", async () => {
    const { deps, exits } = stubDeps(
      { result: null },
      new CellSelectionError("kept nothing over the target"),
    );

    const errors = await captureStderr(() =>
      captureStdout(() =>
        wishAction({ ...BASE_OPTIONS, select: "absent" }, "#profile", deps)
      ).then((out) => expect(out).toBe(""))
    );

    expect(exits).toEqual([1]);
    expect(errors.join("\n")).toContain("kept nothing over the target");
  });

  it("wish.parse routes missing config through cliffy as exit 1", async () => {
    // Drives the registered .action() through cliffy's parser: with no
    // identity/api-url configured the ValidationError becomes help output and
    // exit 1 (cliffy handles it; capture the writes to keep test output clean).
    await withEnv("CF_IDENTITY", undefined, async () => {
      await withEnv("CF_API_URL", undefined, async () => {
        const originalExit = Deno.exit;
        const originalLog = console.log;
        const originalError = console.error;
        let exitCode: number | null = null;
        Deno.exit = ((code?: number): never => {
          exitCode = code ?? 0;
          throw new Error("exit sentinel");
        }) as typeof Deno.exit;
        console.log = () => {};
        console.error = () => {};
        try {
          await wish.parse(["#profile"]);
        } catch {
          // The stubbed exit throws to halt cliffy's error handling.
        } finally {
          Deno.exit = originalExit;
          console.log = originalLog;
          console.error = originalError;
        }
        expect(exitCode).toBe(1);
      });
    });
  });

  it("projects an object result to plain data, dropping handle-valued keys (CT-1844)", async () => {
    // A materialized #profile object carries the pattern's stream handles
    // alongside its data. render() must not serialize those (they drag in the
    // whole runtime graph). Here a function stands in for a handle: it triggers
    // the same projection branch (isStream/isCell/function → marker) without a
    // live runtime, and asserts the data fields survive.
    const { deps, exits } = stubDeps({
      result: {
        $NAME: "Ada",
        name: "Ada",
        avatar: "",
        bio: "First programmer.",
        isEditing: false,
        elements: [{ title: "Note" }],
        setName: () => {},
        addElement: () => {},
        toggleEditing: () => {},
      },
    });
    const out = await captureStdout(() =>
      wishAction({ ...BASE_OPTIONS, quiet: true }, "#profile", deps)
    );
    const parsed = JSON.parse(out);

    // Data fields present and intact (including the nested elements array).
    expect(parsed.name).toBe("Ada");
    expect(parsed.bio).toBe("First programmer.");
    expect(parsed.isEditing).toBe(false);
    expect(parsed.elements).toEqual([{ title: "Note" }]);

    // Handle-valued keys are replaced by a key-tagged marker, not omitted, and
    // carry none of the runtime object graph.
    expect(parsed.setName).toBe("[stream:setName]");
    expect(parsed.addElement).toBe("[stream:addElement]");
    expect(parsed.toggleEditing).toBe("[stream:toggleEditing]");
    expect(out).not.toContain("scheduler");
    expect(out).not.toContain("circular reference");
    expect(out.length).toBeLessThan(600);
    expect(exits).toEqual([]);
  });

  it("parses the read options and hands the selection to readWish", async () => {
    const { deps, calls } = stubDeps({ result: { name: "Ada" } });
    await captureStdout(() =>
      wishAction(
        { ...BASE_OPTIONS, quiet: true, select: "name,bio", filter: undefined },
        "#profile",
        deps,
      )
    );

    // The parsed selection, not the raw flag text: `cf wish` reads the same
    // grammar `cf cell get` and `cf piece call` read, through the same
    // parser, so a caller learns it once.
    expect(calls[0].selection?.projection?.source).toBe("name,bio");
    expect(calls[0].selection?.projection?.flag).toBe("--select");
    expect(calls[0].selection?.filter).toBeUndefined();
  });

  it("parses --filter into the predicate the shared grammar defines", async () => {
    const { deps, calls } = stubDeps({ result: [] });
    await captureStdout(() =>
      wishAction(
        { ...BASE_OPTIONS, quiet: true, filter: '.status == "open"' },
        "#mentionable",
        deps,
      )
    );

    expect(calls[0].selection?.filter?.source).toBe('.status == "open"');
    expect(calls[0].selection?.filter?.paths).toEqual([["status"]]);
    expect(calls[0].selection?.projection).toBeUndefined();
  });

  it("names no selection at all when no read option is given", async () => {
    const { deps, calls } = stubDeps({ result: { name: "Ada" } });
    await captureStdout(() =>
      wishAction({ ...BASE_OPTIONS, quiet: true }, "#profile", deps)
    );

    // Absent rather than empty: a wish that asked for nothing reads the whole
    // target, and an empty selection object would send it through the
    // projection machinery for no reason.
    expect("selection" in calls[0]).toBe(false);
  });

  it("--allow-empty prints null and does not exit on an empty result", async () => {
    const { deps, exits } = stubDeps({
      result: null,
      error: "No profile exists yet",
    });
    const out = await captureStdout(() =>
      wishAction({ ...BASE_OPTIONS, allowEmpty: true }, "#profile", deps)
    );
    expect(exits).toEqual([]);
    expect(out.trim()).toBe("null");
  });
});
