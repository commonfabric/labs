import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
import {
  type ConfidenceAssessment,
  DEFAULT_INPUT,
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type TapeAnnotation,
} from "./contract.ts";
import {
  type AnnotationEdits,
  assessmentValues,
  buildSyntheticWav,
  changedAnnotationEdits,
  confidenceFor,
  cueSpecs,
  durationRequestTarget,
  formatTime,
  normalizeDurationSeconds,
  planDurationTransition,
  playbackPositionAt,
  writeAnnotationEdits,
} from "./model.ts";

const fabric = connectFabric();
const input = fabric.cell<typeof DEFAULT_INPUT>("input");
const state = fabric.cell<typeof DEFAULT_STATE>("state");
const output = fabric.cell<typeof DEFAULT_OUTPUT>("output");
const annotationsCell = state.key("annotations");
const assessmentsCell = state.key("assessments");

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) throw new Error("Shared Tape Lab needs a #root element.");

const abort = new AbortController();
const { signal } = abort;
let hydrated = false;
let disposed = false;
let reviewerId = "";
let audioContext: AudioContext | undefined;
let audioBuffer: AudioBuffer | undefined;
let mediaDestination: MediaStreamAudioDestinationNode | undefined;
let activeSource: AudioBufferSourceNode | undefined;
let playbackOffsetSeconds = 0;
let playbackStartedAt: number | undefined;
let animationFrame: number | undefined;
let loadedDurationSeconds: number | undefined;
let requestedDurationSeconds: number | undefined;
let durationSync: Promise<void> | undefined;
let durationReady = false;
let resumeAfterDurationSync = false;
let failedDurationSeconds: number | undefined;
let durationErrorMessage: string | undefined;
let activeCueIds = new Set<string>();
let dialogMode:
  | { kind: "new" }
  | { kind: "edit"; id: string; baseline: AnnotationEdits } = {
    kind: "new",
  };
let dialogSaving = false;
const assessmentDrafts = new Map<string, number>();
const pendingAssessmentIds = new Set<string>();

const app = document.createElement("main");
app.className = "app";
app.dataset.testid = "shared-tape-lab";

const eyebrow = document.createElement("p");
eyebrow.className = "eyebrow";
eyebrow.textContent = "Collaborative listening study";

const title = document.createElement("h1");
title.textContent = "Loading tape…";

const deck = document.createElement("p");
deck.className = "deck";
deck.textContent =
  "Mark moments in a shared field tape, then compare confidence without synchronizing anyone's playhead.";

const tapeDeck = document.createElement("section");
tapeDeck.className = "tape-deck";

const tapeHeading = document.createElement("div");
tapeHeading.className = "tape-heading";
const recordingLabel = document.createElement("p");
recordingLabel.className = "recording-label";
recordingLabel.textContent = "Preparing synthetic recording";
const timecode = document.createElement("output");
timecode.className = "timecode";
timecode.setAttribute("aria-label", "Local playhead");
timecode.textContent = "00:00.0";
tapeHeading.append(recordingLabel, timecode);

const audio = document.createElement("audio");
audio.preload = "metadata";
audio.setAttribute("aria-label", "Synthetic field recording");
audio.dataset.testid = "field-recording";

const scrubber = document.createElement("input");
// A MediaStream has no finite media duration, so the recording's local
// position and seek boundary live in this finite tape control.
scrubber.type = "range";
scrubber.min = "0";
scrubber.max = String(DEFAULT_INPUT.durationSeconds);
scrubber.step = "0.1";
scrubber.value = "0";
scrubber.disabled = true;
scrubber.setAttribute("aria-label", "Local recording position");
scrubber.dataset.testid = "local-playhead";
const scrubberReadout = document.createElement("output");
scrubberReadout.textContent = `00:00.0 / ${
  formatTime(DEFAULT_INPUT.durationSeconds)
}`;
const scrubberRow = document.createElement("div");
scrubberRow.className = "scrubber-row";
scrubberRow.append(scrubber, scrubberReadout);

const transportNote = document.createElement("p");
transportNote.className = "transport-note";
transportNote.textContent =
  "Playback stays in this browser. Only annotations and confidence assessments are shared.";

