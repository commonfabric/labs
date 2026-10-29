import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { assertEquals, assertRejects } from "@std/assert";
import { ValidationError } from "@cliffy/command";

import { inspect } from "../commands/inspect.ts";

const BASE = "http://inspect-validation.invalid:9999";
const SPACE = "did:key:z6MkInspectValidation";

const EXACT_PATH_CASES = [
  {
    description: "rejects conflicting path options before inspecting a space",
    args: ["--path", "value", "--path-json", '["value"]'],
    message: "either `--path` or `--path-json`",
  },
  {
    description: "rejects malformed exact path JSON before inspecting a space",
    args: ["--path-json", "["],
    message: "JSON array of string segments",
  },
  {
    description:
      "rejects non-string exact path segments before inspecting a space",
    args: ["--path-json", '["value",0]'],
    message: "JSON array of string segments",
  },
  {
    description: "rejects an empty slash path before inspecting a space",
    args: ["--path", ""],
    message: 'Missing value for option "--path"',
  },
];

const DOCUMENT_PATH_CASES = [
  {
    description: "rejects a slash path with `--doc` before inspecting a space",
    args: ["--doc", "--path", "value"],
    message: "`--doc` without `--path` or `--path-json`",
  },
  {
    description: "rejects an exact path with `--doc` before inspecting a space",
    args: ["--doc", "--path-json", '["value"]'],
    message: "`--doc` without `--path` or `--path-json`",
  },
];

const COMMAND_CASES = [
  {
    name: "value-at",
    args: ["value-at", SPACE, "of:a"],
    cases: [...EXACT_PATH_CASES, ...DOCUMENT_PATH_CASES],
  },
  {
    name: "diff",
    args: ["diff", SPACE, "of:a"],
    cases: [...EXACT_PATH_CASES, ...DOCUMENT_PATH_CASES],
  },
  {
    name: "converge",
    args: ["converge", "of:a", "--spaces", SPACE],
    cases: EXACT_PATH_CASES,
  },
];

let originalFetch: typeof fetch;
let fetches: number;
let tempDirectory: string;
let missingIdentity: string;

describe("inspect path validation", () => {
  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    fetches = 0;
    tempDirectory = await Deno.makeTempDir({
      prefix: "inspect-validation-",
    });
    missingIdentity = `${tempDirectory}/missing-identity.key`;
    globalThis.fetch = (() => {
      fetches++;
      return Promise.resolve(
        new Response("unexpected request", { status: 500 }),
      );
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await Deno.remove(tempDirectory, { recursive: true });
  });

  for (const command of COMMAND_CASES) {
    describe(`${command.name} path options`, () => {
      for (const testCase of command.cases) {
        it(testCase.description, async () => {
          fetches = 0;
          await assertRejects(
            () =>
              inspect.parse([
                ...command.args,
                "--remote",
                BASE,
                "--identity",
                missingIdentity,
                "--json",
                ...testCase.args,
              ]),
            ValidationError,
            testCase.message,
          );
          assertEquals(fetches, 0);
        });
      }
    });
  }
});
