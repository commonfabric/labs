/**
 * Self — private self-model data layer.
 *
 * Owns the single, home-local, never-shared record of the user's real self:
 * their values, neurotype assessments, and reflective Q&A responses.
 *
 * This is NOT a profile (outward-facing, many). This is the one private
 * self-model: values, neurotype, and meaning-alignment answers.
 *
 * Usage from other patterns:
 *   const self = wish<SelfOutput>({ query: "#selfModel" });
 */
import {
  computed,
  type Default,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// ============================================================================
// EXPORTED TYPES (verbatim from CT-1670 spec)
// ============================================================================

export type NeurotypeSystem = "mbti" | "enneagram" | "big5" | "custom";

export interface Neurotype {
  system: NeurotypeSystem;
  result: string; // "INTJ", "5w4"
  detail?: Record<string, number | string>;
  source: "self-reported" | "assessed";
  recordedAt: number;
}

export interface ValueCard {
  title: string;
  description?: string;
  weight?: number;
  sourcePromptId?: string;
  // CT-1674: meaning-alignment fields
  attendingTo?: string;
  stance?: "descriptive" | "aspirational" | "conflicted";
  contextTags?: string[];
  sourceTrack?: Track;
}

// ============================================================================
// MEANING-ALIGNMENT TYPES (CT-1674)
// ============================================================================

export type Track = "open" | "scissor" | "closing";

export interface ReflectivePrompt {
  id: string;
  text: string;
  kind: Track;
}

export const MEANING_PROMPTS: ReflectivePrompt[] = [
  {
    id: "open-life",
    kind: "open",
    text:
      "Tell me a bit about your life right now — whatever you'd want a thoughtful system to know about you. Start with what you do and the most important people in your life.",
  },
  {
    id: "sc-conflict",
    kind: "scissor",
    text:
      "Recall the last time a colleague or someone close said something that you thought was wrong, or that landed badly. What did you do with it — said something in the moment, followed up privately later, or let it go?",
  },
  {
    id: "sc-waiting",
    kind: "scissor",
    text:
      "Think of the most recent time you were waiting on something that mattered and couldn't speed it up. Did you move your attention away from it, stay close and hold the tension, or start preparing for both outcomes?",
  },
  {
    id: "sc-rhythms",
    kind: "scissor",
    text:
      "Is there a recurring shape to your weeks — a difference between some days and others, not just by schedule but by who you are in them? Is that contrast the whole shape of your life, a quiet undertone, or not really a thing for you?",
  },
  {
    id: "sc-unscheduled",
    kind: "scissor",
    text:
      "Recall the most recent full day with no hard commitments — genuinely yours. By the end, did it feel good, wasted, or like a work day in different clothes?",
  },
  {
    id: "sc-commitment",
    kind: "scissor",
    text:
      "Think back to the last time you committed to something for a friend or family member and it became clear you couldn't pull it off as promised. Did you tell them early, show up with a smaller version, or say nothing and scramble?",
  },
  {
    id: "sc-narrative",
    kind: "scissor",
    text:
      "Think of the phase of life you're in right now. Last time you tried to name what it's for — could you name it, are you between chapters, or do you not really think in phases-with-purposes?",
  },
  {
    id: "close-navigating",
    kind: "closing",
    text:
      "What are some things you're navigating right now that you'd want help with?",
  },
];

export interface QAResponse {
  promptId: string;
  prompt: string;
  answer: string;
  track: "meaning" | "neurotype" | "freeform";
  answeredAt: number;
}

export interface SelfModel {
  responses: QAResponse[];
  values: ValueCard[];
  neurotypes: Neurotype[];
}

export const EMPTY_SELF_MODEL: SelfModel = {
  responses: [],
  values: [],
  neurotypes: [],
};

// ============================================================================
// HANDLER EVENT PAYLOAD TYPES
// ============================================================================

export interface RecordNeurotypeEvent {
  system: NeurotypeSystem;
  result: string;
  detail?: Record<string, number | string>;
  source: "self-reported" | "assessed";
}

export interface AddValueCardEvent {
  title: string;
  description?: string;
  weight?: number;
  sourcePromptId?: string;
}

export interface RecordResponseEvent {
  promptId: string;
  prompt: string;
  answer: string;
  track: "meaning" | "neurotype" | "freeform";
}

export interface RemoveNeurotypeEvent {
  system: NeurotypeSystem;
}

export interface RemoveValueCardEvent {
  /** Zero-based index of the ValueCard to remove. */
  index: number;
}

// ============================================================================
// PURE HELPERS (exported — these ARE the shipping mutation logic)
// ============================================================================

/**
 * Upsert a neurotype entry by system.
 * Replaces the entry with the same `system` in-place, or appends if absent.
 */
export function upsertNeurotype(
  model: SelfModel,
  entry: Neurotype,
): SelfModel {
  const idx = model.neurotypes.findIndex((n) => n.system === entry.system);
  if (idx === -1) {
    return { ...model, neurotypes: [...model.neurotypes, entry] };
  }
  return {
    ...model,
    neurotypes: model.neurotypes.map((n, i) => (i === idx ? entry : n)),
  };
}

/** Return a new SelfModel with the ValueCard appended to `values`. */
export function appendValue(model: SelfModel, card: ValueCard): SelfModel {
  return { ...model, values: [...model.values, card] };
}

/** Return a new SelfModel with the QAResponse appended to `responses`. */
export function appendResponse(
  model: SelfModel,
  response: QAResponse,
): SelfModel {
  return { ...model, responses: [...model.responses, response] };
}

/** Return a new SelfModel with the neurotype for `system` removed. No-op if absent. */
export function withoutNeurotype(
  model: SelfModel,
  system: NeurotypeSystem,
): SelfModel {
  return {
    ...model,
    neurotypes: model.neurotypes.filter((n) => n.system !== system),
  };
}

/** Return a new SelfModel with the ValueCard at zero-based `index` removed. */
export function withoutValueAt(model: SelfModel, index: number): SelfModel {
  return {
    ...model,
    values: model.values.filter((_, i) => i !== index),
  };
}

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * Upsert a neurotype entry by system.
 * If an entry with the same `system` exists, it is replaced in-place.
 * Otherwise, it is appended.
 */
export const recordNeurotype = handler<
  RecordNeurotypeEvent,
  { selfModel: Writable<SelfModel> }
>(({ system, result, detail, source }, { selfModel }) => {
  const entry: Neurotype = {
    system,
    result,
    detail,
    source,
    recordedAt: Date.now(),
  };
  selfModel.set(upsertNeurotype(selfModel.get(), entry));
});

/** Append a ValueCard. */
export const addValueCard = handler<
  AddValueCardEvent,
  { selfModel: Writable<SelfModel> }
>(({ title, description, weight, sourcePromptId }, { selfModel }) => {
  const card: ValueCard = { title, description, weight, sourcePromptId };
  selfModel.set(appendValue(selfModel.get(), card));
});

/** Append a QAResponse. Timestamp is set automatically via Date.now(). */
export const recordResponse = handler<
  RecordResponseEvent,
  { selfModel: Writable<SelfModel> }
>(({ promptId, prompt, answer, track }, { selfModel }) => {
  const response: QAResponse = {
    promptId,
    prompt,
    answer,
    track,
    answeredAt: Date.now(),
  };
  selfModel.set(appendResponse(selfModel.get(), response));
});

/** Remove the neurotype entry whose system matches. No-op if not found. */
export const removeNeurotype = handler<
  RemoveNeurotypeEvent,
  { selfModel: Writable<SelfModel> }
>(({ system }, { selfModel }) => {
  selfModel.set(withoutNeurotype(selfModel.get(), system));
});

/**
 * Remove a ValueCard by zero-based index.
 * Index-based removal is stable for the current append-only model; when
 * sourcePromptId is populated, callers may prefer to find by that field.
 */
export const removeValueCard = handler<
  RemoveValueCardEvent,
  { selfModel: Writable<SelfModel> }
>(({ index }, { selfModel }) => {
  selfModel.set(withoutValueAt(selfModel.get(), index));
});

// ============================================================================
// PATTERN INPUT / OUTPUT
// ============================================================================

interface SelfInput {
  /**
   * Optional external Writable cell for the self-model.
   * When provided the pattern uses this cell directly (useful for testing
   * and for parent patterns that want to own the storage).
   * When omitted the pattern creates and owns its own durable cell.
   */
  selfModel?: Writable<SelfModel | Default<typeof EMPTY_SELF_MODEL>>;
}

/** Private self-model — the user's values, neurotype, and reflective answers. #selfModel */
export interface SelfOutput {
  [NAME]: string;
  [UI]: VNode;
  selfModel: Writable<SelfModel>;
  recordNeurotype: ReturnType<typeof recordNeurotype>;
  addValueCard: ReturnType<typeof addValueCard>;
  recordResponse: ReturnType<typeof recordResponse>;
  removeNeurotype: ReturnType<typeof removeNeurotype>;
  removeValueCard: ReturnType<typeof removeValueCard>;
}

// ============================================================================
// FORM HANDLERS (state-reading, for UI binding)
// ============================================================================

/**
 * Record a neurotype entry from form fields (state-reading handler).
 * Reads systemField + resultField from state; upserts into selfModel;
 * clears resultField after recording.
 */
export const recordNeurotypeFromForm = handler<
  unknown,
  {
    selfModel: Writable<SelfModel>;
    systemField: Writable<NeurotypeSystem>;
    resultField: Writable<string>;
  }
>((_event, { selfModel, systemField, resultField }) => {
  const result = resultField.get().trim();
  if (!result) return;
  const system = systemField.get();
  const entry: Neurotype = {
    system,
    result,
    source: "self-reported",
    recordedAt: Date.now(),
  };
  selfModel.set(upsertNeurotype(selfModel.get(), entry));
  resultField.set("");
});

/**
 * Remove a neurotype by system (state-reading handler, for per-row binding).
 */
export const removeNeurotypeBySystem = handler<
  unknown,
  { selfModel: Writable<SelfModel>; system: NeurotypeSystem }
>((_event, { selfModel, system }) => {
  selfModel.set(withoutNeurotype(selfModel.get(), system));
});

/**
 * Record a meaning reflection from form fields (state-reading handler).
 * Looks up the prompt in MEANING_PROMPTS by currentPromptId; if answerField
 * is non-empty, appends a QAResponse(track:"meaning") and clears answerField.
 */
export const recordReflectionFromForm = handler<
  unknown,
  {
    selfModel: Writable<SelfModel>;
    currentPromptId: Writable<string>;
    answerField: Writable<string>;
  }
>((_event, { selfModel, currentPromptId, answerField }) => {
  const answer = answerField.get().trim();
  if (!answer) return;
  const promptId = currentPromptId.get();
  const prompt = MEANING_PROMPTS.find((p) => p.id === promptId);
  if (!prompt) return;
  const response: QAResponse = {
    promptId: prompt.id,
    prompt: prompt.text,
    answer,
    track: "meaning",
    answeredAt: Date.now(),
  };
  selfModel.set(appendResponse(selfModel.get(), response));
  answerField.set("");
});

/**
 * Add a value card from form fields (state-reading handler).
 * Reads titleField, attendingToField, stanceField, contextTagsField;
 * if title non-empty, appends a ValueCard and clears all fields.
 */
export const addValueCardFromForm = handler<
  unknown,
  {
    selfModel: Writable<SelfModel>;
    titleField: Writable<string>;
    attendingToField: Writable<string>;
    stanceField: Writable<"descriptive" | "aspirational" | "conflicted">;
    contextTagsField: Writable<string>;
  }
>((
  _event,
  { selfModel, titleField, attendingToField, stanceField, contextTagsField },
) => {
  const title = titleField.get().trim();
  if (!title) return;
  const attendingTo = attendingToField.get().trim() || undefined;
  const stance = stanceField.get();
  const rawTags = contextTagsField.get();
  const contextTags = rawTags
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const card: ValueCard = {
    title,
    attendingTo,
    stance,
    contextTags: contextTags.length > 0 ? contextTags : undefined,
  };
  selfModel.set(appendValue(selfModel.get(), card));
  titleField.set("");
  attendingToField.set("");
  // stanceField intentionally retains the last-selected stance (3-way enum, no neutral)
  contextTagsField.set("");
});

/**
 * Remove a value card by index (state-reading handler, for per-row binding).
 */
export const removeValueCardByIndex = handler<
  unknown,
  { selfModel: Writable<SelfModel>; index: number }
>((_event, { selfModel, index }) => {
  const current = selfModel.get();
  selfModel.update({
    values: current.values.filter((_, i) => i !== index),
  });
});

// ============================================================================
// MAIN PATTERN
// ============================================================================

const Self = pattern<SelfInput, SelfOutput>(
  ({ selfModel }) => {
    // `selfModel` is seeded with EMPTY_SELF_MODEL via Default<> when the pattern
    // owns its cell (home-local, no injection) and may be injected by tests or
    // parent patterns. Previously this used `injected ?? new Writable(...).for()`,
    // but a `new Writable(initial)` on the RIGHT of ?? is lowered to a lift whose
    // value is undefined when uninjected — so the owned cell never seeded and
    // every capture handler threw on `selfModel.get().neurotypes` (CT-1669).

    // Local form field cells — neurotype
    const systemField = new Writable<NeurotypeSystem>("mbti").for(
      "systemField",
    );
    const resultField = new Writable<string>("").for("resultField");

    // Local form field cells — meaning reflections
    const currentPromptId = new Writable<string>(MEANING_PROMPTS[0].id).for(
      "currentPromptId",
    );
    const answerField = new Writable<string>("").for("answerField");

    // Local form field cells — value cards
    const titleField = new Writable<string>("").for("titleField");
    const attendingToField = new Writable<string>("").for("attendingToField");
    const stanceField = new Writable<
      "descriptive" | "aspirational" | "conflicted"
    >("descriptive").for("stanceField");
    const contextTagsField = new Writable<string>("").for("contextTagsField");

    const neurotypeSystemItems: { label: string; value: NeurotypeSystem }[] = [
      { label: "MBTI", value: "mbti" },
      { label: "Enneagram", value: "enneagram" },
      { label: "Big Five", value: "big5" },
      { label: "Custom", value: "custom" },
    ];

    const promptSelectItems = MEANING_PROMPTS.map((p) => ({
      label: p.text.slice(0, 60) + (p.text.length > 60 ? "…" : ""),
      value: p.id,
    }));

    const stanceItems: {
      label: string;
      value: "descriptive" | "aspirational" | "conflicted";
    }[] = [
      { label: "Descriptive (how I already attend)", value: "descriptive" },
      { label: "Aspirational (how I want to attend)", value: "aspirational" },
      { label: "Conflicted (unclear or in tension)", value: "conflicted" },
    ];

    return {
      [NAME]: "My Self",
      // [UI] must be a static VNode — not wrapped in computed().
      [UI]: (
        <cf-vstack gap="4" style={{ padding: "16px" }}>
          <h2
            style={{ margin: "0 0 4px", fontSize: "16px", fontWeight: "600" }}
          >
            Self Model
          </h2>
          <p style={{ margin: 0, fontSize: "13px", color: "#6b7280" }}>
            Your private self-model. Never shared.
          </p>

          <cf-vstack gap="2">
            <h3 style={{ margin: 0, fontSize: "14px", fontWeight: "600" }}>
              Record Neurotype
            </h3>
            <cf-hstack gap="2" align="end">
              <cf-select
                $value={systemField}
                items={neurotypeSystemItems}
                style="flex: 0 0 150px;"
              />
              <cf-input
                $value={resultField}
                placeholder="e.g. INTJ, 5w4…"
                style="flex: 1 1 auto; min-width: 0;"
              />
              <cf-button
                onClick={recordNeurotypeFromForm({
                  selfModel,
                  systemField,
                  resultField,
                })}
              >
                Record
              </cf-button>
            </cf-hstack>
          </cf-vstack>

          <cf-vstack gap="2">
            <h3 style={{ margin: 0, fontSize: "14px", fontWeight: "600" }}>
              Neurotypes
            </h3>
            {selfModel.key("neurotypes").map((n) => (
              <cf-hstack gap="2" align="center">
                <span
                  style={{
                    fontSize: "13px",
                    fontWeight: "600",
                    minWidth: "90px",
                  }}
                >
                  {n.system}
                </span>
                <span style={{ fontSize: "13px", flex: "1" }}>{n.result}</span>
                <cf-button
                  size="sm"
                  variant="ghost"
                  onClick={removeNeurotypeBySystem({
                    selfModel,
                    system: n.system,
                  })}
                >
                  ✕
                </cf-button>
              </cf-hstack>
            ))}
          </cf-vstack>

          {
            /* ================================================================
              MEANING & VALUES (CT-1674)
          ================================================================ */
          }
          <cf-vstack
            gap="3"
            style={{ borderTop: "1px solid #e5e7eb", paddingTop: "16px" }}
          >
            <h2
              style={{ margin: "0 0 4px", fontSize: "16px", fontWeight: "600" }}
            >
              Meaning &amp; Values
            </h2>
            <p style={{ margin: 0, fontSize: "13px", color: "#6b7280" }}>
              Reflective prompts and your value cards — what you attend to that
              matters.
            </p>

            {/* -- Reflect section -- */}
            <cf-vstack gap="2">
              <h3 style={{ margin: 0, fontSize: "14px", fontWeight: "600" }}>
                Reflect
              </h3>
              <cf-select
                $value={currentPromptId}
                items={promptSelectItems}
                style="width: 100%;"
              />
              <p
                style={{
                  margin: "4px 0",
                  fontSize: "13px",
                  color: "#374151",
                  fontStyle: "italic",
                }}
              >
                {computed(() =>
                  MEANING_PROMPTS.find((x) => x.id === currentPromptId.get())
                    ?.text ?? ""
                )}
              </p>
              <cf-textarea
                $value={answerField}
                placeholder="Your reflection…"
                style="width: 100%;"
              />
              <cf-button
                onClick={recordReflectionFromForm({
                  selfModel,
                  currentPromptId,
                  answerField,
                })}
              >
                Record reflection
              </cf-button>
            </cf-vstack>

            <cf-vstack gap="2">
              <h3 style={{ margin: 0, fontSize: "14px", fontWeight: "600" }}>
                Recorded reflections
              </h3>
              {selfModel.key("responses").map((r) =>
                ifElse(
                  computed(() => r.track === "meaning"),
                  <cf-vstack
                    gap="1"
                    style={{
                      padding: "8px",
                      background: "#f9fafb",
                      borderRadius: "6px",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "12px",
                        color: "#6b7280",
                        fontStyle: "italic",
                      }}
                    >
                      {r.prompt}
                    </span>
                    <span style={{ fontSize: "13px", color: "#111827" }}>
                      {r.answer}
                    </span>
                  </cf-vstack>,
                  null,
                )
              )}
            </cf-vstack>

            {/* -- Your values section -- */}
            <cf-vstack gap="2">
              <h3 style={{ margin: 0, fontSize: "14px", fontWeight: "600" }}>
                Add a value
              </h3>
              <cf-input
                $value={titleField}
                placeholder="Title"
                style="width: 100%;"
              />
              <cf-input
                $value={attendingToField}
                placeholder="What you attend to (e.g. a disagreement at the moment it is live)"
                style="width: 100%;"
              />
              <cf-select
                $value={stanceField}
                items={stanceItems}
                style="width: 100%;"
              />
              <cf-input
                $value={contextTagsField}
                placeholder="Context tags, comma-separated (e.g. work, solo)"
                style="width: 100%;"
              />
              <cf-button
                onClick={addValueCardFromForm({
                  selfModel,
                  titleField,
                  attendingToField,
                  stanceField,
                  contextTagsField,
                })}
              >
                Add value
              </cf-button>
            </cf-vstack>

            <cf-vstack gap="2">
              <h3 style={{ margin: 0, fontSize: "14px", fontWeight: "600" }}>
                Your values
              </h3>
              {selfModel.key("values").map((v, index) => (
                <cf-hstack gap="2" align="start">
                  <cf-vstack gap="1" style={{ flex: "1" }}>
                    <span
                      style={{ fontSize: "13px", fontWeight: "600" }}
                    >
                      {v.title}
                    </span>
                    {v.attendingTo
                      ? (
                        <span style={{ fontSize: "12px", color: "#374151" }}>
                          Attending to: {v.attendingTo}
                        </span>
                      )
                      : <span />}
                    {v.stance
                      ? (
                        <span style={{ fontSize: "12px", color: "#6b7280" }}>
                          {v.stance}
                        </span>
                      )
                      : <span />}
                  </cf-vstack>
                  <cf-button
                    size="sm"
                    variant="ghost"
                    onClick={removeValueCardByIndex({ selfModel, index })}
                  >
                    ✕
                  </cf-button>
                </cf-hstack>
              ))}
            </cf-vstack>
          </cf-vstack>
        </cf-vstack>
      ),
      selfModel,
      // Bind each handler to this instance's selfModel cell.
      recordNeurotype: recordNeurotype({ selfModel }),
      addValueCard: addValueCard({ selfModel }),
      recordResponse: recordResponse({ selfModel }),
      removeNeurotype: removeNeurotype({ selfModel }),
      removeValueCard: removeValueCard({ selfModel }),
    };
  },
);

export default Self;
