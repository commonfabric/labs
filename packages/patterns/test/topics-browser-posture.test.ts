import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type DeclaredTopicsBrowserPosture,
  type ServedBundle,
  type TopicsBrowserPosture,
  topicsBrowserPostureOf,
  type UndeclaredTopicsBrowserPosture,
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

/** Returns `posture` as a declared one, failing when it declares nothing. */
function declared(
  posture: TopicsBrowserPosture,
): DeclaredTopicsBrowserPosture {
  if (!posture.declared) {
    throw new Error(`Expected a declared posture: ${posture.reason}`);
  }
  return posture;
}

/** Returns `posture` as an undeclared one, failing when it declares a mode. */
function undeclared(
  posture: TopicsBrowserPosture,
): UndeclaredTopicsBrowserPosture {
  if (posture.declared) {
    throw new Error(`Expected an undeclared posture: ${posture.mode}`);
  }
  return posture;
}

describe("topicsBrowserPostureOf()", () => {
  it("returns `server-execution-off` when the toolshed and its shell both run off", () => {
    const posture = declared(topicsBrowserPostureOf({
      experimental: { serverExecution: false },
      shellServerExecutionDefine: "false",
    }));
    expect(posture.mode).toBe("server-execution-off");
    expect(posture.served).toBe(false);
    expect(posture.client).toBe(false);
    expect(posture.clientFrom).toBe("meta");
  });

  it("returns `server-execution-on` when the toolshed and its shell both run on", () => {
    const posture = declared(topicsBrowserPostureOf({
      experimental: { serverExecution: true },
      shellServerExecutionDefine: "true",
    }));
    expect(posture.mode).toBe("server-execution-on");
    expect(posture.clientFrom).toBe("meta");
  });

  it("reads the shell's posture from the bundle when the toolshed reports no baked define", () => {
    const posture = declared(topicsBrowserPostureOf(
      {
        experimental: { serverExecution: true },
        shellServerExecutionDefine: null,
      },
      bundleWith("true"),
    ));
    expect(posture.mode).toBe("server-execution-on");
    expect(posture.client).toBe(true);
    expect(posture.clientFrom).toBe("bundle");
  });

  it("returns an undeclared posture when a bundle was read and names no define", () => {
    const posture = undeclared(topicsBrowserPostureOf(
      { experimental: { serverExecution: false } },
      {
        kind: "read",
        servedByToolshed: true,
        source: "var somethingElse = 1;",
      },
    ));
    expect(posture.served).toBe(false);
    expect(posture.reason).toBe(
      "the toolshed names no baked define and the served shell's entry " +
        "script carries no define",
    );
  });

  it("returns an undeclared posture naming the reason when no bundle could be read", () => {
    const posture = undeclared(topicsBrowserPostureOf(
      {
        experimental: { serverExecution: true },
        shellServerExecutionDefine: null,
      },
      unreadable(true),
    ));
    expect(posture.served).toBe(true);
    expect(posture.reason).toBe(
      "the toolshed names no baked define and no served shell could be read " +
        "(`/scripts/index.js` gave 404)",
    );
  });

  it("returns `meta and bundle` when the toolshed's report and the served shell agree", () => {
    const posture = declared(topicsBrowserPostureOf(
      {
        experimental: { serverExecution: true },
        shellServerExecutionDefine: "true",
      },
      bundleWith("true"),
    ));
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
    const posture = declared(topicsBrowserPostureOf(
      { experimental: { serverExecution: true } },
      bundleWith("true", false),
    ));
    expect(posture.mode).toBe("server-execution-on");
    expect(posture.clientFrom).toBe("bundle");
  });

  it("returns an undeclared posture when only the toolshed names a define and another host serves the shell", () => {
    const posture = undeclared(topicsBrowserPostureOf(
      {
        experimental: { serverExecution: false },
        shellServerExecutionDefine: "false",
      },
      unreadable(false),
    ));
    expect(posture.served).toBe(false);
    expect(posture.reason).toBe(
      "the toolshed names a baked define for its own shell, but another " +
        "deployment serves the shell this run loads, and no served shell " +
        "could be read (`/scripts/index.js` gave 404)",
    );
  });

  it("uses the toolshed's report alone when it serves the shell whose script could not be read", () => {
    const posture = declared(topicsBrowserPostureOf(
      {
        experimental: { serverExecution: false },
        shellServerExecutionDefine: "false",
      },
      unreadable(true),
    ));
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
