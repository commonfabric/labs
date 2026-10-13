import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  DEFAULT_ROUTED_HOST_LIMITS,
  routedHostLimits,
  routedHostLimitsFor,
} from "../v2/routed-host.ts";

describe("routed-host-limits", () => {
  it("uses defaults for omitted fields and preserves explicit disabled quotas", () => {
    expect(routedHostLimits()).toEqual(DEFAULT_ROUTED_HOST_LIMITS);
    for (const key of Object.keys(DEFAULT_ROUTED_HOST_LIMITS)) {
      if (key === "frameSlots") continue;
      expect(routedHostLimitsFor({ [key]: null }, 1)).toEqual({
        ...DEFAULT_ROUTED_HOST_LIMITS,
        [key]: null,
      });
    }
    expect(routedHostLimits({ viewsPerSession: 100, holdingsPerSession: 9000 }))
      .toMatchObject({ viewsPerSession: 100, holdingsPerSession: 9000 });
  });

  it("allows a disabled inner quota alongside an enabled aggregate", () => {
    expect(routedHostLimitsFor({
      contextsPerLink: null,
      sockets: 2,
      tickets: 1,
      principalsPerContext: null,
      principalHistoryPerContext: null,
      proofsPerContext: 1,
      sessionsPerContext: null,
      sessionsPerRouter: 1,
      watchesPerSession: null,
      watchesPerContext: 1,
      holdingsPerContext: null,
      holdingsPerRouter: 1,
    }, 2)).toMatchObject({
      contextsPerLink: null,
      sockets: 2,
      proofsPerContext: 1,
      sessionsPerRouter: 1,
      watchesPerContext: 1,
      holdingsPerRouter: 1,
    });
  });

  it("defaults the lifetime space quota independently of the session quota", () => {
    expect(routedHostLimits({ sessionsPerContext: 1 })).toMatchObject({
      sessionsPerContext: 1,
      spacesPerContext: 1200,
    });
    expect(routedHostLimits({ spacesPerContext: 1 })).toMatchObject({
      sessionsPerContext: 1200,
      spacesPerContext: 1,
    });
    expect(routedHostLimits({ spacesPerContext: null })).toMatchObject({
      sessionsPerContext: 1200,
      spacesPerContext: null,
    });
  });

  it("rejects malformed overrides and non-positive or unsafe quota values", () => {
    for (const value of [null, [], false, 1, "limits"]) {
      expect(() => routedHostLimits(value)).toThrow("invalid routed limits");
    }
    for (const key of Object.keys(DEFAULT_ROUTED_HOST_LIMITS)) {
      for (
        const value of [
          0,
          -1,
          1.5,
          Number.MAX_SAFE_INTEGER + 1,
          Infinity,
          NaN,
          "1",
          true,
          [],
          {},
          undefined,
        ]
      ) {
        expect(() => routedHostLimits({ [key]: value })).toThrow(
          `invalid routed limit: ${key}`,
        );
      }
    }
    expect(() => routedHostLimits({ frameSlots: null })).toThrow(
      "invalid routed limit: frameSlots",
    );
    expect(() => routedHostLimits({ unknownQuota: null })).toThrow(
      "invalid routed limit: unknownQuota",
    );
    expect(routedHostLimits({ frameSlots: Number.MAX_SAFE_INTEGER }).frameSlots)
      .toBe(Number.MAX_SAFE_INTEGER);
  });

  it("continues to validate enabled nested limits", () => {
    expect(() =>
      routedHostLimits({
        sessionsPerContext: 3,
        sessionsPerRouter: 2,
        sessionsPerToolshed: null,
      })
    ).toThrow("invalid routed limit: sessionsPerContext");
    expect(() =>
      routedHostLimitsFor({
        contextsPerLink: 2,
        sockets: 5,
        tickets: null,
      }, 2)
    ).toThrow("invalid routed limit: sockets");
  });
});