const toolbar = document.createElement("div");
toolbar.className = "toolbar";
const addButton = document.createElement("button");
addButton.type = "button";
addButton.textContent = "Add at playhead";
addButton.disabled = true;
addButton.dataset.testid = "add-at-playhead";
const status = document.createElement("p");
status.className = "status";
status.textContent = "Joining the shared tape…";
status.dataset.ready = "false";
status.dataset.testid = "tape-status";
toolbar.append(addButton);
tapeDeck.append(
  tapeHeading,
  audio,
  scrubberRow,
  transportNote,
  toolbar,
  status,
);

const annotationsSection = document.createElement("section");
annotationsSection.className = "annotations";
const annotationHeading = document.createElement("div");
annotationHeading.className = "annotation-heading";
const annotationTitle = document.createElement("h2");
annotationTitle.textContent = "Shared annotations";
const annotationCount = document.createElement("span");
annotationCount.className = "annotation-count";
annotationCount.textContent = "Loading";
annotationHeading.append(annotationTitle, annotationCount);
const annotationList = document.createElement("div");
annotationList.className = "annotation-list";
annotationList.dataset.testid = "annotation-list";

const consensusPanel = document.createElement("div");
consensusPanel.className = "consensus-panel";
const consensusLabel = document.createElement("span");
consensusLabel.className = "consensus-label";
consensusLabel.textContent = "Select an annotation to inspect consensus.";
const consensusMeter = document.createElement("meter");
consensusMeter.min = 0;
consensusMeter.max = 1;
consensusMeter.low = 0.4;
consensusMeter.high = 0.75;
consensusMeter.optimum = 1;
consensusMeter.value = 0;
consensusMeter.setAttribute("aria-label", "Selected annotation confidence");
consensusMeter.dataset.testid = "consensus-meter";
const consensusValue = document.createElement("output");
consensusValue.textContent = "—";
consensusPanel.append(consensusLabel, consensusMeter, consensusValue);

annotationsSection.append(annotationHeading, annotationList, consensusPanel);

const error = document.createElement("p");
error.className = "error";
error.role = "alert";
error.setAttribute("aria-live", "assertive");

const dialog = document.createElement("dialog");
dialog.dataset.testid = "annotation-dialog";
const dialogBody = document.createElement("div");
dialogBody.className = "dialog-body";
const dialogTitle = document.createElement("h2");
const timeFields = document.createElement("div");
timeFields.className = "time-fields";

const makeField = (label: string, control: HTMLElement): HTMLLabelElement => {
  const field = document.createElement("label");
  field.className = "field";
  const text = document.createElement("span");
  text.textContent = label;
  field.append(text, control);
  return field;
};

const startInput = document.createElement("input");
startInput.type = "number";
startInput.min = "0";
startInput.step = "0.1";
startInput.dataset.testid = "annotation-start";
const endInput = document.createElement("input");
endInput.type = "number";
endInput.min = "0.1";
endInput.step = "0.1";
endInput.dataset.testid = "annotation-end";
timeFields.append(
  makeField("Start (seconds)", startInput),
  makeField("End (seconds)", endInput),
);

const labelInput = document.createElement("input");
labelInput.type = "text";
labelInput.maxLength = 64;
labelInput.placeholder = "What do you hear?";
labelInput.dataset.testid = "annotation-label";
const noteInput = document.createElement("textarea");
noteInput.maxLength = 280;
noteInput.placeholder = "Describe the moment for the other listeners.";
noteInput.dataset.testid = "annotation-note";
const confidenceInput = document.createElement("input");
confidenceInput.type = "range";
confidenceInput.min = "0";
confidenceInput.max = "100";
confidenceInput.step = "1";
confidenceInput.value = "70";
confidenceInput.dataset.testid = "annotation-confidence";
const confidenceReadout = document.createElement("output");
confidenceReadout.textContent = "70%";
const confidenceField = makeField("Initial confidence", confidenceInput);
confidenceField.append(confidenceReadout);

const dialogActions = document.createElement("div");
dialogActions.className = "dialog-actions";
const cancelButton = document.createElement("button");
cancelButton.type = "button";
cancelButton.textContent = "Cancel";
cancelButton.dataset.testid = "cancel-annotation";
const saveButton = document.createElement("button");
saveButton.type = "button";
saveButton.textContent = "Save annotation";
saveButton.disabled = true;
saveButton.dataset.testid = "save-annotation";
dialogActions.append(cancelButton, saveButton);

