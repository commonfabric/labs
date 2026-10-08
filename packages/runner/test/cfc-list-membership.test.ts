import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cfcAtom } from "@commonfabric/api/cfc";
import {
  listedInEntries,
  type ListEntryView,
  listMembersInConfidentiality,
} from "../src/cfc/list-membership.ts";

const ALICE = "did:key:alice";
const DANIEL = "did:key:daniel";
const EVE = "did:key:eve";
const LIVE = { space: "did:key:share", id: "of:live", path: ["liveList"] };
const OTHER = { space: "did:key:share", id: "of:live", path: ["other"] };
const SUBJECT = { digestOf: "sha256:home" };

/** An entry as the pinning primitive writes it: `[User(p) ∨ User(alice)]`. */
const pinned = (principal: string): ListEntryView => ({
  principal,
  label: [{ anyOf: [cfcAtom.user(principal), cfcAtom.user(ALICE)] }],
});

describe("listedInEntries (spec §4.9.5)", () => {
  it("lists a principal through a pinned entry naming them", () => {
    const entries = [pinned(DANIEL), pinned(ALICE)];
    expect(listedInEntries(DANIEL, entries)).toBe(true);
    expect(listedInEntries(ALICE, entries)).toBe(true);
  });

  it("does not list a principal no entry names", () => {
    expect(listedInEntries(EVE, [pinned(DANIEL), pinned(ALICE)])).toBe(false);
    expect(listedInEntries(DANIEL, [])).toBe(false);
  });

  it("does not list through an entry whose label does not admit them", () => {
    // An entry computed from data Daniel cannot read carries that data's
    // label; seeing a value released to the list would disclose the bit.
    const computed: ListEntryView = {
      principal: DANIEL,
      label: [cfcAtom.user(ALICE)],
    };
    expect(listedInEntries(DANIEL, [computed])).toBe(false);
  });

  it("requires every clause of the entry's label to admit the principal", () => {
    const twoClauses: ListEntryView = {
      principal: DANIEL,
      label: [cfcAtom.user(DANIEL), cfcAtom.user(ALICE)],
    };
    expect(listedInEntries(DANIEL, [twoClauses])).toBe(false);
  });

  it("lists through an unlabelled entry, which carries nothing", () => {
    expect(listedInEntries(DANIEL, [{ principal: DANIEL, label: [] }]))
      .toBe(true);
  });

  it("does not list through an entry of any other shape", () => {
    // Delegation to another list and space entries are deferred, so they
    // resolve nothing.
    const nested: ListEntryView = { principal: undefined, label: [] };
    expect(listedInEntries(DANIEL, [nested])).toBe(false);
  });
});

describe("listMembersInConfidentiality (spec §4.9.5 candidates)", () => {
  it("names each list a Members atom of the label names, once, in order", () => {
    const confidentiality = [
      { anyOf: [cfcAtom.user(ALICE), cfcAtom.members(LIVE, SUBJECT)] },
      cfcAtom.members(OTHER, SUBJECT),
      cfcAtom.members(LIVE, SUBJECT),
    ];
    expect(listMembersInConfidentiality(confidentiality)).toEqual([
      LIVE,
      OTHER,
    ]);
  });

  it("names no list for a label without Members atoms", () => {
    expect(listMembersInConfidentiality([cfcAtom.user(ALICE)])).toEqual([]);
  });

  it("skips a Members atom whose list is not a position", () => {
    expect(
      listMembersInConfidentiality([{
        type: "https://commonfabric.org/cfc/atom/Members",
        list: "of:live",
        subject: SUBJECT,
      }]),
    ).toEqual([]);
  });
});
