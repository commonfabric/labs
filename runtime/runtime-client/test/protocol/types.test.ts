import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { isErrorNotification } from "@/protocol/guards.ts";
import {
  type CellRefusedAnswer,
  type CellValueAnswer,
  ClientNotificationType,
  type ErrorNotification,
  NotificationType,
  RequestType,
  RuntimeErrorCode,
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

describe("an error report's write uncertainty", () => {
  it("requires a boolean for an update-required report", () => {
    const report = {
      type: NotificationType.ErrorReport,
      code: RuntimeErrorCode.ClientUpdateRequired,
      message: "Reload this runtime",
    } as const;
    for (const unconfirmedWrites of [true, false]) {
      const notice: ErrorNotification = { ...report, unconfirmedWrites };
      expect(isErrorNotification(notice)).toBe(true);
    }
    // @ts-expect-error Update-required reports must describe write uncertainty.
    const missing: ErrorNotification = report;
    expect(isErrorNotification(missing)).toBe(false);
    expect(isErrorNotification({ ...report, unconfirmedWrites: "false" }))
      .toBe(false);
  });

  it("refuses write uncertainty on unrelated or uncoded reports", () => {
    const report = {
      type: NotificationType.ErrorReport,
      message: "Something failed",
    } as const;
    const unrelated = {
      ...report,
      code: RuntimeErrorCode.CompilerStackLoadFailed,
    } as const;
    expect(isErrorNotification(report)).toBe(true);
    expect(isErrorNotification(unrelated)).toBe(true);
    // @ts-expect-error Write uncertainty requires the update-required code.
    const uncoded: ErrorNotification = { ...report, unconfirmedWrites: true };
    // @ts-expect-error A compiler error cannot carry update-required recovery.
    const contradictory: ErrorNotification = {
      ...unrelated,
      unconfirmedWrites: false,
    };
    expect(isErrorNotification(uncoded)).toBe(false);
    expect(isErrorNotification(contradictory)).toBe(false);
  });
});
