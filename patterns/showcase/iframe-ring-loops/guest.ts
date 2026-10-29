/**
 * Browser guest of Ring Loops. It draws the rings on a canvas, plays the
 * placed notes on a Web Audio graph from a step clock that exists only in this
 * browser, and writes each placement to the shared state as one keyed cell, so
 * two people editing different cells never write the same value. Through the
 * `jam` presence room it shows where everyone else's pointer and playback
 * are, and plays the jam pads they press; nothing in the room is stored.
 */

import {
  connectFabric,
  type PresenceRoomEvent,
} from "@commonfabric/iframe-sandbox/guest";
import {
  DEFAULT_INPUT,
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type PlacedNote,
} from "./contract.ts";
import {
  authorNameOf,
  authorTallies,
  type Cell,
  cellAt,
  cellKey,
  type CellMove,
  type CellShape,
  cellShape,
  defaultColor,
  type DrumSound,
  drumSound,
  followStep,
  freshPresses,
  HAND_FACET,
  handTurn,
  JAM_ROOM,
  keyForPad,
  laneLabel,
  laneMidi,
  lastPressId,
  type LiveNote,
  liveNotes,
  LOOK_FACET,
  MAX_TEMPO_BPM,
  midiToFrequency,
  MIN_TEMPO_BPM,
  neighborCell,
  normalizeTempo,
  NOTE_COLORS,
  noteAuthorName,
  notesAtStep,
  padForKey,
  type PadPress,
  type Peer,
  type PeerHand,
  peerHandPosition,
  POINTER_FACET,
  positionAt,
  presenceName,
  PRESSES_FACET,
  readPeer,
  retimed,
  type Ring,
  ringBands,
  type RingLayout,
  ringLayoutOf,
  type RingPoint,
  secondsPerStep,
  STEPS_PER_BEAT,
  stepsBetween,
  timeOfStep,
  toggleEdit,
  type Transport,
  withPress,
} from "./model.ts";

/** How far ahead of the audio clock notes are queued, in seconds. */
const LOOKAHEAD_SECONDS = 0.12;

/** Delay between pressing Play and the first step, in seconds. */
const START_DELAY_SECONDS = 0.06;

/** How long a cell stays lit after its note sounds, in seconds. */
const FLASH_SECONDS = 0.28;

/**
 * Seconds after which a playing hand is announced again, so that peers'
 * extrapolation, and anyone following, does not drift with the audio clock.
 */
const HAND_REANNOUNCE_SECONDS = 4;

/** Steps by which the echo trails the note it repeats. */
const ECHO_STEPS = 3;

/** Gain an envelope decays to, since an exponential ramp cannot reach zero. */
const SILENCE = 0.001;

/** Share of the canvas's half-width the outermost ring reaches. */
const RING_EXTENT = 0.97;

const TAU = 2 * Math.PI;

const HINT =
  "Click a cell, or pick one with the arrow keys and press Enter, to place or remove a note.";

/** Arrow keys, and where each moves the selected cell. */
const CELL_KEYS = new Map<string, CellMove>([
  ["ArrowRight", "clockwise"],
  ["ArrowLeft", "anticlockwise"],
  ["ArrowUp", "outward"],
  ["ArrowDown", "inward"],
]);

/** Cell the keyboard selects first: the innermost lane at the top. */
const FIRST_CELL: Cell = { ringIndex: 0, step: 0, lane: 0 };

/** The audio graph every voice plays into. */
interface AudioEngine {
  /** Context whose clock the step clock is anchored to. */
  readonly context: AudioContext;

  /** Volume control that every voice and the echo feed. */
  readonly master: GainNode;

  /** Input of the echo that the bell and pluck voices also feed. */
  readonly echo: DelayNode;

  /** One second of white noise that the drum voices read from. */
  readonly noise: AudioBuffer;
}

const fabric = connectFabric();
const input = fabric.cell<typeof DEFAULT_INPUT>("input");
const state = fabric.cell<typeof DEFAULT_STATE>("state");
const output = fabric.cell<typeof DEFAULT_OUTPUT>("output");
const notesCell = state.key("notes");

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) throw new Error("Ring Loops needs a `#root` element.");

const abort = new AbortController();
const { signal } = abort;
let hydrated = false;
let disposed = false;
let authorId = "";
let layout: RingLayout | undefined;
let layoutErrorMessage: string | undefined;
let live: LiveNote[] = [];
let hoverCell: Cell | undefined;
let hoverRowIndex: number | undefined;
let audio: AudioEngine | undefined;
let transport: Transport | undefined;
let scheduledThrough = 0;
let animationFrame: number | undefined;
let tempoDraft: number | undefined;
let volumeDraft: number | undefined;
// The muted rings as the last mute click left them, until the store confirms
// that write, so that a second click builds on the first.
let mutedDraft: readonly string[] | undefined;
let clearArmed = false;
// Writes on their way to the shared state, by cell key. They are drawn and
// played ahead of the stored notes until the write settles.
const pendingEdits = new Map<string, PlacedNote | null>();
// Audio time at which each cell last sounded, by cell key.
const flashes = new Map<string, number>();

const room = fabric.presence(JAM_ROOM);
let leaveRoom: (() => void) | undefined;
let roomStatus: "joining" | "live" | "lost" | "unsupported" = "joining";
// Everyone else in the room, by membership.
const peers = new Map<string, Peer>();
// Number of the last press played for each peer, so that a peer's new record
// plays only the presses that are new in it.
const pressesHeard = new Map<string, number>();
// What each person last played on a pad, this viewer's own under `SELF`.
const lastJammed = new Map<string, string>();
const SELF = "";
let ownPresses: PadPress[] = [];
// Whether a peer pressed a pad while this browser's audio had not started, so
// that the hint can say how to hear the next one.
let missedPeerPress = false;
let nextPressId = 0;
let publishedName: string | undefined;
let publishedColor: string | undefined;
// Wall-clock time of the last hand announced while playing.
let handAnnouncedAt = 0;
// Membership of the peer this browser's playback follows, if any.
let following: string | undefined;
// Signature of what the people list last showed, so that a peer's pointer
// moving does not rebuild it, and its buttons stay under the user's click.
let shownPeople = "";
// The jam pads, by ring index and lane.
const padButtons = new Map<string, HTMLButtonElement>();

//
// Document
//

const app = document.createElement("main");
app.className = "app";
app.dataset.testid = "ring-loops";

const stage = document.createElement("section");
stage.className = "stage";
const canvas = document.createElement("canvas");
canvas.className = "rings";
canvas.dataset.testid = "ring-canvas";
canvas.dataset.ready = "false";
canvas.tabIndex = 0;
canvas.setAttribute(
  "aria-label",
  "Rings of note cells. Move between cells with the arrow keys: left and right go around a ring, up and down go outward and inward. Enter or Space places or removes a note.",
);
const readout = document.createElement("p");
readout.className = "readout";
readout.dataset.testid = "cell-readout";
readout.setAttribute("aria-live", "polite");
readout.textContent = HINT;
stage.append(canvas, readout);

const drawing = contextOf(canvas);

const panel = document.createElement("section");
panel.className = "panel";

const heading = document.createElement("div");
const title = document.createElement("h1");
title.textContent = DEFAULT_INPUT.setup.title;
const deck = document.createElement("p");
deck.className = "deck";
deck.textContent =
  "Everyone here shares the notes and the tempo. Playback runs in each browser on its own, so stop yours to edit while the others keep listening.";
heading.append(title, deck);

