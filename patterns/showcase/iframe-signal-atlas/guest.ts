// The iframe generator bundles this pinned module into the self-contained guest.
// deno-lint-ignore no-external-import
import {
  contours,
  curveBasis,
  type D3ZoomEvent,
  type EnterElement,
  geoIdentity,
  geoPath,
  interpolateRgbBasis,
  line,
  scaleSequential,
  select,
  type Selection,
  zoom,
  zoomIdentity,
  type ZoomTransform,
} from "npm:d3@7.9.0";
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
import {
  DEFAULT_INPUT,
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type IframeInputData,
  type IframeOutputData,
  type IframeStateData,
  type SignalBand,
  type SignalObservation,
  type SignalRoute,
} from "./contract.ts";
import {
  canClearSubmittedDraft,
  capturedAction,
  clampTimeCursor,
  FIELD_HEIGHT,
  FIELD_WIDTH,
  propagationValues,
  recentRouteSelection,
  reconcileTimeCursorUntilInputStable,
  routePoints,
  visibleObservations,
  visibleRoutes,
} from "./model.ts";

type BookmarkRow = {
  id: string;
  observation_id: string;
  note: string;
  created_at: number;
};

type HypothesisRow = {
  id: string;
  title: string;
  narrative: string;
  status: string;
  created_at: number;
};

const WIDTH = 960;
const HEIGHT = 600;
const BAND_COLORS: Record<SignalBand, string> = {
  pulse: "#ffbd69",
  drift: "#72e0ca",
  echo: "#bd94ff",
};

const fabric = connectFabric();
const input = fabric.cell<IframeInputData | undefined>("input");
const state = fabric.cell<IframeStateData | undefined>("state");
const output = fabric.cell<IframeOutputData | undefined>("output");
const stateWrite = fabric.cell<IframeStateData>("state");
const outputWrite = fabric.cell<IframeOutputData>("output");
const personalAtlas = fabric.sqlite("personalAtlas");

const element = <T extends Element>(selector: string): T => {
  const match = document.querySelector<T>(selector);
  if (!match) throw new Error(`Signal atlas is missing ${selector}.`);
  return match;
};

const app = element<HTMLElement>(".app");
const title = element<HTMLElement>("#title");
const subtitle = element<HTMLElement>("#subtitle");
const statusText = element<HTMLElement>("#status-text");
const errorText = element<HTMLElement>("#error");
const timeInput = element<HTMLInputElement>("#time");
const timeValue = element<HTMLElement>("#time-value");
const bandSelect = element<HTMLSelectElement>("#band");
const terrainToggle = element<HTMLInputElement>("#layer-terrain");
const propagationToggle = element<HTMLInputElement>("#layer-propagation");
const routesToggle = element<HTMLInputElement>("#layer-routes");
const observationCount = element<HTMLElement>("#observation-count");
const routeCount = element<HTMLElement>("#route-count");
const visibleCount = element<HTMLElement>("#visible-count");
const observationLabel = element<HTMLInputElement>("#observation-label");
const observationBand = element<HTMLSelectElement>("#observation-band");
const observationStrength = element<HTMLInputElement>(
  "#observation-strength",
);
const addObservationButton = element<HTMLButtonElement>("#add-observation");
const connectRecentButton = element<HTMLButtonElement>("#connect-recent");
const saveViewButton = element<HTMLButtonElement>("#save-view");
const restoreViewButton = element<HTMLButtonElement>("#restore-view");
const bookmarkNote = element<HTMLInputElement>("#bookmark-note");
const addBookmarkButton = element<HTMLButtonElement>("#add-bookmark");
const bookmarksList = element<HTMLUListElement>("#bookmarks");
const hypothesisTitle = element<HTMLInputElement>("#hypothesis-title");
const hypothesisNarrative = element<HTMLTextAreaElement>(
  "#hypothesis-narrative",
);
const addHypothesisButton = element<HTMLButtonElement>("#add-hypothesis");
const hypothesesList = element<HTMLUListElement>("#hypotheses");
const controls = Array.from(
  document.querySelectorAll<
    | HTMLButtonElement
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLTextAreaElement
  >("button, input, select, textarea"),
);

const svg = select<SVGSVGElement, unknown>("#atlas")
  .attr("viewBox", `0 0 ${WIDTH} ${HEIGHT}`);