dialogBody.append(
  dialogTitle,
  timeFields,
  makeField("Label", labelInput),
  makeField("Listening note", noteInput),
  confidenceField,
  dialogActions,
);
dialog.append(dialogBody);

app.append(eyebrow, title, deck, tapeDeck, annotationsSection, error, dialog);
root.append(app);

const textTrack = audio.addTextTrack("metadata", "Shared annotations", "en");
textTrack.mode = "hidden";

function showError(cause: unknown): void {
  durationErrorMessage = undefined;
  error.textContent = cause instanceof Error ? cause.message : String(cause);
}

function clearError(): void {
  durationErrorMessage = undefined;
  error.textContent = "";
}

function showDurationError(cause: unknown): void {
  const detail = cause instanceof Error ? cause.message : String(cause);
  durationErrorMessage = `Could not update the recording duration. ${detail}`;
  error.textContent = durationErrorMessage;
}

function clearDurationError(): void {
  if (error.textContent === durationErrorMessage) error.textContent = "";
  durationErrorMessage = undefined;
}

function durationControlsReady(): boolean {
  return hydrated && durationReady && !disposed;
}

function currentRequestedDuration(): number {
  return normalizeDurationSeconds(
    input.get()?.durationSeconds ?? DEFAULT_INPUT.durationSeconds,
  );
}

function applyDurationControlState(): void {
  const ready = durationControlsReady();
  audio.controls = ready;
  scrubber.disabled = !ready;
  addButton.disabled = !ready;
  saveButton.disabled = dialogSaving || !ready;
  if (audioBuffer) {
    const duration = audioBuffer.duration;
    scrubber.max = String(duration);
    startInput.max = String(duration);
    endInput.max = String(duration);
  }
}

function syncCues(annotations: readonly TapeAnnotation[]): void {
  const cues = textTrack.cues;
  if (cues) {
    for (const cue of [...cues]) textTrack.removeCue(cue);
  }
  for (const annotation of cueSpecs(annotations)) {
    const cue = new VTTCue(
      annotation.startSeconds,
      annotation.endSeconds,
      annotation.text,
    );
    cue.id = annotation.id;
    textTrack.addCue(cue);
  }
}

function updateActiveCueIds(): void {
  const playhead = playbackPosition();
  activeCueIds = new Set(
    hydrated
      ? (state.get()?.annotations ?? []).filter((annotation) =>
        annotation.range.startSeconds <= playhead &&
        annotation.range.endSeconds >= playhead
      ).map((annotation) => annotation.id)
      : [],
  );
  for (
    const card of annotationList.querySelectorAll<HTMLElement>(
      ".annotation-card",
    )
  ) {
    card.dataset.active = String(activeCueIds.has(card.dataset.annotationId!));
  }
}

