import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as root from "@commonfabric/llm";
import * as client from "@commonfabric/llm/client";
import * as types from "@commonfabric/llm/types";

describe("index", () => {
  it("exports everything the client and types entry points export", () => {
    expect(root).toEqual(expect.objectContaining({ ...client, ...types }));
    expect(Object.keys(root).sort()).toEqual(
      [...new Set([...Object.keys(client), ...Object.keys(types)])].sort(),
    );
  });
});