svg.append("rect")
  .attr("width", WIDTH)
  .attr("height", HEIGHT)
  .attr("fill", "#071821");
const gridLayer = svg.append("g").attr("aria-hidden", "true");
const viewportLayer = svg.append("g").attr("class", "viewport");
const terrainLayer = viewportLayer.append("g").attr("class", "terrain-layer");
const heatLayer = viewportLayer.append("g").attr("class", "heat-layer");
const routesLayer = viewportLayer.append("g").attr("class", "routes-layer");
const observationsLayer = viewportLayer.append("g").attr(
  "class",
  "observations-layer",
);

gridLayer.selectAll("line.longitude")
  .data([120, 240, 360, 480, 600, 720, 840])
  .join("line")
  .attr("x1", (value: number) => value)
  .attr("x2", (value: number) => value)
  .attr("y1", 0)
  .attr("y2", HEIGHT)
  .attr("stroke", "#17303b")
  .attr("stroke-width", 0.7);
gridLayer.selectAll("line.latitude")
  .data([100, 200, 300, 400, 500])
  .join("line")
  .attr("x1", 0)
  .attr("x2", WIDTH)
  .attr("y1", (value: number) => value)
  .attr("y2", (value: number) => value)
  .attr("stroke", "#17303b")
  .attr("stroke-width", 0.7);

const projection = geoIdentity()
  .reflectY(false)
  .scale(WIDTH / FIELD_WIDTH);
const mapPath = geoPath(projection);
const flowLine = line<[number, number]>().curve(curveBasis);
const heatColor = scaleSequential(
  interpolateRgbBasis(["#123a49", "#2c847d", "#80ead3", "#ffe5a3"]),
).domain([0.08, 0.72]);

let hydrated = false;
let disposed = false;
let pendingActions = 0;
let inputValue: IframeInputData = DEFAULT_INPUT;
let stateValue: IframeStateData = DEFAULT_STATE;
let outputValue: IframeOutputData = DEFAULT_OUTPUT;
let bookmarks: BookmarkRow[] = [];
let hypotheses: HypothesisRow[] = [];
let localTransform: ZoomTransform = zoomIdentity;
let actionQueue: Promise<void> = Promise.resolve();
let databaseRefresh: Promise<void> = Promise.resolve();
let timeDraft: number | undefined;
let timeDraftGeneration = 0;
let inputGeneration = 0;

type DraftControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
type DraftForm = { generation: number };

function trackDraftForm(controls: readonly DraftControl[]): DraftForm {
  const form = { generation: 0 };
  for (const control of controls) {
    control.addEventListener(
      control instanceof HTMLSelectElement ? "change" : "input",
      () => form.generation++,
    );
  }
  return form;
}

function clearSubmittedDraft(
  controls: readonly (HTMLInputElement | HTMLTextAreaElement)[],
  form: DraftForm,
  submittedGeneration: number,
): void {
  if (canClearSubmittedDraft(submittedGeneration, form.generation)) {
    for (const control of controls) control.value = "";
  }
}

const observationDraftForm = trackDraftForm([
  observationLabel,
  observationBand,
  observationStrength,
]);
const bookmarkDraftForm = trackDraftForm([bookmarkNote]);
const hypothesisDraftForm = trackDraftForm([
  hypothesisTitle,
  hypothesisNarrative,
]);

const zoomBehavior = zoom<SVGSVGElement, unknown>()
  .scaleExtent([0.75, 5])
  .on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
    localTransform = event.transform;
    viewportLayer.attr("transform", localTransform.toString());
  });
svg.call(zoomBehavior);

function showError(cause: unknown): void {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  errorText.textContent = error.message;
}

