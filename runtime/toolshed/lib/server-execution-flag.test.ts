import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import {
  memoryAclPrincipalsFor,
  serverExecutionEnabledFromEnv,
} from "@/lib/server-execution-flag.ts";

// The toolshed process's ONE flag resolution (server-execution v2 Phase 7,
// the flip): unset means the FIRST-PARTY DEFAULT — the value of
// `SERVER_EXECUTION_DEFAULT_ENABLED`, whichever it is — and an explicit
// "false" is the OFF arm and an explicit "true" the ON arm. Tests pin the
// contract against the constant rather than duplicating its current value,
// so a deliberate default change stays a one-value edit while CI exercises
// both resolved roles.

const envOf = (values: Record<string, string | undefined>) => (name: string) =>
  values[name];

describe("serverExecutionEnabledFromEnv", () => {
  it("resolves an UNSET flag to the first-party default", () => {
    expect(serverExecutionEnabledFromEnv(envOf({}))).toBe(
      SERVER_EXECUTION_DEFAULT_ENABLED,
    );
  });

  it("honors an explicit value either way so both CI arms stay selectable", () => {
    expect(
      serverExecutionEnabledFromEnv(
        envOf({ EXPERIMENTAL_SERVER_EXECUTION: "false" }),
      ),
    ).toBe(false);
    expect(
      serverExecutionEnabledFromEnv(
        envOf({ EXPERIMENTAL_SERVER_EXECUTION: "true" }),
      ),
    ).toBe(true);
  });

  it("garbage reads as unset (the canonical mapping's warn-and-ignore), so it resolves to the default", () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      expect(
        serverExecutionEnabledFromEnv(
          envOf({ EXPERIMENTAL_SERVER_EXECUTION: "yes" }),
        ),
      ).toBe(SERVER_EXECUTION_DEFAULT_ENABLED);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("memoryAclPrincipalsFor", () => {
  // OW31 (RULED 2026-08-18/19): the process identity is a DELEGATING principal
  // under the flag (session-level acting-as-owner READ binding; ACL-only
  // service reads), NEVER an OWNER-class service DID by default — the
  // operator's configured list is verbatim on BOTH arms, retiring the Phase-7
  // implicit-OWNER blanket.

  const me = "did:key:z6MkToolshedProcess";
  const operator = "did:key:z6MkOperator";

  it("OFF the flag: the configured list byte-identical, and an EMPTY delegating list (the binding is unreachable)", () => {
    expect(
      memoryAclPrincipalsFor({
        configured: [operator],
        processIdentityDid: me,
        serverExecution: false,
      }),
    ).toEqual({ serviceDids: [operator], delegatingDids: [] });
    expect(
      memoryAclPrincipalsFor({
        configured: [],
        processIdentityDid: me,
        serverExecution: false,
      }),
    ).toEqual({ serviceDids: [], delegatingDids: [] });
  });

  it("ON: the process identity is DELEGATING and — the absolute pin — NOT an OWNER-class service DID unless the operator configured it", () => {
    expect(
      memoryAclPrincipalsFor({
        configured: [operator],
        processIdentityDid: me,
        serverExecution: true,
      }),
    ).toEqual({ serviceDids: [operator], delegatingDids: [me] });
    // The absolute pin (OW31's guard against creep): under ON the
    // process identity is not an OWNER-class service DID by default.
    expect(
      memoryAclPrincipalsFor({
        configured: [operator],
        processIdentityDid: me,
        serverExecution: true,
      }).serviceDids,
    ).not.toContain(me);
  });

  it("operator-configured OWNER-class listing of the process identity is kept VERBATIM (scope report flag F1: explicit configuration wins; the route logs the combination)", () => {
    expect(
      memoryAclPrincipalsFor({
        configured: [me, operator],
        processIdentityDid: me,
        serverExecution: true,
      }),
    ).toEqual({ serviceDids: [me, operator], delegatingDids: [me] });
  });
});
