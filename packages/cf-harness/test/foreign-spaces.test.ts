import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { resolveConsoleConfig } from "../console/server.ts";
import { resolveHarnessFabricSessionConfig } from "../src/fabric-session-options.ts";
import {
  admitsFabricReference,
  parseHarnessForeignSpaces,
  validateHarnessForeignSpaces,
} from "../src/foreign-spaces.ts";

const LOCAL = "did:key:zLocal";
const FOREIGN = "did:key:zForeign";
const routes = { [FOREIGN]: "https://foreign.example/" };

describe("foreign-spaces", () => {
  it("admits local references and only explicitly listed foreign DIDs", () => {
    expect(admitsFabricReference(undefined, LOCAL)).toBe(true);
    expect(admitsFabricReference(LOCAL, LOCAL)).toBe(true);
    expect(admitsFabricReference(FOREIGN, LOCAL)).toBe(false);
    expect(admitsFabricReference(FOREIGN, LOCAL, routes)).toBe(true);
    expect(admitsFabricReference("did:key:zOther", LOCAL, routes)).toBe(false);
    expect(admitsFabricReference(FOREIGN, LOCAL, Object.create(routes)))
      .toBe(false);
  });

  it("validates and snapshots the operator map", () => {
    const input = { [FOREIGN]: "https://foreign.example" };
    const parsed = validateHarnessForeignSpaces(input);
    input[FOREIGN] = "https://changed.example";
    expect(parsed).toEqual(routes);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parseHarnessForeignSpaces(undefined)).toBeUndefined();
    expect(parseHarnessForeignSpaces("{}")).toEqual({});
  });

  it("throws for space names and hosts that are not HTTP(S) origins", () => {
    for (
      const value of [
        [],
        null,
        "foreign",
        { foreign: "https://foreign.example" },
        { "did:key:": "https://foreign.example" },
        { "did:key:z Foreign": "https://foreign.example" },
        { [FOREIGN]: 1 },
        { [FOREIGN]: "file:///tmp" },
        { [FOREIGN]: "https://user:password@foreign.example" },
        { [FOREIGN]: "https://foreign.example/path" },
        { [FOREIGN]: "https://foreign.example/?query=yes" },
        { [FOREIGN]: "https://foreign.example/#frag" },
      ]
    ) {
      expect(() => validateHarnessForeignSpaces(value)).toThrow();
    }
    expect(() => parseHarnessForeignSpaces("invalid JSON")).toThrow();
  });

  it("resolves startup flags over environment for CLI and console sessions", async () => {
    const raw = JSON.stringify(routes);
    const env = { CF_HARNESS_FABRIC_FOREIGN_SPACES: raw };
    const binding = {
      "fabric-api-url": "http://localhost:9000",
      "fabric-identity": "/fixture.key",
      "fabric-space": "local",
    };
    expect(resolveHarnessFabricSessionConfig(binding, env, "/")?.foreignSpaces)
      .toEqual(routes);
    expect(
      resolveHarnessFabricSessionConfig(
        {
          ...binding,
          "fabric-foreign-spaces": "{}",
        },
        env,
        "/",
      )?.foreignSpaces,
    ).toEqual({});
    expect(() => resolveHarnessFabricSessionConfig({}, env, "/"))
      .toThrow("needs");
    const args = [
      "--fabric-identity",
      "/fixture.key",
      "--fabric-space",
      "local",
    ];
    expect(
      (await resolveConsoleConfig(args, env, "/")).fabricSession.foreignSpaces,
    )
      .toEqual(routes);
    expect(
      (await resolveConsoleConfig(
        [
          ...args,
          "--fabric-foreign-spaces",
          "{}",
        ],
        env,
        "/",
      )).fabricSession.foreignSpaces,
    ).toEqual({});
  });
});