function render(): void {
  if (!hydrated || disposed) return;
  const inputValue = input.get();
  const stateValue = state.get();
  const outputValue = output.get();
  if (!inputValue || !stateValue || !outputValue) return;

  title.textContent = inputValue.title;
  recordingLabel.textContent = inputValue.recordingLabel;
  annotationCount.textContent = `${stateValue.annotations.length} marked`;
  syncCues(stateValue.annotations);

  annotationList.replaceChildren();
  for (const annotation of stateValue.annotations) {
    const card = document.createElement("article");
    card.className = "annotation-card";
    card.dataset.annotationId = annotation.id;
    card.dataset.testid = `annotation-${annotation.id}`;
    card.dataset.selected = String(
      outputValue.selectedAnnotationId === annotation.id,
    );
    card.dataset.active = String(activeCueIds.has(annotation.id));

    const top = document.createElement("div");
    top.className = "card-top";
    const label = document.createElement("h3");
    label.textContent = annotation.label;
    const range = document.createElement("button");
    range.type = "button";
    range.textContent = `${formatTime(annotation.range.startSeconds)}–${
      formatTime(annotation.range.endSeconds)
    }`;
    range.disabled = !durationControlsReady();
    range.addEventListener("click", () => {
      void seekPlayback(annotation.range.startSeconds).catch(showError);
      void output.key("selectedAnnotationId").set(annotation.id).catch(
        showError,
      );
    }, { signal });
    top.append(label, range);

    const note = document.createElement("p");
    note.textContent = annotation.note;
    const byline = document.createElement("span");
    byline.className = "byline";
    byline.textContent = `Stable cue · ${annotation.id}`;

    const values = assessmentValues(annotation, stateValue.assessments);
    const confidence = confidenceFor(annotation, stateValue.assessments);
    const confidenceRow = document.createElement("div");
    confidenceRow.className = "confidence-row";
    const meter = document.createElement("meter");
    meter.min = 0;
    meter.max = 1;
    meter.low = 0.4;
    meter.high = 0.75;
    meter.optimum = 1;
    meter.value = confidence;
    meter.setAttribute("aria-label", `${annotation.label} confidence`);
    const meterValue = document.createElement("span");
    meterValue.textContent = `${
      Math.round(confidence * 100)
    }% · ${values.length} ${values.length === 1 ? "reading" : "readings"}`;
    confidenceRow.append(meter, meterValue);

    const assessmentEditor = document.createElement("div");
    assessmentEditor.className = "assessment-editor";
    const assessmentInput = document.createElement("input");
    assessmentInput.type = "range";
    assessmentInput.min = "0";
    assessmentInput.max = "100";
    assessmentInput.step = "1";
    assessmentInput.value = String(
      assessmentDrafts.get(annotation.id) ?? Math.round(confidence * 100),
    );
    assessmentInput.setAttribute(
      "aria-label",
      `Confidence assessment for ${annotation.label}`,
    );
    const assessButton = document.createElement("button");
    assessButton.type = "button";
    assessButton.textContent = "Add reading";
    assessButton.dataset.testid = `add-reading-${annotation.id}`;
    assessButton.disabled = pendingAssessmentIds.has(annotation.id);
    assessmentInput.disabled = assessButton.disabled;
    assessmentInput.addEventListener("input", () => {
      assessmentDrafts.set(annotation.id, Number(assessmentInput.value));
    }, { signal });
    assessButton.addEventListener("click", () => {
      const confidence = Number(assessmentInput.value) / 100;
      const assessment: ConfidenceAssessment = {
        id: crypto.randomUUID(),
        annotationId: annotation.id,
        reviewerId,
        confidence,
      };
      pendingAssessmentIds.add(annotation.id);
      renderSafely();
      clearError();
      void assessmentsCell.push(assessment).then(async () => {
        await output.key("lastAssessmentId").set(assessment.id);
        assessmentDrafts.delete(annotation.id);
      }).catch(showError).finally(() => {
        pendingAssessmentIds.delete(annotation.id);
        renderSafely();
      });
    }, { signal });
    assessmentEditor.append(assessmentInput, assessButton);

    const cardToolbar = document.createElement("div");
    cardToolbar.className = "toolbar";
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.textContent = "Edit annotation";
    editButton.dataset.testid = `edit-${annotation.id}`;
    editButton.disabled = !durationControlsReady();
    editButton.addEventListener("click", () => openEditor(annotation), {
      signal,
    });
    cardToolbar.append(editButton);

    card.append(
      top,
      note,
      byline,
      confidenceRow,
      assessmentEditor,
      cardToolbar,
    );
    annotationList.append(card);
  }

  const selected = stateValue.annotations.find((annotation) =>
    annotation.id === outputValue.selectedAnnotationId
  );
  if (selected) {
    const confidence = confidenceFor(selected, stateValue.assessments);
    consensusLabel.textContent = `${selected.label} · community confidence`;
    consensusMeter.value = confidence;
    consensusValue.textContent = `${Math.round(confidence * 100)}%`;
  } else {
    consensusLabel.textContent = "Select an annotation to inspect consensus.";
    consensusMeter.value = 0;
    consensusValue.textContent = "—";
  }
  updateActiveCueIds();
}

function renderSafely(): void {
  try {
    render();
  } catch (cause) {
    showError(cause);
  }
}

function setDialogSaving(saving: boolean): void {
  dialogSaving = saving;
  startInput.disabled = saving;
  endInput.disabled = saving;
  labelInput.disabled = saving;
  noteInput.disabled = saving;
  confidenceInput.disabled = saving || dialogMode.kind === "edit";
  cancelButton.disabled = saving;
  saveButton.disabled = saving || !durationControlsReady();
}

