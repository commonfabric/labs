import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface VariantInput {
  mode?: string;
  src?: string;
  alt?: string;
}

interface VariantDetails {
  mode: string;
  src: string;
  alt: string;
}

type VariantMap = Record<string, VariantDetails>;

const DEFAULT_MODES: string[] = ["mobile", "tablet", "desktop"];

const sanitizeMode = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
};

const defaultVariantForMode = (mode: string): VariantDetails => ({
  mode,
  src: `${mode}-placeholder.png`,
  alt: `Image for ${mode}`,
});

const sanitizeModes = (value: unknown): string[] => {
  const fallback = [...DEFAULT_MODES].sort((a, b) => a.localeCompare(b));
  if (!Array.isArray(value)) return fallback;
  const collected = new Set<string>();
  for (const entry of value) {
    const mode = sanitizeMode(entry);
    if (mode) collected.add(mode);
  }
  const result = [...collected].sort((a, b) => a.localeCompare(b));
  return result.length > 0 ? result : fallback;
};

const sanitizeSource = (
  value: unknown,
  fallback: string,
  mode: string,
): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback.length > 0 ? fallback : defaultVariantForMode(mode).src;
};

const sanitizeAlt = (
  value: unknown,
  fallback: string,
  mode: string,
): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback.length > 0 ? fallback : defaultVariantForMode(mode).alt;
};

const sanitizeVariants = (
  entries: unknown,
  modeList: string[],
): VariantMap => {
  const base: VariantMap = {};
  for (const mode of modeList) {
    base[mode] = { ...defaultVariantForMode(mode) };
  }
  if (!Array.isArray(entries)) return base;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as VariantInput;
    const mode = sanitizeMode(record.mode);
    if (!mode || !modeList.includes(mode)) continue;
    const fallback = base[mode];
    const src = sanitizeSource(record.src, fallback.src, mode);
    const alt = sanitizeAlt(record.alt, fallback.alt, mode);
    base[mode] = { mode, src, alt };
  }
  return base;
};

interface ImageGalleryVariantArgs {
  modes: Default<string[], typeof DEFAULT_MODES>;
  variants: Default<VariantInput[], []>;
  activeMode: Default<string, "desktop">;
}

const selectDeviceMode = handler(
  (
    event: { mode?: string } | undefined,
    context: {
      activeMode: Cell<string>;
      modes: Cell<unknown>;
      history: Cell<string[]>;
    },
  ) => {
    const modes = sanitizeModes(context.modes.get());
    if (modes.length === 0) return;
    const requested = sanitizeMode(event?.mode);
    const next = requested && modes.includes(requested) ? requested : modes[0];
    context.activeMode.set(next);
    const currentHistory = Array.isArray(context.history.get())
      ? context.history.get()
      : [];
    context.history.set([...currentHistory, next]);
  },
);

const updateDeviceVariant = handler(
  (
    event: { mode?: string; src?: string; alt?: string } | undefined,
    context: {
      variants: Cell<VariantInput[]>;
      modes: Cell<unknown>;
    },
  ) => {
    const modes = sanitizeModes(context.modes.get());
    if (modes.length === 0) return;
    const mode = sanitizeMode(event?.mode) ?? modes[0];
    if (!modes.includes(mode)) return;
    const existing = Array.isArray(context.variants.get())
      ? context.variants.get()
      : [];
    const sanitized = sanitizeVariants(existing, modes);
    const current = sanitized[mode] ?? defaultVariantForMode(mode);
    const src = sanitizeSource(event?.src, current.src, mode);
    const alt = sanitizeAlt(event?.alt, current.alt, mode);
    sanitized[mode] = { mode, src, alt };
    const nextList = modes.map((entry) => ({ ...sanitized[entry] }));
    context.variants.set(nextList);
  },
);

// Module-scope lift definitions
const liftSanitizeModes = lift((value: string[] | undefined) =>
  sanitizeModes(value)
);

const liftSanitizeVariants = lift((input: {
  entries: VariantInput[] | undefined;
  modeList: string[];
}) => sanitizeVariants(input.entries, input.modeList));

const liftAvailableVariants = lift((input: {
  variants: VariantMap;
  modes: string[];
}) => input.modes.map((mode) => ({ ...input.variants[mode] })));

const liftSelectedMode = lift((input: {
  candidate: string | undefined;
  modes: string[];
}) => {
  const list = input.modes;
  if (list.length === 0) return "desktop";
  const mode = sanitizeMode(input.candidate);
  return mode && list.includes(mode) ? mode : list[0];
});

const liftCurrentVariant = lift((input: {
  variants: VariantMap;
  mode: string;
  modes: string[];
}) => {
  const list = input.modes;
  if (list.length === 0) return defaultVariantForMode("desktop");
  const target = input.variants[input.mode];
  if (target) return { ...target };
  const fallback = list[0];
  return { ...input.variants[fallback] };
});

const liftCurrentSource = lift((variant: VariantDetails) => variant.src);
const liftCurrentAlt = lift((variant: VariantDetails) => variant.alt);

const liftVariantSummary = lift((variant: VariantDetails) =>
  `${variant.mode}:${variant.src}`
);

const liftHistoryView = lift((value: string[] | undefined) =>
  Array.isArray(value) ? value : []
);

export const imageGalleryVariant = pattern<ImageGalleryVariantArgs>(
  ({ modes, variants, activeMode }) => {
    const selectionHistory = cell<string[]>([]);

    const sanitizedModes = liftSanitizeModes(modes);

    const sanitizedVariants = liftSanitizeVariants({
      entries: variants,
      modeList: sanitizedModes,
    });

    const availableVariants = liftAvailableVariants({
      variants: sanitizedVariants,
      modes: sanitizedModes,
    });

    const selectedMode = liftSelectedMode({
      candidate: activeMode,
      modes: sanitizedModes,
    });

    const currentVariant = liftCurrentVariant({
      variants: sanitizedVariants,
      mode: selectedMode,
      modes: sanitizedModes,
    });

    const currentSource = liftCurrentSource(currentVariant);
    const currentAlt = liftCurrentAlt(currentVariant);

    const variantSummary = liftVariantSummary(currentVariant);

    const historyView = liftHistoryView(selectionHistory);

    return {
      availableModes: sanitizedModes,
      variantMap: sanitizedVariants,
      variantList: availableVariants,
      activeMode: selectedMode,
      currentVariant,
      currentSource,
      currentAlt,
      variantSummary,
      label: str`Mode ${selectedMode} uses ${currentSource}`,
      history: historyView,
      selectMode: selectDeviceMode({
        activeMode,
        modes,
        history: selectionHistory,
      }),
      updateVariant: updateDeviceVariant({ variants, modes }),
    };
  },
);

export default imageGalleryVariant;
