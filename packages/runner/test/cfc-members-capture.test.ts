import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cfcAtom, type CfcListPosition } from "@commonfabric/api/cfc";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { commitCfcFieldValue } from "../src/cfc/label-representation.ts";
import {
  authorsMembersAtom,
  membersCaptureClause,
  type MembersCaptureInput,
  type MembersCaptureReads,
  sealAuthoredMembersClause,
} from "../src/cfc/members-capture.ts";

const ALICE = "did:key:alice";
const EVE = "did:key:eve";
const SHARE = "did:key:share";
const SHARED_HOME = "did:key:shared-home";
const MODULE = "sha256:location";
const OTHER_MODULE = "sha256:weather";
const RESULT = "of:live-result";
const OUTPUT = "of:live-where";

const LIST: CfcListPosition = { space: SHARE, id: RESULT, path: ["liveList"] };
const FAMILY: CfcListPosition = { space: SHARE, id: "of:family", path: [] };

const policy = (subject: string | { digestOf: string }, module = MODULE) =>
  cfcAtom.modulePolicyRef(module, "locationRules", "sha256:digest", subject);

/** Alice's Home is her own DID, owned by her alone. */
const owners: Record<string, readonly string[]> = {
  [ALICE]: [ALICE],
  [EVE]: [EVE],
  [SHARED_HOME]: [ALICE, EVE],
};

type World = {
  runs: Record<
    string,
    { resultSpace: string; resultId: string; moduleIdentity: string }
  >;
  positions: Array<
    [CfcListPosition, { owners: readonly string[]; declaresWriter: boolean }]
  >;
  links: Array<[CfcListPosition, CfcListPosition]>;
};

const world = (overrides: Partial<World> = {}): World => ({
  runs: overrides.runs ??
    { [OUTPUT]: { resultSpace: SHARE, resultId: RESULT, moduleIdentity: MODULE } },
  positions: overrides.positions ??
    [[LIST, { owners: [ALICE], declaresWriter: true }]],
  links: overrides.links ?? [],
});

const readsOf = (state: World): MembersCaptureReads => ({
  owners: (space) => owners[space],
  runOf: (document) => state.runs[document.id],
  position: (position) =>
    state.positions.find(([held]) => deepEqual(held, position))?.[1],
  linkTarget: (position) =>
    state.links.find(([held]) => deepEqual(held, position))?.[1] ?? "none",
});

const input = (
  overrides: Partial<MembersCaptureInput> = {},
): MembersCaptureInput => ({
  actingPrincipal: ALICE,
  members: "/liveList",
  target: { space: SHARE, id: OUTPUT },
  flowConfidentiality: [policy(commitCfcFieldValue(ALICE))],
  ...overrides,
});

const refusal = (
  overrides: Partial<MembersCaptureInput> = {},
  state: World = world(),
) => {
  const result = membersCaptureClause(input(overrides), readsOf(state));
  return "refusal" in result ? result.refusal : undefined;
};