function openEditor(annotation?: TapeAnnotation): void {
  if (dialogSaving || !durationControlsReady()) return;
  clearError();
  if (annotation) {
    dialogMode = {
      kind: "edit",
      id: annotation.id,
      baseline: {
        range: { ...annotation.range },
        label: annotation.label,
        note: annotation.note,
      },
    };
    dialogTitle.textContent = "Edit shared annotation";
    saveButton.textContent = "Save changes";
    startInput.value = annotation.range.startSeconds.toFixed(1);
    endInput.value = annotation.range.endSeconds.toFixed(1);
    labelInput.value = annotation.label;
    noteInput.value = annotation.note;
    confidenceInput.value = String(
      Math.round(annotation.initialConfidence * 100),
    );
    confidenceInput.disabled = true;
    confidenceReadout.textContent = "Recorded at creation";
  } else {
    dialogMode = { kind: "new" };
    dialogTitle.textContent = "Mark the shared tape";
    saveButton.textContent = "Save annotation";
    const duration = playbackDuration();
    const start = Math.min(
      playbackPosition(),
      Math.max(0, duration - 0.2),
    );
    const end = Math.min(duration, start + 1.5);
    startInput.value = start.toFixed(1);
    endInput.value = end.toFixed(1);
    labelInput.value = "";
    noteInput.value = "";
    confidenceInput.value = "70";
    confidenceInput.disabled = false;
    confidenceReadout.textContent = "70%";
  }
  setDialogSaving(false);
  dialog.showModal();
  labelInput.focus();
}

async function saveAnnotation(): Promise<void> {
  if (!durationControlsReady()) {
    throw new Error("The recording duration is still updating.");
  }
  clearError();
  const duration = playbackDuration();
  const startSeconds = Number(startInput.value);
  const endSeconds = Number(endInput.value);
  const label = labelInput.value.trim();
  const note = noteInput.value.trim();
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
    throw new TypeError("Start and end must be numbers.");
  }
  if (startSeconds < 0 || endSeconds <= startSeconds || endSeconds > duration) {
    throw new RangeError(
      `Choose a range within 0–${duration} seconds, with the end after the start.`,
    );
  }
  if (!label) throw new TypeError("Give the annotation a label.");
  if (!note) throw new TypeError("Add a listening note.");

  setDialogSaving(true);
  const mode = dialogMode;
  if (mode.kind === "new") {
    const annotation: TapeAnnotation = {
      id: crypto.randomUUID(),
      range: { startSeconds, endSeconds },
      label,
      note,
      authorId: reviewerId,
      initialConfidence: Number(confidenceInput.value) / 100,
    };
    await annotationsCell.push(annotation);
    await output.key("selectedAnnotationId").set(annotation.id);
  } else {
    const annotations = await annotationsCell.pull();
    const index = annotations.findIndex((item) => item.id === mode.id);
    if (index < 0) {
      throw new Error("That annotation is no longer available.");
    }
    const resolved = await annotationsCell.key(index).resolve();
    const next = {
      range: { startSeconds, endSeconds },
      label,
      note,
    };
    await writeAnnotationEdits(
      resolved,
      changedAnnotationEdits(mode.baseline, next),
    );
    await output.key("selectedAnnotationId").set(mode.id);
  }
  dialog.close();
}

function playbackDuration(): number {
  return audioBuffer?.duration ?? normalizeDurationSeconds(
    input.get()?.durationSeconds ?? DEFAULT_INPUT.durationSeconds,
  );
}

function playbackPosition(): number {
  return playbackPositionAt(
    playbackDuration(),
    playbackOffsetSeconds,
    activeSource ? playbackStartedAt : undefined,
    audioContext?.currentTime ?? 0,
  );
}

function updateTimecode(): void {
  const position = playbackPosition();
  const duration = playbackDuration();
  timecode.textContent = formatTime(position);
  scrubber.value = String(position);
  scrubberReadout.textContent = `${formatTime(position)} / ${
    formatTime(duration)
  }`;
  updateActiveCueIds();
}

function stopPlaybackSource(): void {
  if (!activeSource) return;
  const position = playbackPosition();
  const source = activeSource;
  activeSource = undefined;
  playbackStartedAt = undefined;
  playbackOffsetSeconds = position;
  source.onended = null;
  try {
    source.stop();
  } catch (cause) {
    if (
      !(cause instanceof DOMException && cause.name === "InvalidStateError")
    ) {
      throw cause;
    }
  }
  source.disconnect();
}