const playButton = document.createElement("button");
playButton.type = "button";
playButton.className = "play";
playButton.dataset.testid = "play-toggle";
playButton.textContent = "Play";
playButton.disabled = true;

const tempoSlider = document.createElement("input");
tempoSlider.type = "range";
tempoSlider.min = String(MIN_TEMPO_BPM);
tempoSlider.max = String(MAX_TEMPO_BPM);
tempoSlider.step = "1";
tempoSlider.disabled = true;
tempoSlider.dataset.testid = "tempo";
const tempoReadout = document.createElement("output");
const tempoField = makeField("Tempo, shared", tempoSlider, tempoReadout);

const volumeSlider = document.createElement("input");
volumeSlider.type = "range";
volumeSlider.min = "0";
volumeSlider.max = "1";
volumeSlider.step = "0.01";
volumeSlider.disabled = true;
volumeSlider.dataset.testid = "volume";
const volumeReadout = document.createElement("output");
const volumeField = makeField("Volume, yours", volumeSlider, volumeReadout);

const colorGroup = document.createElement("div");
const colorHeading = document.createElement("h2");
colorHeading.textContent = "Your note color";
const swatches = document.createElement("div");
swatches.className = "swatches";
const swatchButtons = NOTE_COLORS.map((color, index) => {
  const swatch = document.createElement("button");
  swatch.type = "button";
  swatch.className = "swatch";
  swatch.style.setProperty("--swatch", color);
  swatch.setAttribute("aria-label", `Note color ${index + 1}`);
  swatch.dataset.color = color;
  swatch.disabled = true;
  swatch.addEventListener("click", () => {
    clearError();
    void output.key("color").set(color).catch(showError);
  }, { signal });
  return swatch;
});
swatches.append(...swatchButtons);
const viewerLine = document.createElement("p");
viewerLine.className = "viewer";
viewerLine.dataset.testid = "viewer-name";
colorGroup.append(colorHeading, swatches, viewerLine);

const jamGroup = document.createElement("div");
const jamHeading = document.createElement("h2");
jamHeading.textContent = "Jam";
const padGrid = document.createElement("div");
padGrid.className = "pad-grid";
padGrid.dataset.testid = "jam-pads";
const jamHint = document.createElement("p");
jamHint.className = "hint";
jamHint.textContent =
  "Press a pad, or its key, to play it over the loop. Everyone here hears it.";
jamGroup.append(jamHeading, padGrid, jamHint);

const peopleGroup = document.createElement("div");
const peopleHeading = document.createElement("h2");
peopleHeading.textContent = "Here now";
const peopleList = document.createElement("ul");
peopleList.className = "people-list";
peopleList.dataset.testid = "people";
const roomLine = document.createElement("p");
roomLine.className = "hint";
roomLine.dataset.testid = "room-status";
peopleGroup.append(peopleHeading, peopleList, roomLine);

const ringGroup = document.createElement("div");
const ringHeading = document.createElement("h2");
ringHeading.textContent = "Rings, inner to outer";
const ringList = document.createElement("ul");
ringList.className = "ring-list";
ringGroup.append(ringHeading, ringList);

const authorGroup = document.createElement("div");
const authorHeading = document.createElement("h2");
authorHeading.textContent = "Notes by";
const authorList = document.createElement("ul");
authorList.className = "author-list";
authorList.dataset.testid = "note-authors";
authorGroup.append(authorHeading, authorList);

const clearButton = document.createElement("button");
clearButton.type = "button";
clearButton.className = "clear";
clearButton.dataset.testid = "clear-notes";
clearButton.disabled = true;

const status = document.createElement("p");
status.className = "status";
status.dataset.ready = "false";
status.dataset.testid = "ring-status";
status.textContent = "Joining the rings…";

const error = document.createElement("p");
error.className = "error";
error.role = "alert";
error.setAttribute("aria-live", "assertive");

panel.append(
  heading,
  playButton,
  tempoField,
  volumeField,
  colorGroup,
  jamGroup,
  peopleGroup,
  ringGroup,
  authorGroup,
  clearButton,
  status,
  error,
);
app.append(stage, panel);
root.append(app);

/**
 * Returns the 2D drawing context of `canvas`.
 *
 * @throws {Error} When the browser provides none.
 */
function contextOf(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Ring Loops needs a 2D canvas.");
  return context;
}

/** Returns a labeled control with a readout of its value beside the label. */
function makeField(
  label: string,
  control: HTMLInputElement,
  value: HTMLOutputElement,
): HTMLLabelElement {
  const field = document.createElement("label");
  field.className = "field";
  const text = document.createElement("span");
  text.textContent = label;
  field.append(text, value, control);
  return field;
}

/** Shows `cause` in the alert beneath the controls. */
function showError(cause: unknown): void {
  layoutErrorMessage = undefined;
  error.textContent = cause instanceof Error ? cause.message : String(cause);
}

/**
 * Empties the alert, unless it holds the standing report of an invalid input.
 */
function clearError(): void {
  if (error.textContent === layoutErrorMessage) return;
  error.textContent = "";
}

//
// Settings in effect
//
// Each reads the stored value unless a control holds a draft the store has
// not confirmed yet.
//

/** Returns whether the guest has hydrated and holds a layout it can play. */
function ready(): boolean {
  return hydrated && !disposed && layout !== undefined;
}

/**
 * Returns the tempo to play: the slider's while it is being moved, else the
 * shared one.
 */
function effectiveTempo(): number {
  return tempoDraft ??
    normalizeTempo(state.get()?.tempoBpm ?? DEFAULT_STATE.tempoBpm);
}

/**
 * Returns this user's volume from 0 to 1, or 0 where the stored one is not a
 * number.
 */
function effectiveVolume(): number {
  const stored = output.get()?.volume ?? DEFAULT_OUTPUT.volume;
  const volume = volumeDraft ?? stored;
  return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0;
}

/** Returns the color this user's notes are placed in. */
function effectiveColor(): string {
  return output.get()?.color ?? defaultColor(authorId);
}

/** Returns the viewer's profile name, or the empty string for none. */
function viewerName(): string {
  return (input.get()?.viewerName ?? "").trim();
}

/** Returns the identifiers of the rings this user has silenced. */
function mutedRingIds(): Set<string> {
  return new Set(mutedDraft ?? output.get()?.mutedRingIds ?? []);
}

/** Returns the stored notes with the writes still on their way applied. */
function currentNotes(): Record<string, PlacedNote | null> {
  return { ...state.get()?.notes, ...Object.fromEntries(pendingEdits) };
}

//
// Audio
//

/** Builds the graph the voices play into, at the volume and tempo in effect. */
function createAudioEngine(): AudioEngine {
  const context = new AudioContext();
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.connect(context.destination);

  const master = context.createGain();
  master.gain.value = effectiveVolume();
  master.connect(limiter);

  const echo = context.createDelay(2);
  echo.delayTime.value = ECHO_STEPS * secondsPerStep(effectiveTempo());
  const feedback = context.createGain();
  feedback.gain.value = 0.35;
  const echoLevel = context.createGain();
  echoLevel.gain.value = 0.3;
  echo.connect(feedback);
  feedback.connect(echo);
  echo.connect(echoLevel);
  echoLevel.connect(master);

  const noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
  const samples = noise.getChannelData(0);
  for (let index = 0; index < samples.length; index++) {
    samples[index] = Math.random() * 2 - 1;
  }
  return { context, master, echo, noise };
}