describe("membersCaptureClause (spec §8.7.5)", () => {
  it("admits the owner's list for her committed Home subject", () => {
    const committed = commitCfcFieldValue(ALICE);
    expect(membersCaptureClause(input(), readsOf(world()))).toEqual({
      clause: {
        anyOf: expect.arrayContaining([
          cfcAtom.user(ALICE),
          cfcAtom.members(LIST, committed),
        ]),
      },
    });
  });

  it("admits a plaintext subject the actor solely owns", () => {
    expect(refusal({ flowConfidentiality: [policy(ALICE)] })).toBeUndefined();
  });

  it("refuses a run acting for no principal", () => {
    expect(refusal({ actingPrincipal: undefined })).toMatch(/acting for/);
  });

  it("refuses a members value that is not a pointer", () => {
    expect(refusal({ members: "liveList" })).toMatch(/pointer/);
  });

  it("refuses a stranger, who does not own the subject", () => {
    expect(refusal({ actingPrincipal: EVE })).toMatch(/solely owns/);
  });

  it("refuses a co-owned subject for either owner", () => {
    const shared = { flowConfidentiality: [policy(SHARED_HOME)] };
    expect(refusal(shared)).toMatch(/solely owns/);
    expect(refusal({ ...shared, actingPrincipal: EVE })).toMatch(/solely owns/);
  });

  it("refuses an output carrying no module-policy clause", () => {
    expect(refusal({ flowConfidentiality: [] })).toMatch(/solely owns/);
  });

  it("refuses an output carrying two clauses the actor solely owns", () => {
    expect(
      refusal({
        flowConfidentiality: [policy(ALICE), policy(ALICE, OTHER_MODULE)],
      }),
    ).toMatch(/exactly one/);
  });

  it("refuses an output outside a run of the module the policy names", () => {
    // Another of Alice's patterns reuses the transformation: its run is of
    // a different module.
    const reused = world({
      runs: {
        [OUTPUT]: {
          resultSpace: SHARE,
          resultId: RESULT,
          moduleIdentity: OTHER_MODULE,
        },
      },
    });
    expect(refusal({}, reused)).toMatch(/run of the module/);
    expect(refusal({}, world({ runs: {} })))
      .toMatch(/run of the module/);
  });

  it("refuses an output whose run's result is in another space", () => {
    const elsewhere = world({
      runs: {
        [OUTPUT]: {
          resultSpace: "did:key:elsewhere",
          resultId: RESULT,
          moduleIdentity: MODULE,
        },
      },
    });
    expect(refusal({}, elsewhere)).toMatch(/run of the module/);
  });

  it("refuses an output outside the space scope", () => {
    expect(refusal({ target: { space: SHARE, id: OUTPUT, scope: "user" } }))
      .toMatch(/space-scoped/);
    expect(refusal({ target: { space: SHARE, id: OUTPUT, scope: "space" } }))
      .toBeUndefined();
  });

  it("refuses a list position someone else owns", () => {
    const evesList = world({
      positions: [[LIST, { owners: [EVE], declaresWriter: true }]],
    });
    expect(refusal({}, evesList)).toMatch(/owns that declares/);
  });

  it("refuses a list position that declares no writers", () => {
    const unguarded = world({
      positions: [[LIST, { owners: [ALICE], declaresWriter: false }]],
    });
    expect(refusal({}, unguarded)).toMatch(/owns that declares/);
  });

  it("follows a link at the position only to a list the actor owns", () => {
    const linkedToOwn = world({
      positions: [
        [LIST, { owners: [ALICE], declaresWriter: true }],
        [FAMILY, { owners: [ALICE], declaresWriter: true }],
      ],
      links: [[LIST, FAMILY]],
    });
    expect(refusal({}, linkedToOwn)).toBeUndefined();
    const linkedToEve = world({
      positions: [
        [LIST, { owners: [ALICE], declaresWriter: true }],
        [FAMILY, { owners: [EVE], declaresWriter: true }],
      ],
      links: [[LIST, FAMILY]],
    });
    expect(refusal({}, linkedToEve)).toMatch(/links to/);
  });
});

describe("sealAuthoredMembersClause", () => {
  it("seals a schema-authored clause that names a list", () => {
    const authored = { anyOf: [cfcAtom.user(EVE), cfcAtom.members(LIST, ALICE)] };
    expect(sealAuthoredMembersClause(authored)).toEqual({ anyOf: [] });
    expect(sealAuthoredMembersClause(cfcAtom.members(LIST, ALICE)))
      .toEqual({ anyOf: [] });
  });

  it("leaves a clause without a list as it is", () => {
    expect(sealAuthoredMembersClause(cfcAtom.user(EVE)))
      .toEqual(cfcAtom.user(EVE));
  });
});

describe("authorsMembersAtom", () => {
  it("finds a Members atom authored flat or as an alternative", () => {
    const members = cfcAtom.members(LIST, ALICE);
    expect(authorsMembersAtom([members])).toBe(true);
    expect(authorsMembersAtom([{ anyOf: [cfcAtom.user(ALICE), members] }]))
      .toBe(true);
  });

  it("finds none in a label without one", () => {
    expect(authorsMembersAtom([cfcAtom.user(ALICE)])).toBe(false);
  });
});