function updatePlaybackFrame(): void {
  animationFrame = undefined;
  updateTimecode();
  if (activeSource && !audio.paused && !disposed) {
    animationFrame = requestAnimationFrame(updatePlaybackFrame);
  }
}

async function startPlayback(): Promise<void> {
  if (
    !durationControlsReady() || !audioContext || !audioBuffer ||
    !mediaDestination || activeSource
  ) {
    return;
  }
  if (playbackOffsetSeconds >= audioBuffer.duration) {
    playbackOffsetSeconds = 0;
  }
  await audioContext.resume();
  if (audio.paused || disposed) return;

  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(mediaDestination);
  activeSource = source;
  playbackStartedAt = audioContext.currentTime;
  source.onended = () => {
    if (activeSource !== source) return;
    activeSource = undefined;
    playbackStartedAt = undefined;
    playbackOffsetSeconds = audioBuffer!.duration;
    source.disconnect();
    updateTimecode();
    audio.pause();
  };
  source.start(0, playbackOffsetSeconds);
  if (animationFrame === undefined) {
    animationFrame = requestAnimationFrame(updatePlaybackFrame);
  }
}

async function seekPlayback(seconds: number): Promise<void> {
  if (!durationControlsReady()) return;
  const wasPlaying = activeSource !== undefined && !audio.paused;
  stopPlaybackSource();
  playbackOffsetSeconds = Math.min(
    playbackDuration(),
    Math.max(0, seconds),
  );
  updateTimecode();
  if (wasPlaying) await startPlayback();
}

async function rebuildAudioBuffer(
  durationSeconds: number,
  transitionPositionSeconds: number,
  resumeIntent: boolean,
): Promise<void> {
  if (!audioContext) throw new Error("The audio engine is not available.");
  const buffer = await audioContext.decodeAudioData(
    buildSyntheticWav(durationSeconds),
  );
  if (disposed) return;

  const plan = planDurationTransition(
    buffer.duration,
    transitionPositionSeconds,
    resumeIntent,
  );
  audioBuffer = buffer;
  loadedDurationSeconds = durationSeconds;
  playbackOffsetSeconds = plan.positionSeconds;
  resumeAfterDurationSync = plan.resumePlayback;
  applyDurationControlState();
  updateTimecode();
}

async function synchronizeRequestedDurations(): Promise<void> {
  durationReady = false;
  const transitionPositionSeconds = playbackPosition();
  const resumeIntent = activeSource !== undefined && !audio.paused;
  resumeAfterDurationSync = resumeIntent;
  stopPlaybackSource();
  status.textContent = "Updating recording duration…";
  status.dataset.ready = "false";
  applyDurationControlState();
  renderSafely();

  let failure: unknown;
  while (requestedDurationSeconds !== undefined && !disposed) {
    const duration = requestedDurationSeconds;
    requestedDurationSeconds = undefined;
    if (duration === loadedDurationSeconds) {
      failure = undefined;
      failedDurationSeconds = undefined;
      continue;
    }
    try {
      await rebuildAudioBuffer(
        duration,
        transitionPositionSeconds,
        resumeIntent,
      );
      failure = undefined;
      failedDurationSeconds = undefined;
    } catch (cause) {
      failure = cause;
      failedDurationSeconds = duration;
    }
  }
  if (disposed) return;

  const currentDuration = currentRequestedDuration();
  durationReady = failure === undefined &&
    loadedDurationSeconds === currentDuration;
  applyDurationControlState();
  renderSafely();
  updateTimecode();

  if (!durationReady) {
    if (!audio.paused) audio.pause();
    showDurationError(failure);
    status.textContent = "Recording duration update failed";
    status.dataset.ready = "false";
    return;
  }

  clearDurationError();
  status.textContent = "Shared tape ready";
  status.dataset.ready = "true";
  if (resumeAfterDurationSync && !audio.paused) {
    await startPlayback();
  } else if (!audio.paused) {
    audio.pause();
  }
}