/**
 * Returns a gain that reaches `peak` at `time`, after `attack` seconds where
 * one is given, and decays to silence over the `seconds` that follow.
 */
function envelope(
  engine: AudioEngine,
  time: number,
  peak: number,
  seconds: number,
  attack = 0,
): GainNode {
  const gain = engine.context.createGain();
  if (attack > 0) {
    gain.gain.setValueAtTime(SILENCE, time);
    gain.gain.linearRampToValueAtTime(peak, time + attack);
  } else {
    gain.gain.setValueAtTime(peak, time);
  }
  gain.gain.exponentialRampToValueAtTime(SILENCE, time + attack + seconds);
  return gain;
}

/**
 * Returns an oscillator that sounds from `time` for `seconds`, gliding from
 * `startHertz` to `endHertz` where the two differ.
 */
function tone(
  engine: AudioEngine,
  type: OscillatorType,
  time: number,
  seconds: number,
  startHertz: number,
  endHertz = startHertz,
): OscillatorNode {
  const oscillator = engine.context.createOscillator();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(startHertz, time);
  if (endHertz !== startHertz) {
    oscillator.frequency.exponentialRampToValueAtTime(endHertz, time + seconds);
  }
  oscillator.start(time);
  oscillator.stop(time + seconds);
  return oscillator;
}

/** Returns a source of white noise that sounds from `time` for `seconds`. */
function noiseBurst(
  engine: AudioEngine,
  time: number,
  seconds: number,
): AudioBufferSourceNode {
  const source = engine.context.createBufferSource();
  source.buffer = engine.noise;
  source.start(time);
  source.stop(time + seconds);
  return source;
}

/**
 * Returns a filter whose cutoff glides from `startHertz` at `time` to
 * `endHertz` over `seconds`, or holds at `startHertz` where the two agree.
 */
function filter(
  engine: AudioEngine,
  type: BiquadFilterType,
  time: number,
  seconds: number,
  startHertz: number,
  endHertz = startHertz,
): BiquadFilterNode {
  const node = engine.context.createBiquadFilter();
  node.type = type;
  node.frequency.setValueAtTime(startHertz, time);
  if (endHertz !== startHertz) {
    node.frequency.exponentialRampToValueAtTime(endHertz, time + seconds);
  }
  return node;
}

/**
 * Plays `source` through `chain` into the master volume, and into the echo as
 * well when `echo` is set. The nodes are disconnected when the source ends.
 */
function route(
  engine: AudioEngine,
  source: AudioScheduledSourceNode,
  chain: readonly AudioNode[],
  echo = false,
): void {
  let tail: AudioNode = source;
  for (const node of chain) {
    tail.connect(node);
    tail = node;
  }
  tail.connect(engine.master);
  if (echo) tail.connect(engine.echo);
  source.addEventListener("ended", () => {
    source.disconnect();
    for (const node of chain) node.disconnect();
  }, { once: true });
}

/** Plays one sound of the drum kit at audio time `time`. */
function playDrum(engine: AudioEngine, sound: DrumSound, time: number): void {
  switch (sound) {
    case "kick":
      route(engine, tone(engine, "sine", time, 0.32, 150, 42), [
        envelope(engine, time, 0.9, 0.32),
      ]);
      break;
    case "snare":
      route(engine, noiseBurst(engine, time, 0.18), [
        filter(engine, "bandpass", time, 0.18, 1800),
        envelope(engine, time, 0.55, 0.18),
      ]);
      route(engine, tone(engine, "triangle", time, 0.1, 190, 120), [
        envelope(engine, time, 0.4, 0.1),
      ]);
      break;
    case "hat":
      route(engine, noiseBurst(engine, time, 0.06), [
        filter(engine, "highpass", time, 0.06, 7000),
        envelope(engine, time, 0.28, 0.06),
      ]);
      break;
    case "clap":
      // Three bursts a few milliseconds apart read as several hands.
      for (
        const [offset, seconds] of [[0, 0.02], [0.012, 0.02], [0.024, 0.16]]
      ) {
        route(engine, noiseBurst(engine, time + offset, seconds), [
          filter(engine, "bandpass", time + offset, seconds, 1200),
          envelope(engine, time + offset, 0.4, seconds),
        ]);
      }
      break;
    case "tom":
      route(engine, tone(engine, "sine", time, 0.26, 220, 105), [
        envelope(engine, time, 0.7, 0.26),
      ]);
      break;
  }
}

/** Plays `lane` of `ring` at audio time `time`, on the ring's voice. */
function playNote(
  engine: AudioEngine,
  rings: RingLayout,
  ring: Ring,
  lane: number,
  time: number,
): void {
  if (ring.voice === "drums") {
    playDrum(engine, drumSound(lane), time);
    return;
  }
  const hertz = midiToFrequency(laneMidi(rings, ring, lane));
  switch (ring.voice) {
    case "bass":
      route(engine, tone(engine, "sawtooth", time, 0.5, hertz), [
        filter(engine, "lowpass", time, 0.3, 900, 180),
        envelope(engine, time, 0.5, 0.5, 0.004),
      ]);
      break;
    case "pluck":
      route(engine, tone(engine, "square", time, 0.42, hertz), [
        filter(engine, "lowpass", time, 0.3, 3200, 500),
        envelope(engine, time, 0.2, 0.42, 0.003),
      ], true);
      break;
    case "bell": {
      // A modulator at a ratio that is not a whole number gives the carrier
      // the inharmonic partials of struck metal.
      const carrier = tone(engine, "sine", time, 1.6, hertz);
      const modulator = tone(engine, "sine", time, 1.6, hertz * 3.5);
      const depth = envelope(engine, time, hertz * 2, 0.5);
      modulator.connect(depth);
      depth.connect(carrier.frequency);
      modulator.addEventListener("ended", () => {
        modulator.disconnect();
        depth.disconnect();
      }, { once: true });
      route(engine, carrier, [envelope(engine, time, 0.22, 1.6, 0.004)], true);
      break;
    }
  }
}

/**
 * Sounds the note of `cell` now, where audio is running and its ring is not
 * muted.
 */
function audition(cell: Cell): void {
  if (!audio || !layout || audio.context.state !== "running") return;
  const ring = layout.rings[cell.ringIndex];
  if (mutedRingIds().has(ring.id)) return;
  playNote(audio, layout, ring, cell.lane, audio.context.currentTime);
}

/**
 * Brings the audio graph and the running clock to the volume and tempo in
 * effect.
 */
function applySettings(): void {
  if (!audio) return;
  const now = audio.context.currentTime;
  const tempo = effectiveTempo();
  audio.master.gain.setTargetAtTime(effectiveVolume(), now, 0.02);
  audio.echo.delayTime.setTargetAtTime(
    ECHO_STEPS * secondsPerStep(tempo),
    now,
    0.05,
  );
  if (transport && following === undefined && transport.tempoBpm !== tempo) {
    transport = retimed(transport, now, tempo);
    publishHand();
  }
}

//
// Step clock
//

/**
 * Starts the step clock at step 0, building the audio graph on the first call.
 *
 * @throws {Error} When the browser leaves the audio context suspended.
 */
async function startPlayback(): Promise<void> {
  if (!ready() || transport) return;
  audio ??= createAudioEngine();
  await audio.context.resume();
  if (disposed || transport) return;
  if (audio.context.state !== "running") {
    throw new Error("The browser has not started audio. Press Play again.");
  }
  applySettings();
  transport = {
    anchorStep: 0,
    anchorTime: audio.context.currentTime + START_DELAY_SECONDS,
    tempoBpm: effectiveTempo(),
  };
  scheduledThrough = 0;
  publishHand();
  renderControls();
  requestFrame();
}

