import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type ServedBundle,
  topicsBrowserPostureOf,
} from "../integration/topics-browser-posture.ts";

/** A served bundle carrying the build define `value` as the bundler emits it. */
function bundleWith(value: string, servedByToolshed = true): ServedBundle {
  return {
    kind: "read",
    servedByToolshed,
    source:
      `var EXPERIMENTAL_SERVER_EXECUTION_DEFINE = true ? "${value}" : void 0;`,
  };
}

/** A shell that could not be read, served by the toolshed or another host. */
function unreadable(servedByToolshed: boolean): ServedBundle {
  return {
    kind: "unreachable",
    servedByToolshed,
    reason: "`/scripts/index.js` gave 404",
  };
}

describe("topicsBrowserPostureOf()", () => {
  it("returns `server-execution-off` when the toolshed and its shell both run off", () => {
    const posture = topicsBrowserPostureOf({
      experimental: { serverExecution: false },
      shellServerExecutionDefine: "false",
    });
    expect(posture.mode).toBe("server-execution-off");
    expect(posture.served).toBe(false);
    expect(posture.client).toBe(false);
    expect(posture.clientFrom).toBe("meta");
  });

  it("returns `server-execution-on` when the toolshed and its shell both run on", () => {
    const posture = topicsBrowserPostureOf({
      experimental: { serverExecution: true },
      shellServerExecutionDefine: "true",
    });
    expect(posture.mode).toBe("server-execution-on");
    expect(posture.clientFrom).toBe("meta");
  });

  it("reads the shell's posture from the bundle when the toolshed reports no baked define", () => {
    const posture = topicsBrowserPostureOf(
      {
        experimental: { serverExecution: true },
        shellServerExecutionDefine: null,
      },
      bundleWith("true"),
    );
    expect(posture.mode).toBe("server-execution-on");
    expect(posture.client).toBe(true);
    expect(posture.clientFrom).toBe("bundle");
  });

  it("takes the deployment's posture as the shell's when a bundle was read and names no define", () => {
    // A shell with no define baked adopts the posture its deployment
    // publishes, so the toolshed's half is the shell's too.
    for (const served of [true, false]) {
      const posture = topicsBrowserPostureOf(
        { experimental: { serverExecution: served } },
        {
          kind: "read",
          servedByToolshed: true,
          source: "var somethingElse = 1;",
        },
      );
      expect(posture.mode).toBe(
        served ? "server-execution-on" : "server-execution-off",
      );
      expect(posture.served).toBe(served);
      expect(posture.client).toBe(served);
      expect(posture.clientFrom).toBe("deployment");
    }
  });

  it("takes the deployment's posture as the shell's when no define is named and no bundle could be read", () => {
    const posture = topicsBrowserPostureOf(
      {
        experimental: { serverExecution: true },
        shellServerExecutionDefine: null,
      },
      unreadable(true),
    );
    expect(posture.mode).toBe("server-execution-on");
    expect(posture.clientFrom).toBe("deployment");
  });

  it("returns `meta and bundle` when the toolshed's report and the served shell agree", () => {
    const posture = topicsBrowserPostureOf(
      {
        experimental: { serverExecution: true },
        shellServerExecutionDefine: "true",
      },
      bundleWith("true"),
    );
    expect(posture.mode).toBe("server-execution-on");
    expect(posture.clientFrom).toBe("meta and bundle");
  });

  it("throws when the toolshed's report and the served shell name different defines", () => {
    expect(() =>
      topicsBrowserPostureOf(
        {
          experimental: { serverExecution: false },
          shellServerExecutionDefine: "false",
        },
        bundleWith("true"),
      )
    ).toThrow(
      /reports its shell baked `false` while the shell actually served carries `true`/,
    );
  });

  it("reads the shell's posture from the bundle even when another host serves it", () => {
    const posture = topicsBrowserPostureOf(
      { experimental: { serverExecution: true } },
      bundleWith("true", false),
    );
    expect(posture.mode).toBe("server-execution-on");
    expect(posture.clientFrom).toBe("bundle");
  });

  it("takes the deployment's posture as the shell's when only the toolshed names a define and another host serves the shell", () => {
    // The toolshed's define describes a shell this run does not load; the
    // one it loads carries none, and adopts the deployment's posture.
    const posture = topicsBrowserPostureOf(
      {
        experimental: { serverExecution: false },
        shellServerExecutionDefine: "false",
      },
      unreadable(false),
    );
    expect(posture.mode).toBe("server-execution-off");
    expect(posture.clientFrom).toBe("deployment");
  });

  it("uses the toolshed's report alone when it serves the shell whose script could not be read", () => {
    const posture = topicsBrowserPostureOf(
      {
        experimental: { serverExecution: false },
        shellServerExecutionDefine: "false",
      },
      unreadable(true),
    );
    expect(posture.mode).toBe("server-execution-off");
    expect(posture.clientFrom).toBe("meta");
  });

  it("throws naming both halves when the toolshed and its shell run opposite postures", () => {
    expect(() =>
      topicsBrowserPostureOf({
        experimental: { serverExecution: true },
        shellServerExecutionDefine: "false",
      })
    ).toThrow(
      /serves `serverExecution=true` while the shell it serves runs `false`/,
    );
  });

  it("throws when the toolshed reports no resolved `serverExecution`", () => {
    expect(() => topicsBrowserPostureOf({ experimental: {} })).toThrow(
      /reports no resolved `serverExecution`/,
    );
  });

  it("throws when a baked define spells neither `true` nor `false`", () => {
    expect(() =>
      topicsBrowserPostureOf(
        { experimental: { serverExecution: true } },
        bundleWith("yes"),
      )
    ).toThrow(/spells neither `true` nor `false`: "yes"/);
  });
});