function clearError(): void {
  errorText.textContent = "";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function hashUnit(value: string): number {
  let hash = inputValue.fieldSeed >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash / 0xffffffff;
}

function terrainValues(): number[] {
  const seedPhase = inputValue.fieldSeed * 0.0017;
  const values: number[] = [];
  for (let y = 0; y < FIELD_HEIGHT; y++) {
    for (let x = 0; x < FIELD_WIDTH; x++) {
      const broad = Math.sin(x * 0.117 + seedPhase) *
        Math.cos(y * 0.143 - seedPhase * 0.7);
      const middle = Math.sin((x + y) * 0.071 + seedPhase * 1.4);
      const ridge = Math.cos(x * 0.249 - y * 0.193 + seedPhase * 2.1);
      const edge = Math.min(x, FIELD_WIDTH - x, y, FIELD_HEIGHT - y) / 18;
      values.push(
        clamp(0.43 + broad * 0.21 + middle * 0.15 + ridge * 0.08, 0, 1) *
          clamp(edge, 0, 1),
      );
    }
  }
  return values;
}

function projectedPoint(observation: SignalObservation): [number, number] {
  const point = projection([observation.x, observation.y]);
  return point ?? [observation.x, observation.y];
}

function projectedRoutePoints(
  route: SignalRoute,
  observationsById: ReadonlyMap<string, SignalObservation>,
): [number, number][] {
  const from = projectedPoint(observationsById.get(route.fromObservationId)!);
  const to = projectedPoint(observationsById.get(route.toObservationId)!);
  return routePoints(from, to);
}

function renderList(
  list: HTMLUListElement,
  rows: Array<{ primary: string; secondary: string }>,
  emptyText: string,
): void {
  list.replaceChildren();
  if (rows.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = emptyText;
    list.append(empty);
    return;
  }
  for (const row of rows) {
    const item = document.createElement("li");
    const primary = document.createElement("strong");
    const secondary = document.createElement("div");
    primary.textContent = row.primary;
    secondary.textContent = row.secondary;
    item.append(primary, secondary);
    list.append(item);
  }
}

function render(): void {
  title.textContent = inputValue.title;
  subtitle.textContent = inputValue.subtitle;
  app.dataset.ready = String(hydrated);
  statusText.textContent = !hydrated
    ? "Synchronizing field records"
    : pendingActions > 0
    ? `Committing ${pendingActions} field action${
      pendingActions === 1 ? "" : "s"
    }`
    : "Field synchronized";

  controls.forEach((control) => control.disabled = !hydrated);
  addBookmarkButton.disabled = !hydrated ||
    outputValue.selectedObservationId === null;
  timeInput.min = String(Math.min(inputValue.timeStart, inputValue.timeEnd));
  timeInput.max = String(Math.max(inputValue.timeStart, inputValue.timeEnd));
  const effectiveTime = clampTimeCursor(
    outputValue.timeCursor,
    inputValue.timeStart,
    inputValue.timeEnd,
  );
  const displayedTime = clampTimeCursor(
    timeDraft ?? effectiveTime,
    inputValue.timeStart,
    inputValue.timeEnd,
  );
  timeInput.value = String(displayedTime);
  timeValue.textContent = `T+${displayedTime}`;
  bandSelect.value = outputValue.band;
  terrainToggle.checked = outputValue.layers.terrain;
  propagationToggle.checked = outputValue.layers.propagation;
  routesToggle.checked = outputValue.layers.routes;

  const visible = visibleObservations(
    stateValue.observations,
    effectiveTime,
    outputValue.band,
  );
  const timeVisible = visibleObservations(
    stateValue.observations,
    effectiveTime,
    "all",
  );
  const timeVisibleById = new Map(
    timeVisible.map((observation) => [observation.id, observation]),
  );
  const routes = visibleRoutes(
    stateValue.routes,
    stateValue.observations,
    effectiveTime,
    outputValue.band,
  );
  observationCount.textContent = String(stateValue.observations.length);
  routeCount.textContent = String(stateValue.routes.length);
  visibleCount.textContent = String(visible.length);

  const land = contours()
    .size([FIELD_WIDTH, FIELD_HEIGHT])
    .thresholds([0.34, 0.46, 0.58, 0.7])(terrainValues());
  terrainLayer
    .style("display", outputValue.layers.terrain ? null : "none")
    .selectAll("path.terrain")
    .data(land, (datum: unknown) => String((datum as { value: number }).value))
    .join("path")
    .attr("class", "terrain")
    .attr("d", mapPath)
    .attr("fill", (datum: unknown) => {
      const value = (datum as { value: number }).value;
      return value < 0.46
        ? "#173740"
        : value < 0.58
        ? "#294b43"
        : value < 0.7
        ? "#46634e"
        : "#708069";
    })
    .attr("fill-opacity", 0.78);

  const propagation = contours()
    .size([FIELD_WIDTH, FIELD_HEIGHT])
    .thresholds([0.08, 0.16, 0.28, 0.42, 0.58, 0.72])(
      propagationValues(
        visible,
        effectiveTime,
        FIELD_WIDTH,
        FIELD_HEIGHT,
      ),
    );
  heatLayer
    .style("display", outputValue.layers.propagation ? null : "none")
    .selectAll("path.heat-contour")
    .data(
      propagation,
      (datum: unknown) => String((datum as { value: number }).value),
    )
    .join("path")
    .attr("class", "heat-contour")
    .attr("d", mapPath)
    .attr(
      "fill",
      (datum: unknown) => heatColor((datum as { value: number }).value),
    )
    .attr(
      "fill-opacity",
      (datum: unknown) => 0.08 + (datum as { value: number }).value * 0.24,
    )
    .attr("stroke-opacity", 0.35);

  routesLayer
    .style("display", outputValue.layers.routes ? null : "none")
    .selectAll<SVGPathElement, SignalRoute>("path.flow-route")
    .data(routes, (route: SignalRoute) => route.id)
    .join("path")
    .attr("class", "flow-route")
    .attr("data-route-id", (route: SignalRoute) => route.id)
    .attr(
      "d",
      (route: SignalRoute) =>
        flowLine(projectedRoutePoints(route, timeVisibleById)),
    )
    .attr("stroke", (route: SignalRoute) => BAND_COLORS[route.band])
    .attr("stroke-opacity", (route: SignalRoute) => {
      const progress = clamp(
        (effectiveTime - route.departedAt) / route.duration,
        0,
        1,
      );
      return 0.24 + progress * 0.66;
    })
    .attr("aria-label", (route: SignalRoute) => {
      const from = timeVisibleById.get(route.fromObservationId)?.label;
      const to = timeVisibleById.get(route.toObservationId)?.label;
      return `${route.band} route from ${from} to ${to}`;
    });

  const observations = observationsLayer
    .selectAll<SVGGElement, SignalObservation>("g.observation")
    .data(visible, (observation: SignalObservation) => observation.id)
    .join((
      enter: Selection<
        EnterElement,
        SignalObservation,
        SVGGElement,
        unknown
      >,
    ) => {
      const group = enter.append("g")
        .attr("class", "observation")
        .attr("role", "button")
        .attr("tabindex", 0);
      group.append("circle").attr("class", "halo");
      group.append("circle").attr("class", "core");
      group.append("text").attr("x", 9).attr("y", -9);
      return group;
    })
    .attr(
      "data-observation-id",
      (observation: SignalObservation) => observation.id,
    )
    .attr(
      "data-selected",
      (observation: SignalObservation) =>
        String(observation.id === outputValue.selectedObservationId),
    )
    .attr("transform", (observation: SignalObservation) => {
      const [x, y] = projectedPoint(observation);
      return `translate(${x},${y})`;
    })
    .attr(
      "aria-label",
      (observation: SignalObservation) =>
        `${observation.label}, ${observation.band} band, strength ${
          observation.strength.toFixed(2)
        }, observed at T+${observation.observedAt}`,
    )
    .on("click", (_event: PointerEvent, observation: SignalObservation) => {
      void enqueueAction(() => selectObservation(observation.id)).catch(
        showError,
      );
    })
    .on("keydown", (event: KeyboardEvent, observation: SignalObservation) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      void enqueueAction(() => selectObservation(observation.id)).catch(
        showError,
      );
    });

  observations.select("circle.halo")
    .attr(
      "r",
      (observation: SignalObservation) => 8 + observation.strength * 10,
    )
    .attr(
      "stroke",
      (observation: SignalObservation) => BAND_COLORS[observation.band],
    );
  observations.select("circle.core")
    .attr(
      "r",
      (observation: SignalObservation) => 3.2 + observation.strength * 2,
    )
    .attr(
      "fill",
      (observation: SignalObservation) => BAND_COLORS[observation.band],
    );
  observations.select("text")
    .text((observation: SignalObservation) => observation.label);

  renderList(
    bookmarksList,
    bookmarks.map((bookmark) => ({
      primary:
        stateValue.observations.find((observation) =>
          observation.id === bookmark.observation_id
        )?.label ?? bookmark.observation_id,
      secondary: bookmark.note,
    })),
    "No bookmarks for this identity.",
  );
  renderList(
    hypothesesList,
    hypotheses.map((hypothesis) => ({
      primary: hypothesis.title,
      secondary: hypothesis.narrative,
    })),
    "No hypotheses for this identity.",
  );
}