/** Stops the step clock and returns every hand to the top. */
function stopPlayback(): void {
  transport = undefined;
  flashes.clear();
  publishHand();
  renderControls();
  requestFrame();
}

/**
 * Queues every note due between the steps already queued and the lookahead
 * horizon. Steps the clock passed while no frame ran, as in a hidden tab, are
 * left unplayed.
 */
function scheduleAhead(): void {
  if (!transport || !audio || !layout) return;
  const now = audio.context.currentTime;
  const from = Math.max(scheduledThrough, positionAt(transport, now));
  const through = positionAt(transport, now + LOOKAHEAD_SECONDS);
  const muted = mutedRingIds();
  for (const step of stepsBetween(from, through)) {
    const time = timeOfStep(transport, step);
    for (const { ringIndex, note } of notesAtStep(layout, live, step)) {
      const ring = layout.rings[ringIndex];
      if (muted.has(ring.id)) continue;
      playNote(audio, layout, ring, note.lane, time);
      flashes.set(cellKey(note.ringId, note.step, note.lane), time);
    }
  }
  scheduledThrough = Math.max(scheduledThrough, through);
}

/** Runs one frame: queues the notes coming due, then draws. */
function frame(): void {
  animationFrame = undefined;
  if (disposed) return;
  try {
    scheduleAhead();
    draw();
    if (
      transport &&
      Date.now() - handAnnouncedAt > HAND_REANNOUNCE_SECONDS * 1000
    ) {
      publishHand();
    }
  } catch (cause) {
    transport = undefined;
    publishHand();
    showError(cause);
    renderControls();
    return;
  }
  if (transport || [...peers.values()].some((peer) => peer.hand)) {
    animationFrame = requestAnimationFrame(frame);
  }
}

/** Asks for a frame, unless one is already on its way. */
function requestFrame(): void {
  if (animationFrame === undefined && !disposed) {
    animationFrame = requestAnimationFrame(frame);
  }
}

//
// Canvas
//

/** Returns the outermost ring's radius on a canvas `size` pixels wide. */
function ringRadius(size: number): number {
  return size / 2 * RING_EXTENT;
}

/** Fits the square canvas into the stage, at the display's pixel density. */
function resizeCanvas(): void {
  const style = getComputedStyle(stage);
  const width = stage.clientWidth - parseFloat(style.paddingLeft) -
    parseFloat(style.paddingRight);
  const height = stage.clientHeight - parseFloat(style.paddingTop) -
    parseFloat(style.paddingBottom);
  const size = Math.max(0, Math.floor(Math.min(width, height)));
  const density = globalThis.devicePixelRatio || 1;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  canvas.width = Math.round(size * density);
  canvas.height = Math.round(size * density);
}

/**
 * Returns where a pointer event on the canvas is, measured from the center in
 * ring radii, so that the same point means the same place on every screen.
 */
function ringPointOf(event: MouseEvent): RingPoint | undefined {
  const size = canvas.clientWidth;
  const radius = ringRadius(size);
  if (radius <= 0) return undefined;
  return {
    x: (event.offsetX - size / 2) / radius,
    y: (event.offsetY - size / 2) / radius,
  };
}

/** Returns the cell under a pointer event on the canvas, if it is over one. */
function cellUnder(event: MouseEvent): Cell | undefined {
  const point = ringPointOf(event);
  return layout && point ? cellAt(layout, point.x, point.y) : undefined;
}

/** Returns the canvas angle of a fraction of a turn clockwise from the top. */
function angleOf(turn: number): number {
  return turn * TAU - Math.PI / 2;
}

/**
 * Traces the sector `shape` as the current path, pulled in by `inset` pixels
 * on every side so that neighboring cells do not touch.
 */
function traceSector(shape: CellShape, radius: number, inset: number): void {
  const outer = shape.outer * radius - inset;
  const inner = shape.inner * radius + inset;
  const start = angleOf(shape.startTurn);
  const end = angleOf(shape.endTurn);
  drawing.beginPath();
  drawing.arc(0, 0, outer, start + inset / outer, end - inset / outer);
  drawing.arc(0, 0, inner, end - inset / inner, start + inset / inner, true);
  drawing.closePath();
}

/** Strokes a radial line across the radii `inner` to `outer`, at `turn`. */
function strokeRadial(inner: number, outer: number, turn: number): void {
  const angle = angleOf(turn);
  drawing.beginPath();
  drawing.moveTo(inner * Math.cos(angle), inner * Math.sin(angle));
  drawing.lineTo(outer * Math.cos(angle), outer * Math.sin(angle));
  drawing.stroke();
}

/**
 * Returns how brightly a cell is lit at `now` by its last sounding, from 0 to
 * 1.
 */
function flashAt(key: string, now: number): number {
  const time = flashes.get(key);
  if (time === undefined || now < time) return 0;
  const age = now - time;
  if (age >= FLASH_SECONDS) {
    flashes.delete(key);
    return 0;
  }
  return 1 - age / FLASH_SECONDS;
}

/**
 * Draws the rings with their lanes and steps, the notes, the hovered cell, the
 * hand of each ring, and the tempo in the hub.
 */
function draw(): void {
  const context = drawing;
  const size = canvas.clientWidth;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!layout || !hydrated || size <= 0) return;

  const density = canvas.width / size;
  const radius = ringRadius(size);
  context.setTransform(density, 0, 0, density, 0, 0);
  context.translate(size / 2, size / 2);

  const bands = ringBands(layout.rings.length);
  const muted = mutedRingIds();
  const now = audio?.context.currentTime ?? 0;
  const position = transport ? Math.max(0, positionAt(transport, now)) : 0;
  const highlighted = hoverRowIndex ?? hoverCell?.ringIndex;

  for (const [ringIndex, ring] of layout.rings.entries()) {
    const band = bands[ringIndex];
    const inner = band.inner * radius;
    const outer = band.outer * radius;
    context.globalAlpha = muted.has(ring.id) ? 0.4 : 1;

    context.beginPath();
    context.arc(0, 0, outer, 0, TAU);
    context.arc(0, 0, inner, 0, TAU, true);
    context.fillStyle = ringIndex === highlighted ? "#ffffff1c" : "#ffffff0d";
    context.fill();

    context.lineWidth = 1;
    context.strokeStyle = "#ffffff12";
    for (let lane = 1; lane < layout.lanes; lane++) {
      context.beginPath();
      context.arc(0, 0, inner + (outer - inner) * lane / layout.lanes, 0, TAU);
      context.stroke();
    }
    for (let step = 0; step < ring.steps; step++) {
      context.strokeStyle = step === 0
        ? "#ffffff80"
        : step % STEPS_PER_BEAT === 0
        ? "#ffffff38"
        : "#ffffff14";
      strokeRadial(inner, outer, step / ring.steps);
    }
  }

  for (const { ringIndex, note } of live) {
    const key = cellKey(note.ringId, note.step, note.lane);
    const flash = flashAt(key, now);
    const dimmed = muted.has(layout.rings[ringIndex].id);
    traceSector(cellShape(layout, { ringIndex, ...note }), radius, 1.5);
    context.globalAlpha = dimmed ? 0.3 : pendingEdits.has(key) ? 0.6 : 0.92;
    context.shadowColor = note.color;
    context.shadowBlur = 20 * flash;
    context.fillStyle = note.color;
    context.fill();
    context.shadowBlur = 0;
    if (flash > 0) {
      context.globalAlpha = 0.7 * flash;
      context.fillStyle = "#ffffff";
      context.fill();
    }
  }
  context.globalAlpha = 1;

  if (hoverCell) {
    traceSector(cellShape(layout, hoverCell), radius, 1.5);
    context.globalAlpha = 0.3;
    context.fillStyle = effectiveColor();
    context.fill();
    context.globalAlpha = 1;
    context.lineWidth = 1.5;
    context.strokeStyle = "#ffffff";
    context.stroke();
  }

  context.lineCap = "round";
  context.lineWidth = 2.5;
  context.strokeStyle = transport ? "#ffffff" : "#ffffff66";
  for (const [ringIndex, ring] of layout.rings.entries()) {
    const band = bands[ringIndex];
    strokeRadial(
      band.inner * radius,
      band.outer * radius,
      handTurn(position, ring.steps),
    );
  }
  const nowMs = Date.now();
  context.lineWidth = 1.5;
  for (const peer of peers.values()) {
    if (!peer.hand) continue;
    const peerPosition = peerHandPosition(peer.hand, nowMs);
    context.strokeStyle = peer.color;
    for (const [ringIndex, ring] of layout.rings.entries()) {
      const band = bands[ringIndex];
      strokeRadial(
        band.inner * radius,
        band.outer * radius,
        handTurn(peerPosition, ring.steps),
      );
    }
  }
  context.lineCap = "butt";

  const hub = bands[0].inner * radius;
  context.fillStyle = "#eef0f8";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `650 ${hub * 0.62}px Inter, ui-sans-serif, system-ui`;
  context.fillText(String(Math.round(effectiveTempo())), 0, -hub * 0.1);
  context.fillStyle = "#a3abc7";
  context.font = `600 ${hub * 0.24}px Inter, ui-sans-serif, system-ui`;
  context.fillText("BPM", 0, hub * 0.42);

  drawPointers(radius);
}