function requestDurationSync(): void {
  if (disposed) return;
  const duration = currentRequestedDuration();
  const target = durationRequestTarget(
    duration,
    loadedDurationSeconds,
    hydrated && durationReady,
  );
  if (!hydrated) {
    requestedDurationSeconds = target;
    return;
  }
  if (target === undefined && durationSync === undefined) {
    requestedDurationSeconds = undefined;
    return;
  }
  if (
    duration === failedDurationSeconds && durationSync === undefined
  ) {
    return;
  }
  if (duration !== failedDurationSeconds) failedDurationSeconds = undefined;
  requestedDurationSeconds = target;
  if (durationSync) return;

  durationSync = synchronizeRequestedDurations().catch((cause) => {
    durationReady = false;
    applyDurationControlState();
    renderSafely();
    showDurationError(cause);
    status.textContent = "Recording duration update failed";
    status.dataset.ready = "false";
  }).finally(() => {
    durationSync = undefined;
    if (requestedDurationSeconds !== undefined && !disposed) {
      requestDurationSync();
    }
  });
}

function waitForMediaReady(): Promise<void> {
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      audio.removeEventListener("loadedmetadata", loaded);
      audio.removeEventListener("error", failed);
    };
    const loaded = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error(audio.error?.message ?? "The recording did not load."));
    };
    audio.addEventListener("loadedmetadata", loaded);
    audio.addEventListener("error", failed);
  });
}

function teardown(): void {
  if (disposed) return;
  disposed = true;
  abort.abort();
  stops.forEach((stop) => stop());
  if (dialog.open) dialog.close();
  audio.pause();
  stopPlaybackSource();
  if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
  animationFrame = undefined;
  audio.srcObject = null;
  mediaDestination?.stream.getTracks().forEach((track) => track.stop());
  void audioContext?.close().catch(() => undefined);
  const cues = textTrack.cues;
  if (cues) {
    for (const cue of [...cues]) textTrack.removeCue(cue);
  }
  fabric.disconnect();
}

function handleInputUpdate(): void {
  renderSafely();
  requestDurationSync();
}

const stops = [
  input.sink(handleInputUpdate),
  state.sink(renderSafely),
  output.sink(renderSafely),
];

audio.addEventListener("play", () => {
  void startPlayback().catch((cause) => {
    showError(cause);
    audio.pause();
  });
}, { signal });
audio.addEventListener("pause", () => {
  try {
    stopPlaybackSource();
    updateTimecode();
  } catch (cause) {
    showError(cause);
  }
}, { signal });
scrubber.addEventListener("input", () => {
  void seekPlayback(Number(scrubber.value)).catch(showError);
}, { signal });
confidenceInput.addEventListener("input", () => {
  confidenceReadout.textContent = `${confidenceInput.value}%`;
}, { signal });
addButton.addEventListener("click", () => openEditor(), { signal });
cancelButton.addEventListener("click", () => {
  if (!dialogSaving) dialog.close();
}, { signal });
dialog.addEventListener("cancel", (event) => {
  if (dialogSaving) event.preventDefault();
}, { signal });
saveButton.addEventListener("click", () => {
  void saveAnnotation().catch((cause) => {
    showError(cause);
  }).finally(() => setDialogSaving(false));
}, { signal });
globalThis.addEventListener("pagehide", teardown, { once: true, signal });

void (async () => {
  try {
    await Promise.all([
      input.pull(),
      state.pull(),
      output.pull(),
    ]);
    await Promise.all([
      state.initialize(DEFAULT_STATE),
      output.initialize(DEFAULT_OUTPUT),
    ]);
    const inputValue = input.get();
    if (!inputValue) {
      throw new Error("The tape input did not hydrate.");
    }
    const resolvedOutput = await output.resolve();
    reviewerId = resolvedOutput.identity?.instanceId ?? "";
    if (!reviewerId) {
      throw new Error("The per-user output has no resolved identity.");
    }
    const duration = normalizeDurationSeconds(inputValue.durationSeconds);
    // The iframe policy disables URL-backed media. Decode the recording in
    // memory and route it through a MediaStream, which does not fetch a URL.
    audioContext = new AudioContext();
    audioBuffer = await audioContext.decodeAudioData(
      buildSyntheticWav(duration),
    );
    loadedDurationSeconds = duration;
    mediaDestination = audioContext.createMediaStreamDestination();
    audio.srcObject = mediaDestination.stream;
    await waitForMediaReady();
    hydrated = true;
    durationReady = true;
    requestDurationSync();
    await durationSync;
    if (!durationReady) return;
    applyDurationControlState();
    status.textContent = "Shared tape ready";
    status.dataset.ready = "true";
    updateTimecode();
    render();
  } catch (cause) {
    showError(cause);
    status.textContent = "Could not join the shared tape";
    teardown();
  }
})();
