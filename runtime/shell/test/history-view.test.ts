// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";

import type { PatternChange, SpaceHistoryStep } from "../src/lib/runtime.ts";
import type { Command } from "../src/views/BaseView.ts";
import type { PatternRestore, XHistoryView } from "../src/views/HistoryView.ts";
import { installBrowserGlobals } from "./browser-globals.ts";
import { templateListeners, templateMarkup } from "./lit-template-markup.ts";

describe("XHistoryView", () => {
  const space = "did:key:z6Mk-shell-history-view" as DID;

  /** One stretch of history, as the runtime returns it. */
  type Page = { steps: SpaceHistoryStep[]; next?: number };

  /** A piece a listing names beside those the space lists. */
  type NamedPiece = { id: string; scope?: PatternChange["scope"] };

  /** A view under test, and what it has asked of the world around it. */
  interface Mounted {
    view: XHistoryView;

    /** The `before` of each listing the view asked the runtime for. */
    listings: (number | undefined)[];

    /** The pieces each listing named to the runtime, beside `before`. */
    pieces: (readonly NamedPiece[] | undefined)[];

    /** The commands the view sent. */
    commands: Command[];

    /**
     * Tells the view which of `names` changed, as Lit does before an update,
     * and resolves with the markup of the first render `holds` is true of.
     */
    update(
      names: string[],
      holds: (markup: string) => boolean,
    ): Promise<string>;

    /**
     * Calls `act`, and resolves with the markup of the first render `holds`
     * is true of.
     */
    until(act: () => void, holds: (markup: string) => boolean): Promise<string>;

    /** Returns the view's markup as it stands. */
    markup(): string;
  }

  let restoreGlobals: () => void;
  let HistoryView: typeof XHistoryView;
  let commandEvent: string;

  beforeEach(async () => {
    restoreGlobals = installBrowserGlobals("http://localhost:8000/");
    ({ XHistoryView: HistoryView } = await import(
      "../src/views/HistoryView.ts"
    ));
    ({ SHELL_COMMAND: commandEvent } = await import(
      "../src/views/BaseView.ts"
    ));
  });

  afterEach(() => restoreGlobals());

  /** When every step and change of these cases was made, unless it says. */
  const AT = "2026-03-01T12:00:00.000Z";

  /** A settled `write` step numbered `seq`, with `patternChanges`. */
  function step(
    seq: number,
    patternChanges: PatternChange[] = [],
  ): SpaceHistoryStep {
    return {
      seq,
      startSeq: seq,
      at: AT,
      kind: "write",
      events: 0,
      writes: 1,
      settled: true,
      patternChanges,
    };
  }

  /** A change of the piece `pieceId` to the revision `revisionId`. */
  function change(
    pieceId: string,
    revisionId: string,
    extra: Partial<PatternChange> = {},
  ): PatternChange {
    return {
      pieceId,
      revisionId,
      madeAt: Date.parse(AT),
      operation: "edit",
      label: "Direct source edit",
      pattern: { identity: `identity-of-${revisionId}`, symbol: "default" },
      originLabel: "Detached",
      current: false,
      ...extra,
    };
  }

  /**
   * Builds a view of `space` over a runtime whose history is what `list`
   * returns for each listing. The view is never connected, so nothing
   * renders it: Lit's request for an update is where a case learns that
   * the view's state moved.
   */
  function mount(list: (before?: number) => Promise<Page>): Mounted {
    const listings: (number | undefined)[] = [];
    const pieces: (readonly NamedPiece[] | undefined)[] = [];
    let moved = () => {};
    class Observed extends HistoryView {
      override requestUpdate(...args: unknown[]): void {
        super.requestUpdate(...args as []);
        moved();
      }
    }
    const view = new Observed();
    // A history is all these cases ask of the runtime.
    view.rt = {
      spaceHistory: (
        _space: DID,
        before?: number,
        ids?: readonly NamedPiece[],
      ) => {
        listings.push(before);
        pieces.push(ids);
        return list(before);
      },
    } as XHistoryView["rt"];
    view.space = space;
    const commands: Command[] = [];
    view.addEventListener(commandEvent, (event) => {
      commands.push((event as CustomEvent<Command>).detail);
    });
    const markup = () =>
      templateMarkup(view.render(), { elideListeners: true });
    const until: Mounted["until"] = (act, holds) => {
      const held = Promise.withResolvers<string>();
      moved = () => {
        const now = markup();
        if (holds(now)) held.resolve(now);
      };
      act();
      moved();
      return held.promise;
    };
    return {
      view,
      listings,
      pieces,
      commands,
      markup,
      until,
      update: (names, holds) =>
        until(
          () =>
            (view as unknown as {
              willUpdate(changed: Map<string, unknown>): void;
            }).willUpdate(new Map(names.map((name) => [name, undefined]))),
          holds,
        ),
    };
  }

  /** Mounts a view whose one stretch of history is `steps`, and lists it. */
  async function listed(steps: SpaceHistoryStep[]): Promise<Mounted> {
    const mounted = mount(() => Promise.resolve({ steps }));
    await mounted.update(
      ["rt", "space"],
      (markup) => markup.includes(`data-seq="${steps[0].seq}"`),
    );
    return mounted;
  }

  /**
   * Returns the part of `markup` that renders the change to `revisionId`: from
   * its element's opening tag to the next change's, or to the end of its step.
   */
  function changeMarkup(markup: string, revisionId: string): string {
    const opening = 'class="pattern-change"';
    const at = markup.indexOf(`data-revision="${revisionId}"`);
    if (at === -1) throw new Error(`No change to ${revisionId} is rendered.`);
    const start = markup.lastIndexOf(opening, at);
    const next = markup.indexOf(opening, at);
    const end = markup.indexOf("</li>", at);
    return markup.slice(start, next !== -1 && next < end ? next : end);
  }

  /**
   * Clicks the `cf-button` of class `name` that is `nth` among those the view
   * renders.
   */
  function click(view: XHistoryView, name: string, nth = 0): void {
    const buttons = templateListeners(view.render(), "click", view).filter((
      { tag },
    ) => tag.startsWith("<cf-button") && tag.includes(`class="${name}"`));
    buttons[nth].dispatch(new Event("click"));
  }

  describe("a step's pattern changes", () => {
    it("renders none for a step that recorded none", async () => {
      const { markup } = await listed([step(4)]);

      expect(markup()).toContain('data-seq="4"');
      expect(markup()).not.toContain("pattern-change");
    });

    it("renders each change under its own step, in the order given, with the piece's name, the operation's label and the origin's", async () => {
      const { markup } = await listed([
        step(5, [
          change("fid1:a", "r2", { pieceName: "Shopping list" }),
          change("fid1:b", "r3", {
            pieceName: "Notes",
            label: "Source update",
            originLabel: "Fabric piece",
          }),
        ]),
        step(4, [change("fid1:a", "r1", { pieceName: "Shopping list" })]),
      ]);

      const rendered = markup();
      const order = ['data-seq="5"', "r2", "r3", 'data-seq="4"', "r1"].map((
        text,
      ) => rendered.indexOf(text));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(order).not.toContain(-1);
      const second = changeMarkup(rendered, "r3");
      expect(second).toContain("Notes:");
      expect(second).toContain("Source update");
      expect(second).toContain("Fabric piece");
      expect(second).not.toContain("Shopping list");
    });

    it("names a piece with no name by the last six characters of its id", async () => {
      const { markup } = await listed([
        step(4, [change("fid1:abcdefghij", "r1")]),
      ]);

      expect(changeMarkup(markup(), "r1")).toContain("Piece #efghij:");
    });

    it("marks the revision a piece is on as current and offers no restore of it, and offers one of every other", async () => {
      const { markup } = await listed([
        step(4, [
          change("fid1:a", "r1"),
          change("fid1:a", "r2", { current: true }),
        ]),
      ]);

      const earlier = changeMarkup(markup(), "r1");
      const current = changeMarkup(markup(), "r2");
      expect(current).toContain("· Current");
      expect(current).not.toContain("pattern-restore");
      expect(earlier).not.toContain("· Current");
      expect(earlier).toContain('class="pattern-restore"');
      expect(earlier).toContain("Restore this pattern version");
    });
  });

  describe("the restore button of a pattern change", () => {
    it("sends `restore-pattern` for the piece and revision of the change it is on, with no scope where the change has none", async () => {
      const { view, commands } = await listed([
        step(4, [change("fid1:a", "r1"), change("fid1:b", "r2")]),
      ]);

      click(view, "pattern-restore", 1);

      // `toStrictEqual` tells an absent member from one holding `undefined`.
      expect(commands).toStrictEqual([
        { type: "restore-pattern", pieceId: "fid1:b", revisionId: "r2" },
      ]);
    });

    it("sends the change's scope with it, where the change has one", async () => {
      const { view, commands } = await listed([
        step(4, [change("fid1:a", "r1", { scope: "user" })]),
      ]);

      click(view, "pattern-restore");

      expect(commands).toEqual([{
        type: "restore-pattern",
        pieceId: "fid1:a",
        revisionId: "r1",
        scope: "user",
      }]);
    });

    it("is enabled with no fork open and no restore under way, or with a restore that has settled", async () => {
      const { view, markup } = await listed([
        step(4, [change("fid1:a", "r1")]),
      ]);

      expect(changeMarkup(markup(), "r1")).toContain('?disabled="false"');

      view.patternRestore = {
        pieceId: "fid1:a",
        revisionId: "r1",
        busy: false,
        error: "offline",
      };
      expect(changeMarkup(markup(), "r1")).toContain('?disabled="false"');
    });

    it("is disabled while a fork is open, busy or not", async () => {
      const { view, markup } = await listed([
        step(4, [change("fid1:a", "r1")]),
      ]);

      view.open = { seq: 2, busy: false };

      const rendered = changeMarkup(markup(), "r1");
      expect(rendered).toContain('?disabled="true"');
      expect(rendered).not.toContain('?disabled="false"');
    });

    it("is disabled on every change while a restore of any one is busy", async () => {
      const { view, markup } = await listed([
        step(4, [change("fid1:a", "r1"), change("fid1:b", "r2")]),
      ]);

      view.patternRestore = { pieceId: "fid1:a", revisionId: "r1", busy: true };

      expect(changeMarkup(markup(), "r1")).toContain('?disabled="true"');
      expect(changeMarkup(markup(), "r2")).toContain('?disabled="true"');
    });
  });

  describe("a restore's compatibility warning", () => {
    const warned: PatternRestore = {
      pieceId: "fid1:a",
      revisionId: "r1",
      busy: false,
      warning: "The source does not fit the data.",
      confirmationToken: "token-1",
    };

    it("renders on the change the restore is of, with a way to restore anyway, and on no other", async () => {
      const { view, markup } = await listed([
        step(4, [
          change("fid1:a", "r1"),
          // The same piece's other revision, and another piece's revision of
          // the same name.
          change("fid1:a", "r2"),
          change("fid1:b", "r1"),
        ]),
      ]);

      view.patternRestore = warned;

      const rendered = markup();
      const mine = changeMarkup(rendered, "r1");
      expect(mine).toContain("The source does not fit the data.");
      expect(mine).toContain('class="pattern-restore-confirm"');
      expect(mine).toContain("Restore it anyway");
      expect(rendered.split("The source does not fit the data.")).toHaveLength(
        2,
      );
      expect(rendered.split("pattern-restore-confirm")).toHaveLength(2);
    });

    it("sends `restore-pattern` carrying the token from the way to restore anyway", async () => {
      const { view, commands } = await listed([
        step(4, [change("fid1:a", "r1")]),
      ]);
      view.patternRestore = warned;

      click(view, "pattern-restore-confirm");

      expect(commands).toStrictEqual([{
        type: "restore-pattern",
        pieceId: "fid1:a",
        revisionId: "r1",
        confirmationToken: "token-1",
      }]);
    });

    it("sends the change's scope with the token, where the change has one", async () => {
      const { view, commands } = await listed([
        step(4, [change("fid1:a", "r1", { scope: "session" })]),
      ]);
      view.patternRestore = warned;

      click(view, "pattern-restore-confirm");

      expect(commands).toEqual([{
        type: "restore-pattern",
        pieceId: "fid1:a",
        revisionId: "r1",
        scope: "session",
        confirmationToken: "token-1",
      }]);
    });

    /** The opening tag of the way to restore anyway, in `markup`. */
    function confirmTag(markup: string): string {
      const at = markup.indexOf('class="pattern-restore-confirm"');
      return markup.slice(
        markup.lastIndexOf("<cf-button", at),
        markup.indexOf(">", at),
      );
    }

    it("renders the way to restore anyway enabled with no fork open", async () => {
      const { view, markup } = await listed([
        step(4, [change("fid1:a", "r1")]),
      ]);

      view.patternRestore = warned;

      expect(confirmTag(markup())).toContain('?disabled="false"');
    });

    it("renders the way to restore anyway disabled while a fork is open", async () => {
      const { view, markup } = await listed([
        step(4, [change("fid1:a", "r1")]),
      ]);
      view.patternRestore = warned;

      view.open = { seq: 2, busy: false };

      const tag = confirmTag(markup());
      expect(tag).toContain('?disabled="true"');
      expect(tag).not.toContain('?disabled="false"');
    });

    it("renders the way to restore anyway disabled while the restore is busy", async () => {
      const { view, markup } = await listed([
        step(4, [change("fid1:a", "r1")]),
      ]);

      view.patternRestore = { ...warned, busy: true };

      expect(confirmTag(markup())).toContain('?disabled="true"');
    });

    it("renders with no way to restore anyway where the restore carries no token", async () => {
      const { view, markup } = await listed([
        step(4, [change("fid1:a", "r1")]),
      ]);

      view.patternRestore = {
        pieceId: "fid1:a",
        revisionId: "r1",
        busy: false,
        warning: "The source does not fit the data.",
      };

      const mine = changeMarkup(markup(), "r1");
      expect(mine).toContain("The source does not fit the data.");
      expect(mine).not.toContain("pattern-restore-confirm");
    });
  });

  describe("a restore's failure", () => {
    it("renders on the change the restore was of, and on no other", async () => {
      const { view, markup } = await listed([
        step(4, [change("fid1:a", "r1"), change("fid1:b", "r2")]),
      ]);
      expect(markup()).not.toContain('role="alert"');

      view.patternRestore = {
        pieceId: "fid1:a",
        revisionId: "r1",
        busy: false,
        error: "the piece is gone",
      };

      expect(changeMarkup(markup(), "r1")).toContain("the piece is gone");
      expect(changeMarkup(markup(), "r2")).not.toContain("the piece is gone");
      expect(changeMarkup(markup(), "r2")).not.toContain('role="alert"');
    });
  });

  describe("the older steps", () => {
    it("moves a change the newest stretch showed on its oldest step to the older step it was made during, rendering it once", async () => {
      // The change was made half a minute before the newest stretch's oldest
      // step, which shows it until the step it was made during is listed.
      const madeAt = Date.parse(AT) - 30_000;
      const moved = change("fid1:a", "r1", { madeAt });
      const pages: Page[] = [
        { steps: [step(4, [moved])], next: 4 },
        {
          steps: [{
            ...step(2, [moved]),
            at: new Date(madeAt).toISOString(),
          }],
        },
      ];
      const { view, until, update } = mount(
        () => Promise.resolve(pages.shift()!),
      );
      const first = await update(
        ["rt", "space"],
        (markup) => markup.includes("Show older steps"),
      );
      expect(first.indexOf('data-revision="r1"')).toBeGreaterThan(
        first.indexOf('data-seq="4"'),
      );

      const [older] = templateListeners(view.render(), "click", view).filter((
        { text },
      ) => text === "Show older steps");
      const extended = await until(
        () => older.dispatch(new Event("click")),
        (markup) => markup.includes('data-seq="2"'),
      );

      expect(extended.split('data-revision="r1"')).toHaveLength(2);
      expect(extended.indexOf('data-seq="4"')).toBeLessThan(
        extended.indexOf('data-seq="2"'),
      );
      expect(extended.indexOf('data-revision="r1"')).toBeGreaterThan(
        extended.indexOf('data-seq="2"'),
      );
    });
  });

  describe("pieceId", () => {
    it("names the runtime no piece with a listing while it has no piece id, though it has a scope", async () => {
      const mounted = mount(() => Promise.resolve({ steps: [step(4)] }));
      mounted.view.pieceScope = "user";
      await mounted.update(
        ["rt", "space"],
        (markup) => markup.includes('data-seq="4"'),
      );
      const { pieces } = mounted;

      expect(pieces).toEqual([[]]);
    });

    it("hands the runtime its piece id with each listing, an older stretch's included", async () => {
      const pages: Page[] = [{ steps: [step(4)], next: 4 }, {
        steps: [step(2)],
      }];
      const { view, listings, pieces, update } = mount(
        () => Promise.resolve(pages.shift()!),
      );
      view.pieceId = "fid1:viewed";
      await update(
        ["rt", "space"],
        (markup) => markup.includes("Show older steps"),
      );

      const [older] = templateListeners(view.render(), "click", view).filter((
        { text },
      ) => text === "Show older steps");
      older.dispatch(new Event("click"));

      expect(listings).toEqual([undefined, 4]);
      // `toStrictEqual` tells an absent `scope` from one holding `undefined`.
      expect(pieces).toStrictEqual([
        [{ id: "fid1:viewed" }],
        [{ id: "fid1:viewed" }],
      ]);
    });

    it("lists the history again from its newest step with the new piece id when it changes, and with none once it is gone", async () => {
      const pages: Page[] = [
        { steps: [step(4)] },
        { steps: [step(5, [change("fid1:viewed", "r1")])] },
        { steps: [step(6)] },
      ];
      const { view, listings, pieces, update } = mount(
        () => Promise.resolve(pages.shift()!),
      );
      await update(
        ["rt", "space"],
        (markup) => markup.includes('data-seq="4"'),
      );

      view.pieceId = "fid1:viewed";
      const relisted = await update(
        ["pieceId"],
        (markup) => markup.includes('data-seq="5"'),
      );
      expect(changeMarkup(relisted, "r1")).toContain("Direct source edit");
      expect(relisted).not.toContain('data-seq="4"');

      view.pieceId = undefined;
      await update(["pieceId"], (markup) => markup.includes('data-seq="6"'));

      expect(listings).toEqual([undefined, undefined, undefined]);
      expect(pieces).toEqual([[], [{ id: "fid1:viewed" }], []]);
    });
  });

  describe("pieceScope", () => {
    it("names the runtime its piece with the scope, on each listing", async () => {
      const pages: Page[] = [{ steps: [step(4)], next: 4 }, {
        steps: [step(2)],
      }];
      const { view, pieces, until, update } = mount(
        () => Promise.resolve(pages.shift()!),
      );
      view.pieceId = "fid1:viewed";
      view.pieceScope = "user";
      await update(
        ["rt", "space"],
        (markup) => markup.includes("Show older steps"),
      );
      const [older] = templateListeners(view.render(), "click", view).filter((
        { text },
      ) => text === "Show older steps");
      await until(
        () => older.dispatch(new Event("click")),
        (markup) => markup.includes('data-seq="2"'),
      );

      expect(pieces).toEqual([
        [{ id: "fid1:viewed", scope: "user" }],
        [{ id: "fid1:viewed", scope: "user" }],
      ]);
    });

    it("lists the history again from its newest step with the new scope when it changes, and with none once it is gone", async () => {
      const pages: Page[] = [
        { steps: [step(4)] },
        { steps: [step(5)] },
        { steps: [step(6)] },
      ];
      const { view, listings, pieces, update } = mount(
        () => Promise.resolve(pages.shift()!),
      );
      view.pieceId = "fid1:viewed";
      await update(
        ["rt", "space"],
        (markup) => markup.includes('data-seq="4"'),
      );

      view.pieceScope = "session";
      const relisted = await update(
        ["pieceScope"],
        (markup) => markup.includes('data-seq="5"'),
      );
      expect(relisted).not.toContain('data-seq="4"');

      view.pieceScope = undefined;
      await update(["pieceScope"], (markup) => markup.includes('data-seq="6"'));

      expect(listings).toEqual([undefined, undefined, undefined]);
      expect(pieces).toStrictEqual([
        [{ id: "fid1:viewed" }],
        [{ id: "fid1:viewed", scope: "session" }],
        [{ id: "fid1:viewed" }],
      ]);
    });
  });

  describe("changes", () => {
    it("lists the history again from its newest step for a new value, replacing the steps listed", async () => {
      const pages: Page[] = [
        { steps: [step(4, [change("fid1:a", "r1")])] },
        {
          steps: [
            step(5, [change("fid1:a", "r1", { current: true })]),
            step(4, [change("fid1:a", "r0")]),
          ],
        },
      ];
      const { view, listings, update } = mount(
        () => Promise.resolve(pages.shift()!),
      );
      await update(["rt", "space"], (markup) => markup.includes("r1"));

      view.changes = 1;
      const relisted = await update(
        ["changes"],
        (markup) => markup.includes('data-seq="5"'),
      );

      expect(listings).toEqual([undefined, undefined]);
      expect(changeMarkup(relisted, "r1")).toContain("· Current");
      expect(relisted.split('data-seq="4"')).toHaveLength(2);
    });

    it("asks for no listing for a change of the restore alone", async () => {
      const { view, listings, markup } = await listed([
        step(4, [change("fid1:a", "r1")]),
      ]);

      view.patternRestore = { pieceId: "fid1:a", revisionId: "r1", busy: true };
      (view as unknown as {
        willUpdate(changed: Map<string, unknown>): void;
      }).willUpdate(new Map([["patternRestore", undefined]]));

      expect(listings).toEqual([undefined]);
      expect(markup()).toContain('data-seq="4"');
    });
  });
});