/** Draws each peer's pointer as a dot with a label naming them. */
function drawPointers(radius: number): void {
  const context = drawing;
  context.font = "600 12px Inter, ui-sans-serif, system-ui";
  context.textAlign = "left";
  context.textBaseline = "middle";
  for (const peer of peers.values()) {
    if (!peer.pointer) continue;
    const x = peer.pointer.x * radius;
    const y = peer.pointer.y * radius;
    context.beginPath();
    context.arc(x, y, 5, 0, TAU);
    context.fillStyle = peer.color;
    context.fill();
    context.lineWidth = 2;
    context.strokeStyle = "#0b0d17";
    context.stroke();
    const width = context.measureText(peer.name).width + 12;
    context.beginPath();
    context.roundRect(x + 9, y - 10, width, 20, 10);
    context.fill();
    context.fillStyle = "#0b0d17";
    context.fillText(peer.name, x + 15, y);
  }
}

//
// Controls
//

/** Rebuilds the list of rings, one row with a mute control for each. */
function rebuildRingRows(): void {
  ringList.replaceChildren();
  if (!layout) return;
  for (const [index, ring] of layout.rings.entries()) {
    const row = document.createElement("li");
    row.className = "ring-row";
    const text = document.createElement("div");
    const name = document.createElement("span");
    name.className = "ring-name";
    name.textContent = ring.label;
    const detail = document.createElement("span");
    detail.className = "ring-detail";
    const beats = ring.steps / STEPS_PER_BEAT;
    detail.textContent = `${beats} ${beats === 1 ? "beat" : "beats"} · ${
      ring.voice === "drums" ? "drum kit" : ring.voice
    }`;
    text.append(name, detail);

    const mute = document.createElement("button");
    mute.type = "button";
    mute.dataset.testid = `mute-${index}`;
    mute.addEventListener("click", () => {
      const muted = mutedRingIds();
      if (!muted.delete(ring.id)) muted.add(ring.id);
      const next = [...muted];
      mutedDraft = next;
      clearError();
      refresh();
      // Writes to one cell go out in order, so the last click's list lands
      // last; the draft stands until the store has it.
      void output.key("mutedRingIds").set(next).then(() => output.pull())
        .catch(showError).finally(() => {
          if (mutedDraft === next) mutedDraft = undefined;
          refresh();
        });
    }, { signal });

    row.addEventListener("pointerenter", () => {
      hoverRowIndex = index;
      requestFrame();
    }, { signal });
    row.addEventListener("pointerleave", () => {
      if (hoverRowIndex === index) hoverRowIndex = undefined;
      requestFrame();
    }, { signal });
    row.append(text, mute);
    ringList.append(row);
  }
}

/**
 * Rebuilds the jam pads: a row for each ring, with a pad for each lane that
 * shows what the lane plays and the key that plays it.
 */
function rebuildPads(): void {
  padButtons.clear();
  padGrid.replaceChildren();
  if (!layout) return;
  padGrid.style.setProperty("--lanes", String(layout.lanes));
  for (const [ringIndex, ring] of layout.rings.entries()) {
    const label = document.createElement("span");
    label.className = "pad-label";
    label.textContent = ring.label;
    padGrid.append(label);
    for (let lane = 0; lane < layout.lanes; lane++) {
      const pad = document.createElement("button");
      pad.type = "button";
      pad.className = "pad";
      pad.dataset.testid = `pad-${ringIndex}-${lane}`;
      const plays = laneLabel(layout, ring, lane);
      const key = keyForPad(ringIndex, lane);
      pad.textContent = plays;
      if (key) {
        const hint = document.createElement("kbd");
        hint.textContent = key.toUpperCase();
        pad.append(hint);
      }
      pad.setAttribute("aria-label", `Play ${ring.label} ${plays}`);
      // A pad plays on press rather than on click, so the note is not late
      // by however long the button is held.
      pad.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        pressPad(ringIndex, lane);
      }, { signal });
      pad.addEventListener("keydown", (event) => {
        if (event.repeat || (event.key !== "Enter" && event.key !== " ")) {
          return;
        }
        event.preventDefault();
        pressPad(ringIndex, lane);
      }, { signal });
      padButtons.set(`${ringIndex}:${lane}`, pad);
      padGrid.append(pad);
    }
  }
}

/**
 * Lists this viewer and everyone else in the room, with a button to follow
 * each other person's playback, and says how the room stands.
 */
