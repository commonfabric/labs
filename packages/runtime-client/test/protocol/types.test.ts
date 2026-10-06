import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  type CellRefusedAnswer,
  type CellValueAnswer,
  ClientNotificationType,
  NotificationType,
  RequestType,
} from "@/protocol/types.ts";

// The runtime the rest of the repository describes has pieces, not pages. The
// protocol enums are the one place a wire value can drift away from that
// vocabulary without a compile error, because a value is a string and a member
// name is only read by people.
const PAGE = /page/i;

// Every operation addressed to one piece. Their wire values share the `piece:`
// namespace, so a member renamed without its value shows up here.
const PIECE_OPERATIONS = [
  RequestType.PieceCreate,
  RequestType.PieceGet,
  RequestType.PieceGetSlug,
  RequestType.PieceRemove,
  RequestType.PieceStart,
  RequestType.PieceStop,
  RequestType.PieceGetAll,
  RequestType.PieceSynced,
  RequestType.PieceGetSource,
  RequestType.PieceGetSourceRevision,
  RequestType.PieceClone,
  RequestType.PieceUpdateSource,
];

describe("types", () => {
  describe("RequestType", () => {
    it("declares no member named after a page", () => {
      expect(Object.keys(RequestType).filter((name) => PAGE.test(name)))
        .toEqual([]);
    });

    it("declares no wire value named after a page", () => {
      expect(Object.values(RequestType).filter((value) => PAGE.test(value)))
        .toEqual([]);
    });

    it("gives every piece operation a wire value in the `piece:` namespace", () => {
      expect(PIECE_OPERATIONS.filter((value) => !value.startsWith("piece:")))
        .toEqual([]);
    });
  });

  describe("NotificationType", () => {
    it("declares no member named after a page", () => {
      expect(Object.keys(NotificationType).filter((name) => PAGE.test(name)))
        .toEqual([]);
    });

    it("declares no wire value named after a page", () => {
      expect(
        Object.values(NotificationType).filter((value) => PAGE.test(value)),
      ).toEqual([]);
    });
  });

  describe("ClientNotificationType", () => {
    it("declares no member named after a page", () => {
      expect(
        Object.keys(ClientNotificationType).filter((name) => PAGE.test(name)),
      ).toEqual([]);
    });

    it("declares no wire value named after a page", () => {
      expect(
        Object.values(ClientNotificationType).filter((value) =>
          PAGE.test(value)
        ),
      ).toEqual([]);
    });
  });
});

describe("a read's answer", () => {
  it("is a value or a refusal, never both", () => {
    // Checked by the compiler: each of these fails to type-check, which the
    // `@ts-expect-error` above it requires. The bodies run only so that the
    // answers are used.
    const refusal = { refusedBy: "display-ceiling" } as const;
    // @ts-expect-error A refusal carries no value.
    const both: CellValueAnswer | CellRefusedAnswer = {
      value: "shown",
      refused: refusal,
    };
    const labeled: CellRefusedAnswer = {
      refused: refusal,
      // @ts-expect-error A refusal carries no label view.
      cfcLabel: { version: 1, entries: [] },
    };
    // @ts-expect-error A value is never also a refusal.
    const valued: CellValueAnswer = { value: "shown", refused: refusal };

    expect([both, labeled, valued]).toHaveLength(3);
  });
});