function enqueueAction<T>(action: () => Promise<T>): Promise<T> {
  pendingActions++;
  clearError();
  render();
  const run = actionQueue.then(action);
  actionQueue = run.then(() => undefined, () => undefined);
  return run.finally(() => {
    pendingActions--;
    render();
  });
}

async function addObservation(options: {
  label: string;
  band: SignalBand;
  strength: number;
  observedAt: number;
}): Promise<string> {
  const label = options.label.trim();
  if (!label) throw new Error("Observation label is required.");
  if (!Number.isFinite(options.strength)) {
    throw new Error("Observation strength must be a number.");
  }
  const id = `observation-${crypto.randomUUID()}`;
  const angle = hashUnit(`${id}:angle`) * Math.PI * 2;
  const radius = 17 + hashUnit(`${id}:radius`) * 25;
  const observation: SignalObservation = {
    id,
    label,
    x: clamp(52 + Math.cos(angle) * radius, 8, FIELD_WIDTH - 8),
    y: clamp(38 + Math.sin(angle) * radius, 8, FIELD_HEIGHT - 8),
    observedAt: clampTimeCursor(
      Math.round(options.observedAt),
      inputValue.timeStart,
      inputValue.timeEnd,
    ),
    strength: clamp(options.strength, 0.1, 1),
    band: options.band,
  };
  await stateWrite.key("observations").push(observation);
  return id;
}