function renderPeople(): void {
  const others = [...peers.values()];
  const self = {
    name: `${viewerName() || "Guest"} (you)`,
    color: hydrated ? effectiveColor() : "#8b93a7",
    playing: transport !== undefined,
    jammed: lastJammed.get(SELF),
  };
  const shown = JSON.stringify([
    self,
    others.map((peer) => [
      peer.id,
      peer.name,
      peer.color,
      peer.hand !== undefined,
      lastJammed.get(peer.id),
    ]),
    following,
    roomStatus,
    ready(),
  ]);
  if (shown === shownPeople) return;
  shownPeople = shown;

  const row = (
    person: { name: string; color: string; playing: boolean },
    jammed: string | undefined,
    follow: HTMLButtonElement | undefined,
  ) => {
    const item = document.createElement("li");
    item.className = "person";
    const dot = document.createElement("span");
    dot.className = "author-dot";
    dot.style.background = person.color;
    const label = document.createElement("span");
    label.className = "author-name";
    label.textContent = person.name;
    const activity = document.createElement("span");
    activity.className = "author-count";
    activity.textContent = [
      person.playing ? "playing" : "",
      jammed ? `jammed ${jammed}` : "",
    ].filter(Boolean).join(" · ");
    item.append(dot, label, activity);
    if (follow) item.append(follow);
    return item;
  };
  const followButton = (peer: Peer) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "follow";
    button.dataset.testid = "follow";
    const isFollowed = following === peer.id;
    button.textContent = isFollowed ? "Following" : "Follow";
    button.setAttribute("aria-pressed", String(isFollowed));
    button.setAttribute(
      "aria-label",
      isFollowed
        ? `Stop following ${peer.name}`
        : `Play in step with ${peer.name}`,
    );
    button.disabled = !ready();
    button.addEventListener("click", () => {
      clearError();
      if (following === peer.id) {
        unfollow();
      } else {
        void follow(peer.id).catch(showError);
      }
    }, { signal });
    return button;
  };
  peopleList.replaceChildren(
    row(self, self.jammed, undefined),
    ...others.map((peer) =>
      row(
        {
          name: peer.name,
          color: peer.color,
          playing: peer.hand !== undefined,
        },
        lastJammed.get(peer.id),
        followButton(peer),
      )
    ),
  );
  roomLine.textContent = roomStatus === "live"
    ? others.length === 0
      ? "Nobody else is here right now."
      : following !== undefined && peers.has(following)
      ? `Playing in step with ${peers.get(following)?.name}.`
      : `${others.length} ${others.length === 1 ? "other" : "others"} here.`
    : roomStatus === "joining"
    ? "Joining the room…"
    : roomStatus === "unsupported"
    ? "This server has no live room, so nobody sees your pointer or hears your pads."
    : "Lost the room. Press Play, a pad, or the rings to rejoin.";
}

/** Brings every control in the panel up to date with the settings in effect. */
function renderControls(): void {
  const isReady = ready();
  title.textContent = input.get()?.setup.title ?? DEFAULT_INPUT.setup.title;
  canvas.dataset.ready = String(isReady);

  playButton.disabled = !isReady;
  playButton.textContent = transport ? "Stop" : "Play";
  playButton.setAttribute("aria-pressed", String(transport !== undefined));

  const tempo = effectiveTempo();
  tempoSlider.disabled = !isReady;
  if (tempoDraft === undefined) tempoSlider.value = String(tempo);
  tempoReadout.textContent = `${Math.round(tempo)} BPM`;

  const volume = effectiveVolume();
  volumeSlider.disabled = !isReady;
  if (volumeDraft === undefined) volumeSlider.value = String(volume);
  volumeReadout.textContent = `${Math.round(volume * 100)}%`;

  const color = isReady ? effectiveColor() : undefined;
  for (const swatch of swatchButtons) {
    swatch.disabled = !isReady;
    swatch.setAttribute("aria-pressed", String(swatch.dataset.color === color));
  }

  const muted = mutedRingIds();
  for (const [index, row] of [...ringList.children].entries()) {
    const ring = layout?.rings[index];
    const mute = row.querySelector("button");
    if (!ring || !(row instanceof HTMLElement) || !mute) continue;
    const isMuted = muted.has(ring.id);
    row.dataset.muted = String(isMuted);
    row.dataset.hover = String(hoverCell?.ringIndex === index);
    mute.disabled = !isReady;
    mute.textContent = isMuted ? "Muted" : "Mute";
    mute.setAttribute("aria-pressed", String(isMuted));
    mute.setAttribute(
      "aria-label",
      `${isMuted ? "Unmute" : "Mute"} ${ring.label} for yourself`,
    );
  }

  clearButton.disabled = !isReady;
  clearButton.dataset.armed = String(clearArmed);
  clearButton.textContent = clearArmed
    ? "Click again to clear everyone's notes"
    : "Clear all notes";

  const name = viewerName();
  viewerLine.textContent = !isReady
    ? ""
    : name
    ? `Notes you place carry the name ${name}.`
    : "No profile name is known, so notes you place carry none.";
  renderAuthors();
  renderPeople();
  const audioRunning = audio?.context.state === "running";
  if (audioRunning) missedPeerPress = false;
  jamHint.textContent = missedPeerPress
    ? "Someone is playing the pads. Press Play or a pad to hear them."
    : "Press a pad, or its key, to play it over the loop. Everyone here hears it.";
  for (const pad of padButtons.values()) pad.disabled = !isReady;

  if (isReady) {
    status.textContent = `${live.length} ${
      live.length === 1 ? "note" : "notes"
    } on the rings`;
  }
  status.dataset.ready = String(isReady);
}

/** Lists everyone with notes on the rings, each with a color and a count. */
function renderAuthors(): void {
  const tallies = authorTallies(live);
  authorGroup.hidden = tallies.length === 0;
  authorList.replaceChildren(...tallies.map((tally) => {
    const row = document.createElement("li");
    row.className = "author-row";
    const dot = document.createElement("span");
    dot.className = "author-dot";
    dot.style.background = tally.color;
    const name = document.createElement("span");
    name.className = "author-name";
    name.textContent = tally.name;
    const count = document.createElement("span");
    count.className = "author-count";
    count.textContent = String(tally.count);
    row.append(dot, name, count);
    return row;
  }));
}

/**
 * Describes the selected cell beneath the canvas, or shows the hint. The step
 * and the lane are the numbers a caller of the pattern's verbs names the cell
 * by, and a placed note names whoever placed it.
 */
function renderReadout(): void {
  const text = readoutText();
  // The readout is a live region, so rewriting the text it already shows would
  // have a screen reader announce it again on every edit to the shared notes.
  if (readout.textContent !== text) readout.textContent = text;
}

/** Helper for `renderReadout()`, which returns the text to show. */
function readoutText(): string {
  if (!layout || !hoverCell) return HINT;
  const { ringIndex, step, lane } = hoverCell;
  const ring = layout.rings[ringIndex];
  const placed = live.find(({ note }) =>
    note.ringId === ring.id && note.step === step && note.lane === lane
  );
  return `${ring.label} · step ${step} · lane ${lane} · ${
    laneLabel(layout, ring, lane)
  }${placed ? ` · placed by ${authorNameOf(placed.note)}` : ""}`;
}

/**
 * Records the selected cell, under the pointer or picked with the arrow keys,
 * and redraws where it changed.
 */
function setHover(cell: Cell | undefined): void {
  if (
    cell?.ringIndex === hoverCell?.ringIndex &&
    cell?.step === hoverCell?.step &&
    cell?.lane === hoverCell?.lane
  ) {
    return;
  }
  hoverCell = cell;
  renderReadout();
  for (const [index, row] of [...ringList.children].entries()) {
    if (row instanceof HTMLElement) {
      row.dataset.hover = String(hoverCell?.ringIndex === index);
    }
  }
  requestFrame();
}

//
// Updates from the cells
//

/**
 * Brings the notes, the audio settings, the controls, the readout, and the
 * canvas up to date.
 */
function refresh(): void {
  live = ready() && layout ? liveNotes(layout, currentNotes()) : [];
  publishLook();
  applySettings();
  renderControls();
  renderReadout();
  requestFrame();
}

/**
 * Derives the layout from the input, and stops playback where it is invalid.
 */
function adoptInput(): void {
  const value = input.get();
  if (hydrated && value) {
    try {
      layout = ringLayoutOf(value.setup);
      if (error.textContent === layoutErrorMessage) error.textContent = "";
      layoutErrorMessage = undefined;
    } catch (cause) {
      layout = undefined;
      transport = undefined;
      publishHand();
      showError(cause);
      layoutErrorMessage = error.textContent ?? undefined;
      status.textContent = "These rings cannot be drawn";
    }
    hoverCell = undefined;
    hoverRowIndex = undefined;
    rebuildRingRows();
    rebuildPads();
    renderReadout();
  }
  refresh();
}

