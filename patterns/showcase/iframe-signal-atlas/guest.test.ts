import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import {
  type GuestPage,
  MemoryCell,
  MemorySqlite,
  openGuestPage,
} from "../../tools/test-support/iframe-guest.ts";
import {
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type IframeInputData,
  type SignalObservation,
} from "./contract.ts";

const GUEST = new URL("./guest.ts", import.meta.url);
const HTML = new URL("./guest.html", import.meta.url);

const INPUT: IframeInputData = {
  title: "North Reach survey",
  subtitle: "Field notes from the northern shelf",
  fieldSeed: 11,
  timeStart: 0,
  timeEnd: 100,
};

/** An observation as another session of the atlas stored it. */
function storedObservation(
  id: string,
  label: string,
  observedAt: number,
): SignalObservation {
  return { id, label, x: 30, y: 30, observedAt, strength: 0.5, band: "pulse" };
}

/** A personal database holding the tables the pattern declares. */
function personalAtlas(): MemorySqlite {
  const atlas = new MemorySqlite();
  atlas.database.exec(`
    CREATE TABLE atlas_bookmarks (
      id TEXT PRIMARY KEY,
      observation_id TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE atlas_hypotheses (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      narrative TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return atlas;
}

describe("guest", () => {
  let page: GuestPage | undefined;

  afterEach(async () => {
    await page?.close();
    page = undefined;
  });

  /**
   * Opens the atlas, by default on the stored default field and view, and
   * resolves once it has hydrated.
   */
  async function open(options: {
    input?: MemoryCell;
    state?: MemoryCell;
    output?: MemoryCell;
    atlas?: MemorySqlite;
  } = {}) {
    const input = options.input ?? new MemoryCell(INPUT, { readonly: true });
    const state = options.state ?? new MemoryCell(DEFAULT_STATE);
    const output = options.output ?? new MemoryCell(DEFAULT_OUTPUT);
    const atlas = options.atlas ?? personalAtlas();
    page = await openGuestPage({
      guest: GUEST,
      html: HTML,
      resources: {
        input: input.resource(),
        state: state.resource(),
        output: output.resource(),
        personalAtlas: atlas.resource(),
      },
    });
    const opened = page;
    const app = document.querySelector<HTMLElement>(".app")!;
    await opened.until(() => app.dataset.ready === "true");
    return { page: opened, input, state, output, atlas };
  }

  function byId<T extends Element = HTMLInputElement>(id: string): T {
    const element = document.querySelector<T>(`#${id}`);
    if (!element) throw new Error(`No element has the id \`${id}\`.`);
    return element;
  }

  function text(id: string): string | null {
    return byId<HTMLElement>(id).textContent;
  }

  function observationElement(id: string): SVGGElement | null {
    return document.querySelector<SVGGElement>(
      `g.observation[data-observation-id="${id}"]`,
    );
  }

  function shownObservations(): (string | null)[] {
    return [...document.querySelectorAll("g.observation")].map((group) =>
      group.getAttribute("data-observation-id")
    );
  }

  function shownRoutes(): (string | null)[] {
    return [...document.querySelectorAll("path.flow-route")].map((path) =>
      path.getAttribute("data-route-id")
    );
  }

  function listed(id: string): (string | null)[][] {
    return [...byId<HTMLUListElement>(id).children].map((item) =>
      [...item.children].map((child) => child.textContent)
    );
  }

  function change(control: HTMLInputElement | HTMLSelectElement): void {
    control.dispatchEvent(new Event("change"));
  }

  function type(
    control: HTMLInputElement | HTMLTextAreaElement,
    value: string,
  ) {
    control.value = value;
    control.dispatchEvent(new Event("input"));
  }

  /** Resolves once the atlas has committed every action it queued. */
  async function committed(opened: GuestPage): Promise<void> {
    await opened.until(() => text("status-text") === "Field synchronized");
  }

  /** Resolves with the error the atlas shows, once it shows one. */
  async function shownError(opened: GuestPage): Promise<string | null> {
    await opened.until(() => text("error") !== "");
    return text("error");
  }

  describe("startup", () => {
    it("stores the default field and view on first use and enables its controls", async () => {
      const { state, output } = await open({
        input: new MemoryCell(undefined, { readonly: true }),
        state: new MemoryCell(),
        output: new MemoryCell(),
      });

      expect(state.value).toEqual(DEFAULT_STATE);
      expect(output.value).toEqual(DEFAULT_OUTPUT);
      expect(text("title")).toBe("Signal Propagation Atlas");
      expect(text("status-text")).toBe("Field synchronized");
      expect(byId("time").disabled).toBe(false);
      expect(byId<HTMLButtonElement>("add-hypothesis").disabled).toBe(false);
      expect(byId<HTMLButtonElement>("add-bookmark").disabled).toBe(true);
    });

    it("shows the field at the stored time, with the counts it holds", async () => {
      const { page, state, output } = await open();
      await page.settled();

      expect(text("title")).toBe(INPUT.title);
      expect(text("subtitle")).toBe(INPUT.subtitle);
      expect(text("time-value")).toBe("T+72");
      expect(byId("time").value).toBe("72");
      expect(text("observation-count")).toBe("6");
      expect(text("route-count")).toBe("5");
      expect(text("visible-count")).toBe("5");
      expect(shownObservations()).toEqual([
        "obs-aurora-12",
        "obs-cinder-27",
        "obs-verdant-41",
        "obs-orison-55",
        "obs-lantern-68",
      ]);
      expect(shownRoutes()).toEqual([
        "route-aurora-cinder",
        "route-cinder-verdant",
        "route-verdant-orison",
        "route-orison-lantern",
      ]);
      expect(
        document.querySelector('[data-route-id="route-aurora-cinder"]')
          ?.getAttribute("aria-label"),
      ).toBe("pulse route from Aurora Shelf to Cinder Cay");
      expect(observationElement("obs-aurora-12")?.getAttribute("aria-label"))
        .toBe("Aurora Shelf, pulse band, strength 0.78, observed at T+12");
      expect(observationElement("obs-aurora-12")?.textContent).toBe(
        "Aurora Shelf",
      );
      expect(document.querySelectorAll("path.terrain").length)
        .toBeGreaterThan(0);
      expect(document.querySelectorAll("path.heat-contour").length)
        .toBeGreaterThan(0);
      expect(state.writes).toEqual([]);
      expect(output.writes).toEqual([]);
    });

    it("shows the view stored for the session", async () => {
      await open({
        output: new MemoryCell({
          ...DEFAULT_OUTPUT,
          viewport: { x: 10, y: 20, scale: 2 },
        }),
      });

      expect(document.querySelector(".viewport")?.getAttribute("transform"))
        .toBe("translate(10,20) scale(2)");
    });

    it("stores a time cursor clamped into the input's window", async () => {
      const { output } = await open({
        output: new MemoryCell({ ...DEFAULT_OUTPUT, timeCursor: 150 }),
      });

      expect(output.value).toMatchObject({ timeCursor: 100 });
      expect(text("time-value")).toBe("T+100");
    });

    it("lists no bookmarks or hypotheses for a new identity", async () => {
      await open();

      expect(listed("bookmarks")).toEqual([[]]);
      expect(text("bookmarks")).toBe("No bookmarks for this identity.");
      expect(text("hypotheses")).toBe("No hypotheses for this identity.");
    });

    it("shows why the field could not load, and keeps its controls off", async () => {
      const state = new MemoryCell();
      state.failReads(new Error("The field is unreadable."));
      page = await openGuestPage({
        guest: GUEST,
        html: HTML,
        resources: {
          input: new MemoryCell(INPUT, { readonly: true }).resource(),
          state: state.resource(),
          output: new MemoryCell().resource(),
          personalAtlas: personalAtlas().resource(),
        },
      });

      expect(await shownError(page)).toContain("The field is unreadable.");
      await page.until(() =>
        text("status-text") === "Atlas synchronization failed"
      );
      expect(byId("time").disabled).toBe(true);
      expect(byId<HTMLButtonElement>("add-observation").disabled).toBe(true);
    });

    it("throws for a document with no `.app` element", async () => {
      await expect(openGuestPage({
        guest: GUEST,
        html: "<!doctype html><html><body></body></html>",
        resources: {},
      })).rejects.toThrow("Signal atlas is missing .app.");
    });
  });

  describe("time cursor", () => {
    it("stores the time the slider is released at, and shows what was observed by then", async () => {
      const { page, output } = await open();
      const slider = byId("time");

      type(slider, "30");
      await page.settled();
      expect(text("time-value")).toBe("T+30");
      expect(output.writes).toEqual([]);
      change(slider);
      await committed(page);

      expect(output.value).toMatchObject({ timeCursor: 30 });
      expect(text("visible-count")).toBe("2");
      expect(shownObservations()).toEqual(["obs-aurora-12", "obs-cinder-27"]);
      expect(shownRoutes()).toEqual(["route-aurora-cinder"]);
    });

    it("keeps showing a time dragged to while an earlier release was stored", async () => {
      const { page, output } = await open();
      const slider = byId("time");

      type(slider, "30");
      change(slider);
      type(slider, "45");
      await committed(page);
      await page.settled();

      expect(output.value).toMatchObject({ timeCursor: 30 });
      expect(text("time-value")).toBe("T+45");
    });

    it("shows why a time could not be stored, and returns to the stored time", async () => {
      const { page, output } = await open();
      output.failWrites(new Error("Time refused."));
      const slider = byId("time");

      type(slider, "30");
      change(slider);

      expect(await shownError(page)).toContain("Time refused.");
      await committed(page);
      await page.settled();
      expect(text("time-value")).toBe("T+72");
      expect(output.value).toMatchObject({ timeCursor: 72 });
    });

    it("clamps the stored and dragged times into a narrowed input window", async () => {
      const { page, input, output } = await open();
      type(byId("time"), "90");

      input.value = { ...INPUT, timeEnd: 50 };
      await output.nextWrite();
      await committed(page);

      expect(output.value).toMatchObject({ timeCursor: 50 });
      expect(text("time-value")).toBe("T+50");
      expect(byId("time").max).toBe("50");
      expect(text("visible-count")).toBe("3");
    });
  });

  describe("band and layers", () => {
    it("stores the band chosen and shows only its observations and flows", async () => {
      const { page, output } = await open();
      const band = byId<HTMLSelectElement>("band");

      band.value = "pulse";
      change(band);
      await committed(page);

      expect(output.value).toMatchObject({ band: "pulse" });
      expect(shownObservations()).toEqual(["obs-aurora-12", "obs-verdant-41"]);
      expect(shownRoutes()).toEqual([
        "route-aurora-cinder",
        "route-verdant-orison",
      ]);
    });

    it("shows why no band could be stored when none is chosen", async () => {
      const { page, output } = await open();
      const band = byId<HTMLSelectElement>("band");

      band.selectedIndex = -1;
      change(band);

      expect(await shownError(page)).toBe("Unknown signal band .");
      await page.settled();
      expect(output.writes).toEqual([]);
    });

    it("stores each layer turned off and hides it", async () => {
      const { page, output } = await open();

      for (const id of ["layer-terrain", "layer-propagation", "layer-routes"]) {
        const toggle = byId(id);
        toggle.checked = false;
        change(toggle);
      }
      await committed(page);

      expect(output.value).toMatchObject({
        layers: { terrain: false, propagation: false, routes: false },
      });
      for (const layer of ["terrain", "heat", "routes"]) {
        expect(
          document.querySelector<SVGGElement>(`.${layer}-layer`)?.style
            .display,
        ).toBe("none");
      }
      expect(
        document.querySelector<SVGGElement>(".observations-layer")?.style
          .display,
      ).toBe("");
    });
  });

  describe("observations", () => {
    it("plots an observation at the dragged time, and clears its label once stored", async () => {
      const { page, state } = await open();
      type(byId("time"), "60");
      type(byId("observation-label"), "  Beacon  ");
      byId<HTMLSelectElement>("observation-band").value = "echo";
      type(byId("observation-strength"), "0.5");

      byId<HTMLButtonElement>("add-observation").click();
      expect(text("status-text")).toBe("Committing 1 field action");
      await committed(page);

      expect(state.value).toMatchObject({
        observations: [
          ...DEFAULT_STATE.observations,
          {
            id: expect.stringMatching(/^observation-/),
            label: "Beacon",
            band: "echo",
            strength: 0.5,
            observedAt: 60,
          },
        ],
      });
      expect(state.writes.map((write) => write.path)).toEqual([
        ["observations"],
      ]);
      expect(byId("observation-label").value).toBe("");
      expect(text("observation-count")).toBe("7");
    });

    it("keeps a label edited while the observation was being stored", async () => {
      const { page, state } = await open();
      type(byId("observation-label"), "Beacon");

      byId<HTMLButtonElement>("add-observation").click();
      type(byId("observation-label"), "Second beacon");
      await committed(page);

      expect(state.value).toMatchObject({
        observations: [...DEFAULT_STATE.observations, { label: "Beacon" }],
      });
      expect(byId("observation-label").value).toBe("Second beacon");
    });

    it("shows why an observation without a label was not plotted", async () => {
      const { page, state } = await open();
      type(byId("observation-label"), "   ");

      byId<HTMLButtonElement>("add-observation").click();

      expect(await shownError(page)).toBe("Observation label is required.");
      await page.settled();
      expect(state.writes).toEqual([]);
    });

    it("shows why an observation with a strength out of range was not plotted", async () => {
      const { page, state } = await open();
      type(byId("observation-label"), "Beacon");
      type(byId("observation-strength"), "1e400");

      byId<HTMLButtonElement>("add-observation").click();

      expect(await shownError(page)).toBe(
        "Observation strength must be a number.",
      );
      await page.settled();
      expect(state.writes).toEqual([]);
    });

    it("reports each field action it is committing", async () => {
      const { page } = await open();

      byId<HTMLButtonElement>("save-view").click();
      byId<HTMLButtonElement>("save-view").click();
      expect(text("status-text")).toBe("Committing 2 field actions");
      await committed(page);
    });
  });

  describe("routes", () => {
    it("connects the two most recent visible observations", async () => {
      const { page, state } = await open();

      byId<HTMLButtonElement>("connect-recent").click();
      await committed(page);

      expect(state.value).toMatchObject({
        routes: [
          ...DEFAULT_STATE.routes,
          {
            fromObservationId: "obs-orison-55",
            toObservationId: "obs-lantern-68",
            band: "drift",
            departedAt: 72,
            duration: 14,
          },
        ],
      });
      expect(shownRoutes()).toHaveLength(5);
      expect(text("route-count")).toBe("6");
    });

    it("connects the observations visible at the dragged time", async () => {
      const { page, state } = await open();
      type(byId("time"), "45");

      byId<HTMLButtonElement>("connect-recent").click();
      await committed(page);

      expect(state.value).toMatchObject({
        routes: [
          ...DEFAULT_STATE.routes,
          {
            fromObservationId: "obs-cinder-27",
            toObservationId: "obs-verdant-41",
            departedAt: 45,
          },
        ],
      });
    });

    it("shows why fewer than two visible observations could not be connected", async () => {
      const { page, state } = await open({
        output: new MemoryCell({ ...DEFAULT_OUTPUT, band: "echo" }),
      });

      byId<HTMLButtonElement>("connect-recent").click();

      expect(await shownError(page)).toBe(
        "At least two observations must be visible to connect.",
      );
      await page.settled();
      expect(state.writes).toEqual([]);
    });

    it("shows why two observations sharing an id could not be connected", async () => {
      const { page, state } = await open({
        state: new MemoryCell({
          observations: [
            storedObservation("twin", "First twin", 10),
            storedObservation("twin", "Second twin", 20),
          ],
          routes: [],
        }),
      });

      byId<HTMLButtonElement>("connect-recent").click();

      expect(await shownError(page)).toBe(
        "A route needs two distinct shared observations.",
      );
      await page.settled();
      expect(state.writes).toEqual([]);
    });
  });

  describe("selection", () => {
    it("stores the observation clicked, and marks it selected", async () => {
      const { page, output } = await open();
      const aurora = observationElement("obs-aurora-12")!;
      expect(aurora.getAttribute("data-selected")).toBe("false");

      aurora.dispatchEvent(new PointerEvent("click", { bubbles: true }));
      await committed(page);

      expect(output.value).toMatchObject({
        selectedObservationId: "obs-aurora-12",
      });
      expect(aurora.getAttribute("data-selected")).toBe("true");
      expect(byId<HTMLButtonElement>("add-bookmark").disabled).toBe(false);
    });

    it("selects an observation on Enter and Space, and on no other key", async () => {
      const { page, output } = await open();
      const press = (id: string, key: string) =>
        observationElement(id)!.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true }),
        );

      press("obs-aurora-12", "a");
      await page.settled();
      expect(text("status-text")).toBe("Field synchronized");
      expect(output.writes).toEqual([]);

      press("obs-aurora-12", "Enter");
      await committed(page);
      expect(output.value).toMatchObject({
        selectedObservationId: "obs-aurora-12",
      });

      press("obs-cinder-27", " ");
      await committed(page);
      expect(output.value).toMatchObject({
        selectedObservationId: "obs-cinder-27",
      });
    });

    it("shows why an observation removed meanwhile could not be selected", async () => {
      const { page, state, output } = await open();

      byId<HTMLButtonElement>("save-view").click();
      observationElement("obs-aurora-12")!.dispatchEvent(
        new PointerEvent("click", { bubbles: true }),
      );
      state.value = {
        observations: DEFAULT_STATE.observations.slice(1),
        routes: [],
      };

      expect(await shownError(page)).toBe(
        "The selected observation is no longer available.",
      );
      await page.settled();
      expect(output.value).toMatchObject({ selectedObservationId: null });
      expect(observationElement("obs-aurora-12")).toBeNull();
    });
  });

  describe("viewport", () => {
    it("stores the view it shows when Save view is clicked", async () => {
      const { page, output } = await open({
        output: new MemoryCell({
          ...DEFAULT_OUTPUT,
          viewport: { x: 10, y: 20, scale: 2 },
        }),
      });
      output.value = DEFAULT_OUTPUT;

      byId<HTMLButtonElement>("save-view").click();
      await committed(page);

      expect(output.value).toMatchObject({
        viewport: { x: 10, y: 20, scale: 2 },
      });
    });

    it("shows the view stored for the session when Restore view is clicked", async () => {
      const { page, output } = await open();
      const viewport = document.querySelector(".viewport")!;
      output.value = {
        ...DEFAULT_OUTPUT,
        band: "echo",
        viewport: { x: 30, y: 40, scale: 3 },
      };
      await page.until(() => byId<HTMLSelectElement>("band").value === "echo");
      expect(viewport.getAttribute("transform")).toBe(
        "translate(0,0) scale(1)",
      );

      byId<HTMLButtonElement>("restore-view").click();
      await page.settled();

      expect(viewport.getAttribute("transform")).toBe(
        "translate(30,40) scale(3)",
      );
      expect(output.writes).toEqual([]);
    });

    it("shows why a view could not be stored", async () => {
      const { page, output } = await open();
      output.failWrites(new Error("View refused."));

      byId<HTMLButtonElement>("save-view").click();

      expect(await shownError(page)).toContain("View refused.");
    });
  });

  describe("bookmarks", () => {
    function bookmarkRows(atlas: MemorySqlite) {
      return atlas.database.prepare(
        "SELECT observation_id, note FROM atlas_bookmarks",
      ).all();
    }

    it("bookmarks the selected observation with its note, and lists it", async () => {
      const { page, atlas } = await open({
        output: new MemoryCell({
          ...DEFAULT_OUTPUT,
          selectedObservationId: "obs-aurora-12",
        }),
      });
      type(byId("bookmark-note"), "  Rising fast ");

      byId<HTMLButtonElement>("add-bookmark").click();
      await committed(page);

      expect(bookmarkRows(atlas)).toEqual([
        { observation_id: "obs-aurora-12", note: "Rising fast" },
      ]);
      expect(listed("bookmarks")).toEqual([["Aurora Shelf", "Rising fast"]]);
      expect(byId("bookmark-note").value).toBe("");
    });

    it("bookmarks with a default note when none is given", async () => {
      const { page, atlas } = await open({
        output: new MemoryCell({
          ...DEFAULT_OUTPUT,
          selectedObservationId: "obs-aurora-12",
        }),
      });

      byId<HTMLButtonElement>("add-bookmark").click();
      await committed(page);

      expect(bookmarkRows(atlas)).toEqual([
        { observation_id: "obs-aurora-12", note: "Revisit this signal" },
      ]);
    });

    it("lists a bookmark of an observation no longer in the field by its id", async () => {
      const atlas = personalAtlas();
      atlas.database.exec(
        "INSERT INTO atlas_bookmarks VALUES ('b1', 'obs-gone', 'Lost', 1)",
      );

      await open({ atlas });

      expect(listed("bookmarks")).toEqual([["obs-gone", "Lost"]]);
    });

    it("lists the bookmarks another session of the same identity adds", async () => {
      const { page, atlas } = await open();

      atlas.database.exec(
        "INSERT INTO atlas_bookmarks VALUES ('b1', 'obs-cinder-27', 'Elsewhere', 1)",
      );
      atlas.changed();
      await page.until(() =>
        listed("bookmarks").length === 1 &&
        listed("bookmarks")[0].length === 2
      );

      expect(listed("bookmarks")).toEqual([["Cinder Cay", "Elsewhere"]]);
    });

    it("reads the fieldbook once for a change made while it loads", async () => {
      const atlas = personalAtlas();
      const resource = atlas.resource();
      const query = resource.methods?.query;
      if (!query) throw new Error("The fieldbook offers no query.");
      const queries: unknown[] = [];
      page = await openGuestPage({
        guest: GUEST,
        html: HTML,
        resources: {
          input: new MemoryCell(INPUT, { readonly: true }).resource(),
          state: new MemoryCell(DEFAULT_STATE).resource(),
          output: new MemoryCell(DEFAULT_OUTPUT).resource(),
          personalAtlas: {
            ...resource,
            methods: {
              ...resource.methods,
              query: (input) => {
                // Another session of the same identity adds a bookmark while
                // this one is still loading.
                if (queries.length === 0) {
                  atlas.database.exec(
                    "INSERT INTO atlas_bookmarks VALUES ('b1', 'obs-cinder-27', 'Early', 1)",
                  );
                  atlas.changed();
                }
                queries.push(input);
                return query(input);
              },
            },
          },
        },
      });
      const app = document.querySelector<HTMLElement>(".app")!;
      await page.until(() => app.dataset.ready === "true");
      await page.settled();

      expect(listed("bookmarks")).toEqual([["Cinder Cay", "Early"]]);
      expect(queries).toHaveLength(2);
    });

    it("shows why the fieldbook could not be read", async () => {
      const { page, atlas } = await open();

      atlas.failOperations(new Error("Fieldbook unreadable."));
      atlas.changed();

      expect(await shownError(page)).toContain("Fieldbook unreadable.");
    });

    it("shows why an observation no longer in the field could not be bookmarked", async () => {
      const { page, atlas } = await open({
        output: new MemoryCell({
          ...DEFAULT_OUTPUT,
          selectedObservationId: "obs-gone",
        }),
      });

      byId<HTMLButtonElement>("add-bookmark").click();

      expect(await shownError(page)).toBe(
        "Choose a visible observation first.",
      );
      await page.settled();
      expect(bookmarkRows(atlas)).toEqual([]);
    });

    it("shows why an empty selection could not be bookmarked", async () => {
      const { page, atlas } = await open({
        output: new MemoryCell({
          ...DEFAULT_OUTPUT,
          selectedObservationId: "",
        }),
      });

      byId<HTMLButtonElement>("add-bookmark").click();

      expect(await shownError(page)).toBe(
        "Choose a visible observation first.",
      );
      await page.settled();
      expect(text("status-text")).toBe("Field synchronized");
      expect(bookmarkRows(atlas)).toEqual([]);
    });

    it("shows why a bookmark could not be stored", async () => {
      const { page, atlas } = await open({
        output: new MemoryCell({
          ...DEFAULT_OUTPUT,
          selectedObservationId: "obs-aurora-12",
        }),
      });
      atlas.failOperations(new Error("Fieldbook is full."));
      type(byId("bookmark-note"), "Keep me");

      byId<HTMLButtonElement>("add-bookmark").click();

      expect(await shownError(page)).toContain("Fieldbook is full.");
      expect(byId("bookmark-note").value).toBe("Keep me");
    });
  });

  describe("hypotheses", () => {
    it("records a hypothesis, lists it, and clears its fields", async () => {
      const { page, atlas } = await open();
      type(byId("hypothesis-title"), " Tidal relay ");
      type(
        byId<HTMLTextAreaElement>("hypothesis-narrative"),
        " Pulses follow the tide. ",
      );

      byId<HTMLButtonElement>("add-hypothesis").click();
      await committed(page);

      expect(
        atlas.database.prepare(
          "SELECT title, narrative, status FROM atlas_hypotheses",
        ).all(),
      ).toEqual([{
        title: "Tidal relay",
        narrative: "Pulses follow the tide.",
        status: "open",
      }]);
      expect(listed("hypotheses")).toEqual([[
        "Tidal relay",
        "Pulses follow the tide.",
      ]]);
      expect(byId("hypothesis-title").value).toBe("");
      expect(byId<HTMLTextAreaElement>("hypothesis-narrative").value).toBe("");
    });

    it("shows why a hypothesis without an interpretation was not recorded", async () => {
      const { page, atlas } = await open();
      type(byId("hypothesis-title"), "Tidal relay");

      byId<HTMLButtonElement>("add-hypothesis").click();

      expect(await shownError(page)).toBe(
        "A hypothesis needs both a title and an interpretation.",
      );
      await page.settled();
      expect(byId("hypothesis-title").value).toBe("Tidal relay");
      expect(
        atlas.database.prepare("SELECT * FROM atlas_hypotheses").all(),
      ).toEqual([]);
    });
  });
});
