import {
  action,
  assert,
  handler,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";

import {
  changeSharedSpaceMembershipIn,
  markSharedSpaceDeletedIn,
  registerSharedSpaceIn,
  removeSharedSpaceIn,
  retitleSharedSpaceIn,
  type SharedSpaceCatalogStorage,
  type SharedSpaceProfileStorage,
} from "./shared-space-catalog.ts";

const ROOM = "did:key:refusals-room";
const DELETED = "did:key:refusals-deleted";
const MIXED = "did:key:refusals-mixed";
const PROFILE = "did:key:refusals-profile";
const HOST = "https://room.example";

/** Which catalog operation an attempt runs. */
type Operation = "register" | "choose" | "mark" | "retitle" | "remove";

/** What one attempt returned, or the message of what it threw. */
interface Outcome {
  status?: string;
  reason?: string;
  error?: string;
}

/**
 * Runs one catalog operation from a handler, as Home's handlers do, and
 * records under `label` what it returned or the message of what it threw.
 * `input` is
 * whatever the caller sent, well formed or not, since what is under test is
 * how each operation refuses what it cannot accept. `broken` runs it against
 * a catalog that holds a malformed entry, and `profiles` hands a registration
 * a recorder whose records are malformed.
 */
const attempt = handler<
  {
    label: string;
    op: Operation;
    // deno-lint-ignore no-explicit-any
    input: any;
    broken?: boolean;
    profiles?: boolean;
  },
  {
    catalog: Writable<SharedSpaceCatalogStorage>;
    malformed: Writable<SharedSpaceCatalogStorage>;
    records: Writable<SharedSpaceProfileStorage>;
    outcomes: Writable<Record<string, Outcome>>;
  }
>(({ label, op, input, broken, profiles }, {
  catalog,
  malformed,
  records,
  outcomes,
}) => {
  const target = broken ? malformed : catalog;
  try {
    const result = op === "register"
      ? registerSharedSpaceIn(
        target,
        input,
        profiles ? { records, standing: () => "live" } : undefined,
      )
      : op === "choose"
      ? changeSharedSpaceMembershipIn(target, input)
      : op === "mark"
      ? markSharedSpaceDeletedIn(target, input)
      : op === "retitle"
      ? retitleSharedSpaceIn(target, input)
      : removeSharedSpaceIn(target, input);
    outcomes.key(label).set(
      "reason" in result
        ? { status: result.status, reason: result.reason }
        : { status: result.status },
    );
  } catch (error) {
    outcomes.key(label).set({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/** What the attempt labeled `label` recorded, if it ran. */
const outcomeOf = (
  outcomes: Writable<Record<string, Outcome>>,
  label: string,
): Outcome | undefined => outcomes.get()[label];

export default pattern(() => {
  const catalog = new Writable<SharedSpaceCatalogStorage>({
    entries: {
      [ROOM]: {
        space: ROOM,
        host: HOST,
        kind: "loom",
        state: "saved",
        revision: "1:room",
      },
      // A state this writer does not understand, which a membership choice
      // and a deletion mark both leave alone.
      [DELETED]: {
        space: DELETED,
        host: HOST,
        kind: "loom",
        state: "deleted",
        revision: "2:deleted",
      },
      // A last action that disagrees with the entry's state.
      [MIXED]: {
        space: MIXED,
        host: HOST,
        kind: "loom",
        state: "saved",
        revision: "2:mixed",
        lastAction: {
          id: "old",
          expectedRevision: "1:mixed",
          state: "archived",
        },
      },
    },
    offers: {},
  });
  // A stored host that is not a bare origin makes the whole catalog invalid.
  const malformed = new Writable<SharedSpaceCatalogStorage>({
    entries: {
      [ROOM]: {
        space: ROOM,
        host: "ftp://room.example",
        kind: "loom",
        state: "saved",
        revision: "1:room",
      },
    },
    offers: {},
  });
  // Records keyed by space are an object; a list is not.
  const records = new Writable<SharedSpaceProfileStorage>([]);
  const outcomes = new Writable<Record<string, Outcome>>({});
  const run = attempt({ catalog, malformed, records, outcomes });

  const registration = { space: ROOM, host: HOST, kind: "loom" };
  const notAnOffer = "not an offer";

  const action_register_refusals = action(() => {
    run.send({
      label: "offer-without-sender",
      op: "register",
      input: { ...registration, offer: { from: "not-a-did", id: "x" } },
    });
    run.send({
      label: "offer-not-object",
      op: "register",
      input: { ...registration, offer: notAnOffer },
    });
    run.send({
      label: "host-not-http",
      op: "register",
      input: { ...registration, host: "ftp://room.example" },
    });
    run.send({
      label: "host-unparsable",
      op: "register",
      input: { ...registration, host: "http://[room" },
    });
    run.send({
      label: "catalog-malformed",
      op: "register",
      input: registration,
      broken: true,
    });
    run.send({
      label: "profile-records-malformed",
      op: "register",
      input: { ...registration, profile: PROFILE },
      profiles: true,
    });
  });
  const assert_register_refusals = assert(() =>
    outcomeOf(outcomes, "offer-without-sender")?.error ===
      "Catalog offer requires a sender DID and stable ID." &&
    outcomeOf(outcomes, "offer-not-object")?.error ===
      "Invalid shared-space offer identity." &&
    outcomeOf(outcomes, "host-not-http")?.error ===
      "Space host must contain only an HTTP or HTTPS origin." &&
    outcomeOf(outcomes, "host-unparsable")?.error ===
      "Invalid space host URL." &&
    outcomeOf(outcomes, "catalog-malformed")?.error ===
      "The shared-space catalog is unavailable or malformed." &&
    outcomeOf(outcomes, "profile-records-malformed")?.error ===
      "The records of the profile acting in each social space are " +
        "unavailable or malformed."
  );

  const action_choice_refusals = action(() => {
    run.send({
      label: "choice-invalid",
      op: "choose",
      input: {
        space: "not-a-did",
        id: "a",
        expectedRevision: "1:room",
        state: "archived",
      },
    });
    run.send({
      label: "choice-unsupported",
      op: "choose",
      input: {
        space: DELETED,
        id: "b",
        expectedRevision: "2:deleted",
        state: "saved",
      },
    });
    run.send({
      label: "choice-mixed",
      op: "choose",
      input: {
        space: MIXED,
        id: "c",
        expectedRevision: "2:mixed",
        state: "archived",
      },
    });
  });
  const assert_choice_refusals = assert(() => {
    const invalid = outcomeOf(outcomes, "choice-invalid");
    const unsupported = outcomeOf(outcomes, "choice-unsupported");
    const mixed = outcomeOf(outcomes, "choice-mixed");
    return invalid?.error === "Invalid shared-space membership action." &&
      unsupported?.status === "conflict" &&
      unsupported.reason === "unsupported-state" &&
      mixed?.status === "conflict" && mixed.reason === "action";
  });

  const action_other_refusals = action(() => {
    run.send({
      label: "mark-invalid",
      op: "mark",
      input: { space: "not-a-did", expectedRevision: "1:room" },
    });
    run.send({
      label: "mark-deleted",
      op: "mark",
      input: { space: DELETED, expectedRevision: "2:deleted" },
    });
    run.send({
      label: "retitle-invalid",
      op: "retitle",
      input: { space: "not-a-did", title: "Room" },
    });
    run.send({
      label: "removal-invalid",
      op: "remove",
      input: { space: ROOM, expectedRevision: "" },
    });
  });
  const assert_other_refusals = assert(() => {
    const invalidMark = outcomeOf(outcomes, "mark-invalid");
    const deletedMark = outcomeOf(outcomes, "mark-deleted");
    const invalidRetitle = outcomeOf(outcomes, "retitle-invalid");
    const invalidRemoval = outcomeOf(outcomes, "removal-invalid");
    return invalidMark?.error === "Invalid shared-space deletion mark." &&
      deletedMark?.status === "conflict" &&
      deletedMark.reason === "unsupported-state" &&
      invalidRetitle?.error === "Invalid shared-space retitle." &&
      invalidRemoval?.error === "Invalid shared-space removal.";
  });

  // None of the refusals wrote anything.
  const assert_catalog_unchanged = assert(() => {
    const entries = catalog.get().entries;
    return Object.keys(entries).length === 3 &&
      entries[ROOM]?.state === "saved" &&
      entries[ROOM]?.revision === "1:room" &&
      entries[DELETED]?.state === "deleted" &&
      entries[MIXED]?.revision === "2:mixed" &&
      Object.keys(catalog.get().offers).length === 0;
  });

  return {
    [TESTS]: [
      { action: action_register_refusals },
      { assertion: assert_register_refusals },
      { action: action_choice_refusals },
      { assertion: assert_choice_refusals },
      { action: action_other_refusals },
      { assertion: assert_other_refusals },
      { assertion: assert_catalog_unchanged },
    ],
  };
});