//
// Presence
//

/**
 * Publishes to the room. A rejection needs no handling of its own: a room that
 * cannot take a publication reports its failure to the listener.
 */
function publish(publication: Promise<void>): void {
  publication.catch(() => {});
}

/** Tells the room the viewer's name and color, where either has changed. */
function publishLook(): void {
  if (!leaveRoom || !hydrated) return;
  const name = presenceName(viewerName());
  const color = effectiveColor();
  if (name !== publishedName) {
    publishedName = name;
    publish(room.setName(name));
  }
  if (color !== publishedColor) {
    publishedColor = color;
    publish(room.setFacet(LOOK_FACET, { color }));
  }
}

/**
 * Tells the room where this browser's playback is: the step it holds at this
 * wall-clock moment and its tempo, from which peers extrapolate. A stopped
 * clock clears the facet.
 */
function publishHand(): void {
  if (!leaveRoom) return;
  if (!transport || !audio) {
    publish(room.clearFacet(HAND_FACET));
    return;
  }
  handAnnouncedAt = Date.now();
  publish(room.setFacet(HAND_FACET, {
    step: positionAt(transport, audio.context.currentTime),
    at: handAnnouncedAt,
    bpm: transport.tempoBpm,
  }));
}

/** Tells the room where the pointer is over the rings. */
function publishPointer(event: PointerEvent): void {
  const point = ringPointOf(event);
  if (!leaveRoom || !point) return;
  publish(room.setFacet(POINTER_FACET, {
    x: Math.round(point.x * 1000) / 1000,
    y: Math.round(point.y * 1000) / 1000,
  }));
}

/**
 * Joins the room unless already in it, and tells it everything this guest
 * publishes. A new membership starts with no presses of its own.
 */
function joinRoom(): void {
  if (leaveRoom || roomStatus === "unsupported" || disposed) return;
  roomStatus = "joining";
  publishedName = undefined;
  publishedColor = undefined;
  ownPresses = [];
  leaveRoom = room.join(onRoomEvent);
  publishLook();
  publishHand();
  renderPeople();
}

/** Joins the room again after the host lost it, as the user acts. */
function rejoinIfLost(): void {
  if (roomStatus === "lost") joinRoom();
}

/**
 * Brings the peers up to date with one delivery from the room: the whole room
 * on joining and rejoining, one member's new record, or one member leaving.
 * Plays the pad presses that are new, and keeps a followed peer in step.
 */
function onRoomEvent(event: PresenceRoomEvent): void {
  switch (event.kind) {
    case "snapshot":
      roomStatus = "live";
      peers.clear();
      pressesHeard.clear();
      for (const participant of event.participants) {
        meetPeer(readPeer(participant));
      }
      syncToFollowed();
      break;
    case "upsert": {
      const peer = readPeer(event.participant);
      const before = peers.get(peer.id)?.hand;
      if (peers.has(peer.id)) hearPeer(peer);
      else meetPeer(peer);
      if (peer.id === following && !sameHand(before, peer.hand)) {
        syncToFollowed();
      }
      break;
    }
    case "remove":
      if (event.participantId === following) {
        following = undefined;
        applySettings();
      }
      peers.delete(event.participantId);
      pressesHeard.delete(event.participantId);
      lastJammed.delete(event.participantId);
      break;
    case "failure":
      following = undefined;
      applySettings();
      leaveRoom = undefined;
      peers.clear();
      pressesHeard.clear();
      roomStatus = event.error.code === "presence-unsupported"
        ? "unsupported"
        : "lost";
      break;
  }
  renderPeople();
  requestFrame();
}

/** Records a peer met for the first time, without playing its past presses. */
function meetPeer(peer: Peer): void {
  peers.set(peer.id, peer);
  pressesHeard.set(peer.id, lastPressId(peer.presses) ?? -1);
}

/** Records a peer's new record, and plays the presses that are new in it. */
function hearPeer(peer: Peer): void {
  // A peer reaches here only once met, and meeting seeds the press number.
  const heard = pressesHeard.get(peer.id) ?? -1;
  for (const press of freshPresses(peer.presses, heard)) {
    const played = playPress(press, peer.color, false);
    if (played) lastJammed.set(peer.id, played);
  }
  pressesHeard.set(peer.id, lastPressId(peer.presses) ?? heard);
  peers.set(peer.id, peer);
}

/** Returns whether two hand facets say the same thing. */
function sameHand(a: PeerHand | undefined, b: PeerHand | undefined): boolean {
  return a?.step === b?.step && a?.at === b?.at && a?.bpm === b?.bpm;
}

/**
 * Follows a peer's playback: starts the audio, as the click that calls this is
 * the gesture a browser needs, and plays in step with the peer from then on,
 * stopping and starting as they do.
 *
 * @throws {Error} When the browser leaves the audio context suspended.
 */
async function follow(peerId: string): Promise<void> {
  if (!ready()) return;
  audio ??= createAudioEngine();
  await audio.context.resume();
  if (disposed) return;
  if (audio.context.state !== "running") {
    throw new Error("The browser has not started audio. Try again.");
  }
  following = peerId;
  syncToFollowed();
}

/** Stops following, and leaves this browser's playback running on its own. */
function unfollow(): void {
  following = undefined;
  applySettings();
  renderControls();
}

/**
 * Brings this browser's clock in step with the followed peer's hand, or stops
 * it while the peer is stopped, and stops following a peer who has left. A
 * jitter-sized shift keeps the notes already queued and is not announced; see
 * `followStep()`.
 */
function syncToFollowed(): void {
  if (following === undefined || !audio || disposed) return;
  const peer = peers.get(following);
  if (!peer) {
    following = undefined;
    applySettings();
  } else if (!peer.hand) {
    if (transport) {
      transport = undefined;
      flashes.clear();
      publishHand();
    }
  } else {
    const next = followStep(
      transport,
      peer.hand,
      Date.now(),
      audio.context.currentTime,
      START_DELAY_SECONDS,
      LOOKAHEAD_SECONDS,
    );
    if (next.restartQueueAt !== undefined) {
      scheduledThrough = next.restartQueueAt;
    }
    transport = next.clock;
    if (next.announce) publishHand();
  }
  renderControls();
  requestFrame();
}

/** Plays a jam pad here, and tells the room so that everyone else hears it. */
function pressPad(ringIndex: number, lane: number): void {
  if (!ready() || !layout) return;
  rejoinIfLost();
  const press = { id: nextPressId++, ring: layout.rings[ringIndex].id, lane };
  const played = playPress(press, effectiveColor(), true);
  if (played) lastJammed.set(SELF, played);
  renderPeople();
  ownPresses = withPress(ownPresses, press);
  if (!leaveRoom) return;
  // Copied into literals, which a facet takes where an interface is not one.
  const list = ownPresses.map(({ id, ring, lane }) => ({ id, ring, lane }));
  publish(room.setFacet(PRESSES_FACET, { list }));
}

/**
 * Lights the pad `press` names in `color` and sounds it, unless its ring is
 * muted, and returns what the pad plays, such as `snare` or `C5`. Returns
 * `undefined` for a press naming no pad of these rings. Only this viewer's own
 * press may start the audio, since a browser starts audio only for a gesture;
 * a peer's press is heard once it has.
 */
