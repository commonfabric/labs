import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import {
  isObjectNotArray,
  type ReadonlyRecord,
} from "@commonfabric/utils/types";

export type PromptSlotRole = "direct-command" | "context" | "quote";

export const CFC_PROMPT_SLOT_BOUND_ATOM_TYPE = CFC_ATOM_TYPE.PromptSlotBound;

export type PromptSlotReference = string | Record<string, unknown>;

export interface PromptSlotRenderRef {
  seq: number;
  rootRef: PromptSlotReference;
}

export interface PromptSlotBinding {
  type: typeof CFC_PROMPT_SLOT_BOUND_ATOM_TYPE;
  source: PromptSlotReference;
  role: PromptSlotRole;
  kernelName: string;
  surface: string;
  subject?: string;
  renderRef?: PromptSlotRenderRef;
  eventId?: string;
  valueDigest?: string;
  slotDigest?: string;
  snapshotDigest?: string;
  targetPath?: string;
}

export interface CreateCliPromptSlotBindingOptions {
  kernelName: string;
  source?: PromptSlotReference;
  role?: PromptSlotRole;
  surface?: string;
  subject?: string;
  renderRef?: PromptSlotRenderRef;
  eventId?: string;
  valueDigest?: string;
  slotDigest?: string;
  snapshotDigest?: string;
  targetPath?: string;
}

const PROMPT_SLOT_ROLES: readonly PromptSlotRole[] = [
  "direct-command",
  "context",
  "quote",
];

const isPromptSlotRole = (input: unknown): input is PromptSlotRole =>
  typeof input === "string" &&
  PROMPT_SLOT_ROLES.includes(input as PromptSlotRole);

const isNonEmptyString = (input: unknown): input is string =>
  typeof input === "string" && input.trim() !== "";

const isPromptSlotReference = (
  input: unknown,
): input is PromptSlotReference =>
  isNonEmptyString(input) ||
  (isObjectNotArray(input) && Object.keys(input).length > 0);

const optionalString = (
  input: ReadonlyRecord,
  field: keyof PromptSlotBinding,
): string | undefined => {
  const value = input[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`prompt slot ${String(field)} must be a string`);
  }
  return value;
};

const normalizePromptSlotRenderRef = (
  input: unknown,
): PromptSlotRenderRef | undefined => {
  if (input === undefined) {
    return undefined;
  }
  if (!isObjectNotArray(input)) {
    throw new Error("prompt slot renderRef must be an object");
  }
  if (typeof input.seq !== "number" || !Number.isSafeInteger(input.seq)) {
    throw new Error("prompt slot renderRef.seq must be a safe integer");
  }
  if (!isPromptSlotReference(input.rootRef)) {
    throw new Error("prompt slot renderRef.rootRef must be a reference");
  }
  return {
    seq: input.seq,
    rootRef: input.rootRef,
  };
};

export const normalizePromptSlotBinding = (
  input: unknown,
): PromptSlotBinding => {
  if (!isObjectNotArray(input)) {
    throw new Error("prompt slot binding must be a JSON object");
  }
  if (input.type !== CFC_PROMPT_SLOT_BOUND_ATOM_TYPE) {
    throw new Error(
      `unsupported prompt slot binding type: ${String(input.type)}`,
    );
  }
  if (!isPromptSlotReference(input.source)) {
    throw new Error("prompt slot source must be a reference");
  }
  if (!isPromptSlotRole(input.role)) {
    throw new Error(
      "prompt slot role must be one of direct-command, context, quote",
    );
  }
  if (!isNonEmptyString(input.kernelName)) {
    throw new Error("prompt slot kernelName must be a non-empty string");
  }
  if (!isNonEmptyString(input.surface)) {
    throw new Error("prompt slot surface must be a non-empty string");
  }

  const renderRef = normalizePromptSlotRenderRef(input.renderRef);
  const subject = optionalString(input, "subject");
  const eventId = optionalString(input, "eventId");
  const valueDigest = optionalString(input, "valueDigest");
  const slotDigest = optionalString(input, "slotDigest");
  const snapshotDigest = optionalString(input, "snapshotDigest");
  const targetPath = optionalString(input, "targetPath");
  return {
    type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
    source: input.source,
    role: input.role,
    kernelName: input.kernelName,
    surface: input.surface,
    ...(subject !== undefined ? { subject } : {}),
    ...(renderRef !== undefined ? { renderRef } : {}),
    ...(eventId !== undefined ? { eventId } : {}),
    ...(valueDigest !== undefined ? { valueDigest } : {}),
    ...(slotDigest !== undefined ? { slotDigest } : {}),
    ...(snapshotDigest !== undefined ? { snapshotDigest } : {}),
    ...(targetPath !== undefined ? { targetPath } : {}),
  };
};

const defaultCliPromptSource = (
  options: Pick<CreateCliPromptSlotBindingOptions, "subject" | "surface">,
): PromptSlotReference => ({
  type: "cf-harness.cli-input",
  surface: options.surface ?? "cli",
  ...(options.subject !== undefined ? { subject: options.subject } : {}),
});

export const createCliPromptSlotBinding = (
  options: CreateCliPromptSlotBindingOptions,
): PromptSlotBinding => ({
  type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  source: options.source ?? defaultCliPromptSource(options),
  role: options.role ?? "direct-command",
  kernelName: options.kernelName,
  surface: options.surface ?? "cli",
  ...(options.subject !== undefined ? { subject: options.subject } : {}),
  ...(options.renderRef !== undefined ? { renderRef: options.renderRef } : {}),
  ...(options.eventId !== undefined ? { eventId: options.eventId } : {}),
  ...(options.valueDigest !== undefined
    ? { valueDigest: options.valueDigest }
    : {}),
  ...(options.slotDigest !== undefined
    ? { slotDigest: options.slotDigest }
    : {}),
  ...(options.snapshotDigest !== undefined
    ? { snapshotDigest: options.snapshotDigest }
    : {}),
  ...(options.targetPath !== undefined
    ? { targetPath: options.targetPath }
    : {}),
});
