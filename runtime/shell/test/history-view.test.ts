// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

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

  /** One following of a space's history the view asked the runtime for. */
  type Follow = {
    space: DID;
    onAdvance: (seq: number) => void;
    stopped: boolean;
  };

  /** A view under test, and what it has asked of the world around it. */
  interface Mounted {
    view: XHistoryView;

    /** The `before` of each listing the view asked the runtime for. */
    listings: (number | undefined)[];

    /** The pieces each listing named to the runtime, beside `before`. */
    pieces: (readonly NamedPiece[] | undefined)[];

    /** Whether each listing asked the runtime to reuse the sources read. */
    reuses: (boolean | undefined)[];

    /** Each time the view asked the runtime to follow a space's history. */
    follows: Follow[];

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
    const reuses: (boolean | undefined)[] = [];
    const follows: Follow[] = [];
    let moved = () => {};
    class Observed extends HistoryView {
      override requestUpdate(...args: unknown[]): void {
        super.requestUpdate(...args as []);
        moved();
      }
    }
    const view = new Observed();
    // A history, and following it, is all these cases ask of the runtime.
    view.rt = {
      spaceHistory: (
        _space: DID,
        before?: number,
        ids?: readonly NamedPiece[],
        options?: { reuseSources?: boolean },
      ) => {
        listings.push(before);
        pieces.push(ids);
        reuses.push(options?.reuseSources);
        return list(before);
      },
      watchSpaceHistory: (followed: DID, onAdvance: (seq: number) => void) => {
        const follow = { space: followed, onAdvance, stopped: false };
        follows.push(follow);
        return () => {
          follow.stopped = true;
        };
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
      reuses,
      follows,
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

  describe("the step list", () => {
    it("lists nothing and says nothing has happened, asking no runtime, while it has no space", async () => {
      const { view, listings, update } = mount(
        () => Promise.resolve({ steps: [step(4)] }),
      );
      view.space = undefined;

      const rendered = await update(
        ["space"],
        (markup) => markup.includes("Nothing has happened"),
      );

      expect(listings).toEqual([]);
      expect(rendered).not.toContain("data-seq");
    });

    it("drops the steps of the space it showed once it has no runtime", async () => {
      const { view, markup, update } = await listed([step(4)]);

      view.rt = undefined;
      await update(
        ["rt"],
        (rendered) => rendered.includes("Nothing has happened"),
      );

      expect(markup()).not.toContain("data-seq");
      expect(markup()).not.toContain("Show older steps");
    });

    it("says the history could not be listed when the runtime rejects", async () => {
      const { update } = mount(() => Promise.reject(new Error("offline")));

      const rendered = await update(
        ["rt", "space"],
        (markup) => markup.includes("could not be listed"),
      );

      expect(rendered).not.toContain("Nothing has happened");
    });

    it("keeps the steps of the later of two listings when the earlier one answers last", async () => {
      const first = Promise.withResolvers<Page>();
      const answers = [first.promise, Promise.resolve({ steps: [step(9)] })];
      const { view, markup, update } = mount(() => answers.shift()!);
      (view as unknown as {
        willUpdate(changed: Map<string, unknown>): void;
      }).willUpdate(new Map([["rt", undefined]]));
      view.changes = 1;
      await update(
        ["changes"],
        (rendered) => rendered.includes('data-seq="9"'),
      );

      first.resolve({ steps: [step(4)], next: 4 });
      // The listing was waiting on this promise before this case was, so it
      // has been resumed by the time this case is.
      await first.promise;

      expect(markup()).toContain('data-seq="9"');
      expect(markup()).not.toContain('data-seq="4"');
      expect(markup()).not.toContain("Show older steps");
    });

    it("calls a step by what began it: an edit, one event or several, or the point restored to", async () => {
      const { markup } = await listed([
        { ...step(8), kind: "restore", restoredSeq: 2 },
        { ...step(7), kind: "event", events: 3 },
        { ...step(6), kind: "event", events: 1 },
        step(5),
      ]);

      const labels = [
        ...markup().matchAll(
          /data-seq="(\d+)"[^>]*>\s*<span>([^<]*)<\/span>/g,
        ),
      ].map(([, seq, label]) => [seq, label]);
      expect(labels).toEqual([
        ["8", "Restored to #2"],
        ["7", "3 events"],
        ["6", "Event"],
        ["5", "Edit"],
      ]);
    });

    it("numbers the event steps in the order listed, and no other step", async () => {
      const { markup } = await listed([
        { ...step(8), kind: "event", events: 1 },
        step(7),
        { ...step(6), kind: "event", events: 1 },
      ]);

      const indexes = [
        ...markup().matchAll(
          /data-seq="(\d+)"\s+data-event-index="(\d+)"/g,
        ),
      ].map(([, seq, index]) => [seq, index]);
      expect(indexes).toEqual([["8", "0"], ["6", "1"]]);
    });

    it("names each step by the seq it began at as well as its own", async () => {
      // A step's own seq moves while it grows; where it began does not, which
      // is what names it to a reader that must find it again.

      const { markup } = await listed([
        { ...step(8), startSeq: 6 },
        { ...step(5), startSeq: 3 },
      ]);

      const starts = [...markup().matchAll(/data-start-seq="(\d+)"/g)].map((
        [, start],
      ) => start);
      expect(starts).toEqual(["6", "3"]);
    });

    it("says who began a step that has a principal, shortening a long DID, and nothing for one with none", async () => {
      const long = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
      const { markup } = await listed([
        { ...step(6), principal: long },
        { ...step(5), principal: "did:key:short" },
        step(4),
      ]);

      const rendered = markup();
      expect(rendered).toContain(`title="${long}"`);
      expect(rendered).toContain("by did:key:z6Mkha…ta2doK");
      expect(rendered).toContain("by did:key:short");
      expect(rendered.split('class="detail by"')).toHaveLength(3);
    });

    it("marks a step whose events had yet to be handled as in progress, and no settled one", async () => {
      const { markup } = await listed([
        { ...step(5), settled: false },
        step(4),
      ]);

      expect(markup().split("in progress")).toHaveLength(2);
      expect(markup().indexOf("in progress")).toBeLessThan(
        markup().indexOf('data-seq="4"'),
      );
    });

    it("sends `open-history` for the step chosen", async () => {
      const { view, commands } = await listed([step(5), step(4)]);

      const steps = templateListeners(view.render(), "click", view).filter((
        { tag },
      ) => tag.includes('class="step"'));
      steps[1].dispatch(new Event("click"));

      expect(commands).toEqual([{ type: "open-history", seq: 4 }]);
    });

    it("sends the command that hides the panel from its close button", async () => {
      const { view, commands } = await listed([step(4)]);

      const [close] = templateListeners(view.render(), "click", view).filter((
        { tag },
      ) => tag.includes('aria-label="Close history"'));
      close.dispatch(new Event("click"));

      expect(commands).toEqual([
        { type: "set-config", key: "showHistoryView", value: false },
      ]);
    });

    it("renders the failure it is handed, and none while it is handed none", async () => {
      const { view, markup } = await listed([step(4)]);
      expect(markup()).not.toContain('role="alert"');

      view.error = "The fork could not be opened.";

      expect(markup()).toContain("The fork could not be opened.");
      expect(markup().split('role="alert"')).toHaveLength(2);
    });
  });

  describe("an open fork", () => {
    /** The opening tag of the step numbered `seq`, in `markup`. */
    function stepTag(markup: string, seq: number): string {
      const at = markup.indexOf(`data-seq="${seq}"`);
      return markup.slice(
        markup.lastIndexOf("<button", at),
        markup.indexOf(">", at),
      );
    }

    it("renders no fork's section, and every step enabled and not current, while none is open", async () => {
      const { markup } = await listed([step(5), step(4)]);

      expect(markup()).not.toContain('class="open"');
      for (const seq of [5, 4]) {
        expect(stepTag(markup(), seq)).toContain('aria-current="false"');
        expect(stepTag(markup(), seq)).toContain('?disabled="false"');
      }
    });

    it("says which point the fork shows, and marks that step alone as current and disabled", async () => {
      const { view, markup } = await listed([step(5), step(4)]);

      view.open = { seq: 4, busy: false };

      expect(markup()).toContain("Showing this space as it stood at #4.");
      expect(stepTag(markup(), 4)).toContain('aria-current="true"');
      expect(stepTag(markup(), 4)).toContain('?disabled="true"');
      expect(stepTag(markup(), 5)).toContain('aria-current="false"');
      expect(stepTag(markup(), 5)).toContain('?disabled="false"');
    });

    it("disables every step and both of the fork's buttons while the fork is busy, and neither button once it is not", async () => {
      const { view, markup } = await listed([step(5), step(4)]);
      const buttons = (rendered: string) =>
        ["history-back", "history-restore"].map((id) => {
          const at = rendered.indexOf(`id="${id}"`);
          return rendered.slice(at, rendered.indexOf(">", at));
        });

      view.open = { seq: 4, busy: true };
      expect(stepTag(markup(), 5)).toContain('?disabled="true"');
      for (const tag of buttons(markup())) {
        expect(tag).toContain('?disabled="true"');
      }

      view.open = { seq: 4, busy: false };
      for (const tag of buttons(markup())) {
        expect(tag).toContain('?disabled="false"');
      }
    });

    it("sends `close-history` from the way back, and `restore-history` from the way to restore", async () => {
      const { view, commands } = await listed([step(4)]);
      view.open = { seq: 4, busy: false };
      const button = (id: string) =>
        templateListeners(view.render(), "click", view).filter(({ tag }) =>
          tag.includes(`id="${id}"`)
        )[0];

      button("history-back").dispatch(new Event("click"));
      button("history-restore").dispatch(new Event("click"));

      expect(commands).toEqual([
        { type: "close-history" },
        { type: "restore-history" },
      ]);
    });

    it("lists the history again when the fork is let go of, and not when one is opened", async () => {
      const pages: Page[] = [{ steps: [step(4)] }, { steps: [step(5)] }];
      const { view, listings, update } = mount(
        () => Promise.resolve(pages.shift()!),
      );
      await update(
        ["rt", "space"],
        (markup) => markup.includes('data-seq="4"'),
      );

      view.open = { seq: 4, busy: false };
      (view as unknown as {
        willUpdate(changed: Map<string, unknown>): void;
      }).willUpdate(new Map([["open", undefined]]));
      expect(listings).toEqual([undefined]);

      view.open = undefined;
      await update(["open"], (markup) => markup.includes('data-seq="5"'));
      expect(listings).toEqual([undefined, undefined]);
    });
  });

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
      view.patternRestore = { ...warned, scope: "session" };

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

  describe("the note of a restore whose change is on no listed step", () => {
    const note = 'class="note error pattern-restore-note"';

    /** The text of the panel's note in `markup`, which holds one. */
    function noteText(markup: string): string {
      const start = markup.indexOf(">", markup.indexOf(note)) + 1;
      return markup.slice(start, markup.indexOf("</p>", start)).trim();
    }

    it("renders the restore's failure, once, where no step lists the change", async () => {
      const { view, markup } = await listed([
        // The same piece's other revision, and another piece's revision of
        // the same name, are not the change.
        step(4, [change("fid1:a", "r2"), change("fid1:b", "r1")]),
      ]);

      view.patternRestore = {
        pieceId: "fid1:a",
        revisionId: "r1",
        busy: false,
        error: "The restored pattern threw as it started.",
      };

      const rendered = markup();
      expect(noteText(rendered)).toBe(
        "The restored pattern threw as it started.",
      );
      expect(rendered.split("The restored pattern threw")).toHaveLength(2);
      // The note stands above the list of steps.
      expect(rendered.indexOf(note)).toBeLessThan(rendered.indexOf("<ol"));
    });

    it("renders the restore's warning where no step lists the change, and the failure where the restore has both", async () => {
      const { view, markup } = await listed([step(4)]);

      view.patternRestore = {
        pieceId: "fid1:a",
        revisionId: "r1",
        busy: false,
        warning: "The source does not fit the data.",
      };
      expect(noteText(markup())).toBe("The source does not fit the data.");

      view.patternRestore = {
        ...view.patternRestore,
        error: "the piece is gone",
      };
      expect(noteText(markup())).toBe("the piece is gone");
    });

    it("renders none where a step lists the change, whose row alone says it", async () => {
      const { view, markup } = await listed([
        step(5),
        step(4, [change("fid1:a", "r1")]),
      ]);

      view.patternRestore = {
        pieceId: "fid1:a",
        revisionId: "r1",
        busy: false,
        error: "the piece is gone",
      };

      const rendered = markup();
      expect(rendered).not.toContain("pattern-restore-note");
      expect(rendered.split("the piece is gone")).toHaveLength(2);
      expect(changeMarkup(rendered, "r1")).toContain("the piece is gone");
    });

    it("renders none with no restore, or with one that has neither a failure nor a warning", async () => {
      const { view, markup } = await listed([step(4)]);
      expect(markup()).not.toContain("pattern-restore-note");

      view.patternRestore = { pieceId: "fid1:a", revisionId: "r1", busy: true };

      expect(markup()).not.toContain("pattern-restore-note");
      expect(markup()).not.toContain('role="alert"');
    });
  });

  describe("a restore's scope", () => {
    const failed: PatternRestore = {
      pieceId: "fid1:a",
      revisionId: "r1",
      busy: false,
      error: "the piece is gone",
    };

    /** Whether the row of the change to `r1`, and the panel, say `failed`. */
    function said(markup: string): { row: boolean; panel: boolean } {
      return {
        row: changeMarkup(markup, "r1").includes("the piece is gone"),
        panel: markup.includes("pattern-restore-note"),
      };
    }

    it("renders a restore's failure on the row of the change in the same scope, and no panel note", async () => {
      const { view, markup } = await listed([
        step(4, [change("fid1:a", "r1", { scope: "user" })]),
      ]);

      view.patternRestore = { ...failed, scope: "user" };

      expect(said(markup())).toEqual({ row: true, panel: false });
    });

    it("renders it on the row whether the scope `space` is given or left out, on either side", async () => {
      const plain = await listed([step(4, [change("fid1:a", "r1")])]);
      plain.view.patternRestore = { ...failed, scope: "space" };
      expect(said(plain.markup())).toEqual({ row: true, panel: false });

      const scoped = await listed([
        step(4, [change("fid1:a", "r1", { scope: "space" })]),
      ]);
      scoped.view.patternRestore = failed;
      expect(said(scoped.markup())).toEqual({ row: true, panel: false });
    });

    it("renders it as the panel's note, and not on the row, where the listed change is in another scope", async () => {
      const { view, markup } = await listed([
        step(4, [change("fid1:a", "r1", { scope: "user" })]),
      ]);

      view.patternRestore = { ...failed, scope: "session" };
      expect(said(markup())).toEqual({ row: false, panel: true });

      view.patternRestore = failed;
      expect(said(markup())).toEqual({ row: false, panel: true });
    });

    it("renders a warning's way to restore anyway on the row in the restore's scope alone, where the change is listed in two", async () => {
      const { view, commands, markup } = await listed([
        step(4, [
          change("fid1:a", "r1", { scope: "user" }),
          change("fid1:a", "r1", { scope: "session" }),
        ]),
      ]);

      view.patternRestore = {
        pieceId: "fid1:a",
        revisionId: "r1",
        scope: "session",
        busy: false,
        warning: "It does not fit.",
        confirmationToken: "t1",
      };

      expect(markup().split("pattern-restore-confirm")).toHaveLength(2);
      expect(markup()).not.toContain("pattern-restore-note");
      click(view, "pattern-restore-confirm");
      expect(commands).toEqual([{
        type: "restore-pattern",
        pieceId: "fid1:a",
        revisionId: "r1",
        scope: "session",
        confirmationToken: "t1",
      }]);
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

  describe("following the space", () => {
    const otherSpace = "did:key:z6Mk-shell-history-view-other" as DID;

    /**
     * Connects `view` as a page does, except that an update does nothing,
     * since there is no DOM to render into: a case calls `willUpdate()`
     * itself, as the rest of this file does.
     */
    function connect(view: XHistoryView): void {
      Object.defineProperty(view, "performUpdate", { value: () => {} });
      Object.defineProperty(view, "renderRoot", { value: {} });
      Object.defineProperty(view, "isConnected", {
        configurable: true,
        value: true,
      });
      view.connectedCallback();
    }

    /** Takes `view` out of the page. */
    function disconnect(view: XHistoryView): void {
      Object.defineProperty(view, "isConnected", {
        configurable: true,
        value: false,
      });
      view.disconnectedCallback();
    }

    /**
     * Resolves once every microtask queued before the call has run, which is
     * when a listing that a report during an earlier one queued has begun.
     */
    const queuedTurns = () => Promise.resolve();

    /**
     * Mounts a view that lists `pages` in turn, or what `list` returns where
     * it is given, lists it, and connects it.
     */
    async function following(
      pages: Page[],
      list: () => Promise<Page> = () => Promise.resolve(pages.shift()!),
    ): Promise<Mounted> {
      const mounted = mount(list);
      await mounted.update(
        ["rt", "space"],
        (markup) => markup.includes("data-seq"),
      );
      connect(mounted.view);
      return mounted;
    }

    describe("the following", () => {
      it("asks the runtime to follow its space once connected, and stops once disconnected", async () => {
        const { view, follows } = await listed([step(4)]);
        expect(follows).toEqual([]);

        connect(view);
        expect(follows.map(({ space, stopped }) => [space, stopped]))
          .toEqual([[space, false]]);

        disconnect(view);
        expect(follows.map(({ stopped }) => stopped)).toEqual([true]);
      });

      it("follows nothing while connected with no space", () => {
        const { view, follows } = mount(() => Promise.resolve({ steps: [] }));
        view.space = undefined;

        connect(view);

        expect(follows).toEqual([]);
      });

      it("follows the new space, having stopped the old one, when its space changes while connected", async () => {
        const { view, follows } = await listed([step(4)]);
        connect(view);

        view.space = otherSpace;
        (view as unknown as {
          willUpdate(changed: Map<string, unknown>): void;
        }).willUpdate(new Map([["space", undefined]]));

        expect(follows.map(({ space, stopped }) => [space, stopped]))
          .toEqual([[space, true], [otherSpace, false]]);
      });
    });

    describe("a reported seq", () => {
      it("keeps a step's first commit as its identity when later commits extend it", async () => {
        const { markup, follows, until } = await following([
          { steps: [{ ...step(5), startSeq: 4 }] },
          { steps: [{ ...step(7), startSeq: 4 }] },
        ]);
        expect(markup()).toContain('data-start-seq="4"');
        expect(markup()).not.toContain('data-start-seq="5"');

        const rendered = await until(
          () => follows[0].onAdvance(7),
          (markup) => markup.includes('data-seq="7"'),
        );
        expect(rendered).toContain('data-start-seq="4"');
        expect(rendered).not.toContain('data-start-seq="7"');
      });

      it("lists the newest stretch again, reusing the sources read, for a seq past the newest step listed", async () => {
        const { follows, listings, reuses, until } = await following([
          { steps: [step(4)] },
          { steps: [step(5), step(4)] },
        ]);

        const relisted = await until(
          () => follows[0].onAdvance(5),
          (markup) => markup.includes('data-seq="5"'),
        );

        expect(listings).toEqual([undefined, undefined]);
        expect(reuses).toEqual([false, true]);
        expect(relisted.split('data-seq="4"')).toHaveLength(2);
      });

      it("lists nothing for a seq no newer than the newest step listed", async () => {
        const { follows, listings } = await following([{ steps: [step(5)] }]);

        follows[0].onAdvance(5);
        follows[0].onAdvance(3);
        await queuedTurns();

        expect(listings).toEqual([undefined]);
      });

      it("lists nothing while a fork is open", async () => {
        const { view, follows, listings } = await following([
          { steps: [step(5)] },
        ]);
        view.open = { seq: 5, busy: false };

        follows[0].onAdvance(9);
        await queuedTurns();

        expect(listings).toEqual([undefined]);
      });

      it("lists nothing once disconnected", async () => {
        const { view, follows, listings } = await following([
          { steps: [step(5)] },
        ]);
        disconnect(view);
        // A report the runtime made as the following stopped.
        follows[0].onAdvance(9);
        await queuedTurns();

        expect(follows[0].stopped).toBe(true);
        expect(listings).toEqual([undefined]);
      });

      it("lists once more after an older stretch, for a seq reported during a refresh the older stretch replaced", async () => {
        // The older stretch lists no newer step, so the seq reported while
        // the refresh it replaced was made is listed after it.

        const refresh = Promise.withResolvers<Page>();
        const answers: Promise<Page>[] = [
          Promise.resolve({ steps: [step(6), step(5)], next: 5 }),
          refresh.promise,
          Promise.resolve({ steps: [step(4)] }),
          Promise.resolve({ steps: [step(8), step(7), step(6)] }),
        ];
        const { view, follows, listings, reuses, markup, until } =
          await following([], () => answers.shift()!);
        follows[0].onAdvance(7);
        follows[0].onAdvance(8);
        expect(listings).toEqual([undefined, undefined]);

        const [older] = templateListeners(view.render(), "click", view).filter((
          { text },
        ) => text === "Show older steps");
        await until(
          () => older.dispatch(new Event("click")),
          (rendered) => rendered.includes('data-seq="8"'),
        );

        expect(listings).toEqual([undefined, undefined, 5, undefined]);
        expect(reuses).toEqual([false, true, false, true]);
        const seqs = [...markup().matchAll(/data-seq="(\d+)"/g)].map((
          [, seq],
        ) => Number(seq));
        expect(seqs).toEqual([8, 7, 6, 5, 4]);
      });

      it("leaves the list as it was for a refresh that answers after a fork opened", async () => {
        const refresh = Promise.withResolvers<Page>();
        const answers: Promise<Page>[] = [
          Promise.resolve({ steps: [step(5)] }),
          refresh.promise,
        ];
        const { view, follows, listings, markup } = await following(
          [],
          () => answers.shift()!,
        );
        follows[0].onAdvance(7);
        expect(listings).toEqual([undefined, undefined]);

        view.open = { seq: 5, busy: false };
        refresh.resolve({ steps: [step(7), step(6), step(5)] });
        // The listing was waiting on this promise before this case was, so
        // it has been resumed by the time this case is.
        await refresh.promise;

        expect(markup()).not.toContain('data-seq="7"');
        expect(markup()).toContain('data-seq="5"');
      });

      it("asks for no listing while one is under way", async () => {
        const first = Promise.withResolvers<Page>();
        const { view, follows, listings, until } = mount(() => first.promise);
        connect(view);
        view.changes = 1;
        (view as unknown as {
          willUpdate(changed: Map<string, unknown>): void;
        }).willUpdate(new Map([["changes", undefined]]));

        follows[0].onAdvance(5);
        follows[0].onAdvance(7);
        expect(listings).toEqual([undefined]);

        await until(
          () => first.resolve({ steps: [step(5), step(4)] }),
          (markup) => markup.includes('data-seq="5"'),
        );
      });

      it("lists once more after a listing under way, for a seq reported during it", async () => {
        const first = Promise.withResolvers<Page>();
        const answers = [
          first.promise,
          Promise.resolve<Page>({ steps: [step(7), step(6), step(5)] }),
        ];
        const { view, follows, listings, reuses, until } = mount(
          () => answers.shift()!,
        );
        connect(view);
        view.changes = 1;
        (view as unknown as {
          willUpdate(changed: Map<string, unknown>): void;
        }).willUpdate(new Map([["changes", undefined]]));
        follows[0].onAdvance(7);

        const relisted = await until(
          () => first.resolve({ steps: [step(5), step(4)] }),
          (markup) => markup.includes('data-seq="7"'),
        );

        expect(listings).toEqual([undefined, undefined]);
        expect(reuses).toEqual([false, true]);
        const seqs = [...relisted.matchAll(/data-seq="(\d+)"/g)].map((
          [, seq],
        ) => Number(seq));
        expect(seqs).toEqual([7, 6, 5, 4]);
      });

      it("lists once for a seq the history does not list, such as another branch's, and not again until a later one", async () => {
        const { follows, listings, until } = await following([
          { steps: [step(4)] },
          { steps: [{ ...step(4), kind: "event", events: 2 }] },
          { steps: [step(10), step(4)] },
        ]);

        await until(
          () => follows[0].onAdvance(9),
          (markup) => markup.includes("2 events"),
        );
        await queuedTurns();
        expect(listings).toEqual([undefined, undefined]);

        follows[0].onAdvance(9);
        await queuedTurns();
        expect(listings).toEqual([undefined, undefined]);

        await until(
          () => follows[0].onAdvance(10),
          (markup) => markup.includes('data-seq="10"'),
        );
        expect(listings).toEqual([undefined, undefined, undefined]);
      });
    });

    describe("the steps a refresh lists", () => {
      it("keeps the listed steps older than the oldest it lists, and the way to older steps", async () => {
        const { view, follows, listings, markup, until } = await following([
          { steps: [step(6), step(5)], next: 5 },
          { steps: [step(7), step(6)], next: 6 },
        ]);

        await until(
          () => follows[0].onAdvance(7),
          (rendered) => rendered.includes('data-seq="7"'),
        );

        const relisted = markup();
        const seqs = [...relisted.matchAll(/data-seq="(\d+)"/g)].map((
          [, seq],
        ) => Number(seq));
        expect(seqs).toEqual([7, 6, 5]);
        const [older] = templateListeners(view.render(), "click", view).filter((
          { text },
        ) => text === "Show older steps");
        older.dispatch(new Event("click"));
        expect(listings.at(-1)).toBe(5);
      });

      it("lists only the new steps, with their way to older steps, when the space moved on by more than they reach", async () => {
        // The new stretch does not reach back to step 5, so keeping step 5
        // below it would put steps 6 and 7 out of reach.

        const { view, follows, listings, markup, until } = await following([
          { steps: [step(5)] },
          { steps: [step(9), step(8)], next: 8 },
        ]);

        await until(
          () => follows[0].onAdvance(9),
          (rendered) => rendered.includes('data-seq="9"'),
        );

        const seqs = [...markup().matchAll(/data-seq="(\d+)"/g)].map((
          [, seq],
        ) => Number(seq));
        expect(seqs).toEqual([9, 8]);
        const [older] = templateListeners(view.render(), "click", view).filter((
          { text },
        ) => text === "Show older steps");
        older.dispatch(new Event("click"));
        expect(listings.at(-1)).toBe(8);
      });

      it("takes the way to older steps from what it lists when it reaches past every listed step", async () => {
        const { follows, markup, until } = await following([
          { steps: [step(5)] },
          { steps: [step(7), step(6), step(5)], next: 5 },
        ]);
        expect(markup()).not.toContain("Show older steps");

        await until(
          () => follows[0].onAdvance(7),
          (rendered) => rendered.includes('data-seq="7"'),
        );

        // The way to older steps is set just after the steps are.
        expect(markup()).toContain("Show older steps");
      });

      it("leaves the listed steps, and the way to older steps, for a refresh that returns none", async () => {
        // The refresh is followed by another, for a seq reported while it
        // was made, so the third listing is asked for once the empty one has
        // ended.

        const empty = Promise.withResolvers<Page>();
        const third = Promise.withResolvers<void>();
        const answers: Promise<Page>[] = [
          Promise.resolve({ steps: [step(5)], next: 5 }),
          empty.promise,
        ];
        const { follows, listings, markup } = await following([], () => {
          const answer = answers.shift();
          if (answer === undefined) {
            third.resolve();
            return new Promise<Page>(() => {});
          }
          return answer;
        });
        follows[0].onAdvance(7);
        follows[0].onAdvance(8);
        expect(listings).toHaveLength(2);

        empty.resolve({ steps: [] });
        await third.promise;

        expect(markup()).toContain('data-seq="5"');
        expect(markup()).toContain("Show older steps");
      });
    });
  });
});