async function addRoute(options: {
  fromObservationId: string;
  toObservationId: string;
  band: SignalBand;
  departedAt: number;
}): Promise<string> {
  const from = stateValue.observations.find((observation) =>
    observation.id === options.fromObservationId
  );
  const to = stateValue.observations.find((observation) =>
    observation.id === options.toObservationId
  );
  if (!from || !to || from.id === to.id) {
    throw new Error("A route needs two distinct shared observations.");
  }
  const route: SignalRoute = {
    id: `route-${crypto.randomUUID()}`,
    fromObservationId: from.id,
    toObservationId: to.id,
    departedAt: clampTimeCursor(
      options.departedAt,
      inputValue.timeStart,
      inputValue.timeEnd,
    ),
    duration: Math.max(
      6,
      Math.round(Math.hypot(to.x - from.x, to.y - from.y) / 2),
    ),
    band: options.band,
  };
  await stateWrite.key("routes").push(route);
  return route.id;
}

async function connectRecent(criteria: {
  timeCursor: number;
  band: SignalBand | "all";
}): Promise<string> {
  await state.pull();
  stateValue = state.get() ?? DEFAULT_STATE;
  const selection = recentRouteSelection(
    stateValue.observations,
    criteria.timeCursor,
    criteria.band,
    inputValue.timeStart,
    inputValue.timeEnd,
  );
  if (selection.observations.length < 2) {
    throw new Error("At least two observations must be visible to connect.");
  }
  return await addRoute({
    fromObservationId: selection.observations[0].id,
    toObservationId: selection.observations[1].id,
    band: selection.observations[1].band,
    departedAt: selection.timeCursor,
  });
}

async function selectObservation(id: string | null): Promise<void> {
  if (
    id !== null &&
    !stateValue.observations.some((observation) => observation.id === id)
  ) {
    throw new Error("The selected observation is no longer available.");
  }
  await outputWrite.key("selectedObservationId").set(id);
}

async function setTimeCursor(value: number): Promise<void> {
  if (!Number.isFinite(value)) throw new Error("Time cursor must be a number.");
  await outputWrite.key("timeCursor").set(
    clampTimeCursor(
      Math.round(value),
      inputValue.timeStart,
      inputValue.timeEnd,
    ),
  );
}

async function setBand(value: SignalBand | "all"): Promise<void> {
  if (!["all", "pulse", "drift", "echo"].includes(value)) {
    throw new Error(`Unknown signal band ${value}.`);
  }
  await outputWrite.key("band").set(value);
}

async function setLayer(
  layer: keyof IframeOutputData["layers"],
  enabled: boolean,
): Promise<void> {
  await outputWrite.key("layers").key(layer).set(enabled);
}