function playPress(
  press: PadPress,
  color: string,
  ownGesture: boolean,
): string | undefined {
  if (!layout) return undefined;
  const ringIndex = layout.rings.findIndex((ring) => ring.id === press.ring);
  if (ringIndex < 0 || press.lane < 0 || press.lane >= layout.lanes) {
    return undefined;
  }
  padButtons.get(`${ringIndex}:${press.lane}`)?.animate(
    [{ backgroundColor: color, boxShadow: `0 0 14px ${color}` }, {}],
    { duration: 280, easing: "ease-out" },
  );
  const ring = layout.rings[ringIndex];
  const plays = laneLabel(layout, ring, press.lane);
  if (mutedRingIds().has(ring.id)) return plays;
  if (ownGesture) audio ??= createAudioEngine();
  const engine = audio;
  if (!engine || (!ownGesture && engine.context.state !== "running")) {
    if (!ownGesture && !missedPeerPress) {
      missedPeerPress = true;
      renderControls();
    }
    return plays;
  }
  const sound = () => {
    if (!layout || disposed) return;
    playNote(engine, layout, ring, press.lane, engine.context.currentTime);
  };
  if (engine.context.state === "running") {
    sound();
  } else if (ownGesture) {
    void engine.context.resume().then(() => {
      sound();
      renderControls();
    }).catch(showError);
  }
  return plays;
}

//
// Shared writes
//

/**
 * Places or removes the note of `cell`. The cell shows its new content at
 * once, and takes no second toggle until the write has settled.
 */
function toggleCell(cell: Cell): void {
  if (!ready() || !layout) return;
  const edit = toggleEdit(layout, currentNotes(), cell, {
    id: authorId,
    name: noteAuthorName(undefined, viewerName()),
    color: effectiveColor(),
  });
  if (pendingEdits.has(edit.key)) return;
  clearError();
  pendingEdits.set(edit.key, edit.value);
  if (edit.value) audition(cell);
  refresh();
  // The pull brings the stored notes up to the write before the pending copy
  // is dropped, so the cell does not show its old content in between.
  void notesCell.key(edit.key).set(edit.value).then(() => state.pull())
    .catch(showError).finally(() => {
      pendingEdits.delete(edit.key);
      refresh();
    });
}

/** Returns the clear control to its first step, where it was armed. */
function disarmClear(): void {
  if (!clearArmed) return;
  clearArmed = false;
  renderControls();
}

//
// Wiring and startup
//

/**
 * Releases what the guest holds: its listeners and sinks, the frame it asked
 * for, the audio context, and the bridge.
 */
function teardown(): void {
  if (disposed) return;
  disposed = true;
  abort.abort();
  stops.forEach((stop) => stop());
  resizeObserver.disconnect();
  if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
  animationFrame = undefined;
  transport = undefined;
  void audio?.context.close().catch(() => undefined);
  leaveRoom?.();
  leaveRoom = undefined;
  fabric.disconnect();
}

const resizeObserver = new ResizeObserver(() => {
  resizeCanvas();
  requestFrame();
});
resizeObserver.observe(stage);

const stops = [
  input.sink(adoptInput),
  state.sink(refresh),
  output.sink(refresh),
];

canvas.addEventListener("pointermove", (event) => {
  setHover(cellUnder(event));
  publishPointer(event);
}, { signal });
canvas.addEventListener("pointerleave", () => {
  // The cell under the pointer stays selected while the canvas has focus, so
  // the keyboard picks up where the pointer left off.
  if (document.activeElement !== canvas) setHover(undefined);
  if (leaveRoom) publish(room.clearFacet(POINTER_FACET));
}, { signal });
canvas.addEventListener("pointerdown", rejoinIfLost, { signal });
canvas.addEventListener("click", (event) => {
  // A tap brings no pointer movement ahead of it, so the cell it toggles is
  // selected here, for the readout and for the arrow keys to move on from.
  const cell = cellUnder(event);
  if (!cell) return;
  setHover(cell);
  toggleCell(cell);
}, { signal });
canvas.addEventListener("focus", () => {
  // Only keyboard focus selects a cell; focus from a click or a tap leaves the
  // selection to the cell under the pointer.
  if (layout && !hoverCell && canvas.matches(":focus-visible")) {
    setHover(FIRST_CELL);
  }
}, { signal });
canvas.addEventListener("blur", () => setHover(undefined), { signal });
canvas.addEventListener("keydown", (event) => {
  if (!layout || event.metaKey || event.ctrlKey || event.altKey) return;
  const move = CELL_KEYS.get(event.key);
  if (move) {
    event.preventDefault();
    setHover(neighborCell(layout, hoverCell ?? FIRST_CELL, move));
    return;
  }
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  if (event.repeat) return;
  const cell = hoverCell ?? FIRST_CELL;
  setHover(cell);
  toggleCell(cell);
}, { signal });

playButton.addEventListener("click", () => {
  clearError();
  rejoinIfLost();
  following = undefined;
  if (transport) {
    stopPlayback();
  } else {
    void startPlayback().catch(showError);
  }
}, { signal });

tempoSlider.addEventListener("input", () => {
  tempoDraft = Number(tempoSlider.value);
  refresh();
}, { signal });
tempoSlider.addEventListener("change", () => {
  const tempo = Number(tempoSlider.value);
  tempoDraft = tempo;
  clearError();
  void state.key("tempoBpm").set(tempo).then(() => state.pull())
    .catch(showError).finally(() => {
      if (tempoDraft === tempo) tempoDraft = undefined;
      refresh();
    });
}, { signal });

volumeSlider.addEventListener("input", () => {
  volumeDraft = Number(volumeSlider.value);
  refresh();
}, { signal });
volumeSlider.addEventListener("change", () => {
  const volume = Number(volumeSlider.value);
  volumeDraft = volume;
  clearError();
  void output.key("volume").set(volume).then(() => output.pull())
    .catch(showError).finally(() => {
      if (volumeDraft === volume) volumeDraft = undefined;
      refresh();
    });
}, { signal });

clearButton.addEventListener("click", () => {
  if (!clearArmed) {
    clearArmed = true;
    renderControls();
    return;
  }
  clearArmed = false;
  clearError();
  void notesCell.set({}).then(() => state.pull()).catch(showError)
    .finally(refresh);
  renderControls();
}, { signal });
clearButton.addEventListener("blur", disarmClear, { signal });
clearButton.addEventListener("pointerleave", disarmClear, { signal });

globalThis.addEventListener("keydown", (event) => {
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target instanceof HTMLInputElement || !layout) return;
  const pad = padForKey(layout, event.key);
  if (!pad) return;
  event.preventDefault();
  pressPad(pad.ringIndex, pad.lane);
}, { signal });
globalThis.addEventListener("pagehide", teardown, { once: true, signal });

// Presence does not wait for the cells: the room is joined at once, and the
// name is published once the input that holds it has been pulled.
joinRoom();

void (async () => {
  try {
    await Promise.all([input.pull(), state.pull(), output.pull()]);
    await Promise.all([
      state.initialize(DEFAULT_STATE),
      output.initialize(DEFAULT_OUTPUT),
    ]);
    const resolvedOutput = await output.resolve();
    authorId = resolvedOutput.identity?.instanceId ?? "";
    if (!authorId) {
      throw new Error("The per-user settings have no resolved identity.");
    }
    if (disposed) return;
    hydrated = true;
    adoptInput();
  } catch (cause) {
    showError(cause);
    status.textContent = "Could not join the rings";
  }
})();
