import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { _internal } from "../lib/view/diffdoc.ts";

const encoder = new TextEncoder();
const objects = Array.from(
  { length: 13 },
  (_, index) => (index + 1).toString(16).padStart(40, "0"),
);

/** Formats successful `git cat-file --batch` output for one request. */
function batchOutput(
  input: string,
  contentFor: (object: string) => string,
): Uint8Array {
  return encoder.encode(
    input.trimEnd().split("\n").map((object) => {
      const content = contentFor(object);
      return `${object} blob ${encoder.encode(content).length}\n${content}\n`;
    }).join(""),
  );
}

describe("readGitBlobs()", () => {
  it("keeps each request within the minimum pipe capacity", () => {
    const requests: string[] = [];
    const blobs = _internal.readGitBlobs(
      "/repo",
      objects,
      (_command, _args, options) => {
        requests.push(options.input);
        return {
          status: 0,
          stdout: batchOutput(
            options.input,
            (object) => `content for ${object}`,
          ),
        };
      },
    );

    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every((request) => encoder.encode(request).length <= 512))
      .toBe(true);
    expect([...blobs]).toEqual(
      objects.map((object) => [object, `content for ${object}`]),
    );
  });

  it("stops after a failed bounded request", () => {
    let invocation = 0;
    const blobs = _internal.readGitBlobs(
      "/repo",
      objects,
      () => {
        invocation++;
        return { status: 1, stdout: new Uint8Array() };
      },
    );

    expect(invocation).toBe(1);
    expect(blobs.size).toBe(0);
  });

  it("returns no partial blobs or encoding state after a later failure", () => {
    const bomStates = new Map<string, boolean>();
    let invocation = 0;
    const blobs = _internal.readGitBlobs(
      "/repo",
      objects,
      (_command, _args, options) => {
        invocation++;
        if (invocation === 2) {
          return { status: 1, stdout: new Uint8Array() };
        }
        return {
          status: 0,
          stdout: batchOutput(options.input, () => "\uFEFFone"),
        };
      },
      bomStates,
    );

    expect(invocation).toBe(2);
    expect(blobs.size).toBe(0);
    expect(bomStates.size).toBe(0);
  });

  it("returns no partial blobs or encoding state after a later launch error", () => {
    const bomStates = new Map<string, boolean>();
    let invocation = 0;
    const blobs = _internal.readGitBlobs(
      "/repo",
      objects,
      (_command, _args, options) => {
        invocation++;
        if (invocation === 2) throw new Error("spawn failed");
        return {
          status: 0,
          stdout: batchOutput(options.input, () => "\uFEFFone"),
        };
      },
      bomStates,
    );

    expect(invocation).toBe(2);
    expect(blobs.size).toBe(0);
    expect(bomStates.size).toBe(0);
  });
});