async function saveViewport(
  viewport: IframeOutputData["viewport"],
): Promise<void> {
  await outputWrite.key("viewport").set(viewport);
}

function restoreViewport(): void {
  const viewport = outputValue.viewport;
  svg.call(
    zoomBehavior.transform,
    zoomIdentity.translate(viewport.x, viewport.y).scale(viewport.scale),
  );
}

async function addBookmark(
  observationId: string,
  note: string,
): Promise<string> {
  const observation = stateValue.observations.find((candidate) =>
    candidate.id === observationId
  );
  if (!observation) throw new Error("Choose a visible observation first.");
  const id = `bookmark-${crypto.randomUUID()}`;
  await personalAtlas.exec(
    "INSERT INTO atlas_bookmarks (id, observation_id, note, created_at) VALUES (?, ?, ?, ?)",
    [id, observation.id, note.trim() || "Revisit this signal", Date.now()],
  );
  await refreshPersonalAtlas();
  return id;
}

async function addHypothesis(
  titleValue: string,
  narrativeValue: string,
): Promise<string> {
  const trimmedTitle = titleValue.trim();
  const trimmedNarrative = narrativeValue.trim();
  if (!trimmedTitle || !trimmedNarrative) {
    throw new Error("A hypothesis needs both a title and an interpretation.");
  }
  const id = `hypothesis-${crypto.randomUUID()}`;
  await personalAtlas.exec(
    "INSERT INTO atlas_hypotheses (id, title, narrative, status, created_at) VALUES (?, ?, ?, ?, ?)",
    [id, trimmedTitle, trimmedNarrative, "open", Date.now()],
  );
  await refreshPersonalAtlas();
  return id;
}

async function refreshPersonalAtlas(): Promise<void> {
  const refresh = databaseRefresh.then(async () => {
    const [bookmarkResult, hypothesisResult] = await Promise.all([
      personalAtlas.query<BookmarkRow>(
        "SELECT id, observation_id, note, created_at FROM atlas_bookmarks ORDER BY created_at, id",
      ),
      personalAtlas.query<HypothesisRow>(
        "SELECT id, title, narrative, status, created_at FROM atlas_hypotheses ORDER BY created_at, id",
      ),
    ]);
    bookmarks = bookmarkResult.rows;
    hypotheses = hypothesisResult.rows;
    render();
  });
  databaseRefresh = refresh.catch(() => undefined);
  await refresh;
}

timeInput.addEventListener("input", () => {
  timeDraftGeneration++;
  timeDraft = Number(timeInput.value);
  timeValue.textContent = `T+${timeDraft}`;
});
timeInput.addEventListener("change", () => {
  const capturedTime = Number(timeInput.value);
  const capturedGeneration = timeDraftGeneration;
  timeDraft = capturedTime;
  void enqueueAction(capturedAction(capturedTime, setTimeCursor)).then(
    () => {
      if (
        canClearSubmittedDraft(capturedGeneration, timeDraftGeneration)
      ) timeDraft = undefined;
      render();
    },
    (cause) => {
      if (
        canClearSubmittedDraft(capturedGeneration, timeDraftGeneration)
      ) timeDraft = undefined;
      showError(cause);
      render();
    },
  );
});
bandSelect.addEventListener("change", () => {
  void enqueueAction(capturedAction(
    bandSelect.value as SignalBand | "all",
    setBand,
  ))
    .catch(showError);
});
terrainToggle.addEventListener("change", () => {
  void enqueueAction(capturedAction(
    terrainToggle.checked,
    (enabled) => setLayer("terrain", enabled),
  )).catch(
    showError,
  );
});
propagationToggle.addEventListener("change", () => {
  void enqueueAction(capturedAction(
    propagationToggle.checked,
    (enabled) => setLayer("propagation", enabled),
  ))
    .catch(showError);
});
routesToggle.addEventListener("change", () => {
  void enqueueAction(capturedAction(
    routesToggle.checked,
    (enabled) => setLayer("routes", enabled),
  )).catch(
    showError,
  );
});
addObservationButton.addEventListener("click", () => {
  const draft = {
    label: observationLabel.value,
    band: observationBand.value as SignalBand,
    strength: Number(observationStrength.value),
    observedAt: timeDraft ?? outputValue.timeCursor,
    generation: observationDraftForm.generation,
  };
  void enqueueAction(capturedAction(draft, async (captured) => {
    await addObservation(captured);
    clearSubmittedDraft(
      [observationLabel],
      observationDraftForm,
      captured.generation,
    );
  })).catch(showError);
});
connectRecentButton.addEventListener("click", () => {
  const criteria = {
    timeCursor: clampTimeCursor(
      timeDraft ?? Number(timeInput.value),
      inputValue.timeStart,
      inputValue.timeEnd,
    ),
    band: bandSelect.value as SignalBand | "all",
  };
  void enqueueAction(capturedAction(criteria, connectRecent)).catch(showError);
});
saveViewButton.addEventListener("click", () => {
  const viewport = {
    x: localTransform.x,
    y: localTransform.y,
    scale: localTransform.k,
  };
  void enqueueAction(capturedAction(viewport, saveViewport)).catch(showError);
});
restoreViewButton.addEventListener("click", restoreViewport);
addBookmarkButton.addEventListener("click", () => {
  const selectedId = outputValue.selectedObservationId;
  if (!selectedId) {
    showError(new Error("Choose a visible observation first."));
    return;
  }
  const draft = {
    observationId: selectedId,
    note: bookmarkNote.value,
    generation: bookmarkDraftForm.generation,
  };
  void enqueueAction(capturedAction(draft, async (captured) => {
    await addBookmark(captured.observationId, captured.note);
    clearSubmittedDraft([bookmarkNote], bookmarkDraftForm, captured.generation);
  })).catch(showError);
});
addHypothesisButton.addEventListener("click", () => {
  const draft = {
    title: hypothesisTitle.value,
    narrative: hypothesisNarrative.value,
    generation: hypothesisDraftForm.generation,
  };
  void enqueueAction(capturedAction(draft, async (captured) => {
    await addHypothesis(captured.title, captured.narrative);
    clearSubmittedDraft(
      [hypothesisTitle, hypothesisNarrative],
      hypothesisDraftForm,
      captured.generation,
    );
  })).catch(showError);
});

const cancelInput = input.sink((value) => {
  inputGeneration++;
  inputValue = value ?? DEFAULT_INPUT;
  if (timeDraft !== undefined) {
    timeDraft = clampTimeCursor(
      timeDraft,
      inputValue.timeStart,
      inputValue.timeEnd,
    );
  }
  if (hydrated) {
    void enqueueAction(reconcileCurrentTimeCursor).catch(showError);
  }
  render();
});
const cancelState = state.sink((value) => {
  stateValue = value ?? DEFAULT_STATE;
  render();
});
const cancelOutput = output.sink((value) => {
  outputValue = value ?? DEFAULT_OUTPUT;
  render();
});
const cancelDatabase = personalAtlas.sink(() => {
  if (!hydrated) return;
  void refreshPersonalAtlas().catch(showError);
});

function dispose(): void {
  if (disposed) return;
  disposed = true;
  cancelInput();
  cancelState();
  cancelOutput();
  cancelDatabase();
  fabric.disconnect();
}
globalThis.addEventListener("pagehide", dispose, { once: true });

async function reconcileCurrentTimeCursor(): Promise<void> {
  const timeCursor = await reconcileTimeCursorUntilInputStable(
    () => inputGeneration,
    async () => {
      await output.pull();
      outputValue = output.get() ?? DEFAULT_OUTPUT;
      return outputValue.timeCursor;
    },
    (value) => outputWrite.key("timeCursor").set(value),
    () => ({
      timeStart: inputValue.timeStart,
      timeEnd: inputValue.timeEnd,
    }),
  );
  outputValue = { ...outputValue, timeCursor };
}

try {
  await Promise.all([input.pull(), state.pull(), output.pull()]);
  await Promise.all([
    stateWrite.initialize(DEFAULT_STATE),
    outputWrite.initialize(DEFAULT_OUTPUT),
  ]);
  inputValue = input.get() ?? DEFAULT_INPUT;
  stateValue = state.get() ?? DEFAULT_STATE;
  outputValue = output.get() ?? DEFAULT_OUTPUT;
  await refreshPersonalAtlas();
  await reconcileCurrentTimeCursor();
  hydrated = true;
  restoreViewport();
  render();
} catch (cause) {
  showError(cause);
  statusText.textContent = "Atlas synchronization failed";
  dispose();
}
