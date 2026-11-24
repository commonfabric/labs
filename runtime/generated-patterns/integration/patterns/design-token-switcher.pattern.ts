import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface TokenDefinition {
  background: string;
  foreground: string;
  accent: string;
}

type TokenCatalog = Record<string, TokenDefinition>;

const DEFAULT_TOKEN_CATALOG: TokenCatalog = {
  light: {
    background: "#ffffff",
    foreground: "#161616",
    accent: "#2f80ed",
  },
  midnight: {
    background: "#0b1220",
    foreground: "#f5f7fb",
    accent: "#5b8def",
  },
  contrast: {
    background: "#000000",
    foreground: "#ffdd00",
    accent: "#ff6f61",
  },
};

interface DesignTokenSwitcherArgs {
  tokens: Default<TokenCatalog, typeof DEFAULT_TOKEN_CATALOG>;
  activeToken: Default<string, "light">;
}

const sanitizeTokenName = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const sanitizeColor = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeDefinition = (
  value: unknown,
  fallback: TokenDefinition,
): TokenDefinition => {
  if (!value || typeof value !== "object") {
    return { ...fallback };
  }
  const record = value as Record<string, unknown>;
  return {
    background: sanitizeColor(record.background, fallback.background),
    foreground: sanitizeColor(record.foreground, fallback.foreground),
    accent: sanitizeColor(record.accent, fallback.accent),
  };
};

const sanitizeCatalog = (value: unknown): TokenCatalog => {
  const base: TokenCatalog = { ...DEFAULT_TOKEN_CATALOG };
  if (!value || typeof value !== "object") {
    return base;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const definition = record[key];
    const fallback = base[key] ?? DEFAULT_TOKEN_CATALOG.light;
    base[key] = sanitizeDefinition(definition, fallback);
  }
  return base;
};

const findNextName = (current: string, names: string[]): string => {
  if (names.length === 0) return current;
  const index = names.indexOf(current);
  if (index === -1) return names[0];
  return names[(index + 1) % names.length];
};

const switchDesignToken = handler(
  (
    event: { token?: string } | undefined,
    context: {
      active: Cell<string>;
      tokens: Cell<TokenCatalog>;
      history: Cell<string[]>;
    },
  ) => {
    const catalog = sanitizeCatalog(context.tokens.get());
    const names = Object.keys(catalog).sort((a, b) => a.localeCompare(b));
    const fallback = names[0] ?? "light";
    const current = sanitizeTokenName(context.active.get()) ?? fallback;
    const requested = sanitizeTokenName(event?.token);
    const next = requested && names.includes(requested)
      ? requested
      : findNextName(current, names);
    context.active.set(next);
    const history = Array.isArray(context.history.get())
      ? context.history.get()
      : [];
    context.history.set([...history, next]);
  },
);

const liftSanitizeCatalog = lift((value: TokenCatalog | undefined) =>
  sanitizeCatalog(value)
);

const liftTokenNames = lift((catalog: TokenCatalog) =>
  Object.keys(catalog).sort((a, b) => a.localeCompare(b))
);

const liftCurrentToken = lift((input: {
  candidate?: string;
  names: string[];
}) => {
  const names = input.names;
  if (names.length === 0) return "light";
  const sanitized = sanitizeTokenName(input.candidate);
  return sanitized && names.includes(sanitized) ? sanitized : names[0];
});

const liftCurrentDefinition = lift((input: {
  name: string;
  catalog: TokenCatalog;
}) =>
  input.catalog[input.name] ??
    sanitizeDefinition(undefined, DEFAULT_TOKEN_CATALOG.light)
);

const liftBackgroundColor = lift((definition: TokenDefinition) =>
  definition.background
);

const liftForegroundColor = lift((definition: TokenDefinition) =>
  definition.foreground
);

const liftAccentColor = lift((definition: TokenDefinition) =>
  definition.accent
);

const liftColorSummary = lift((definition: TokenDefinition) =>
  `${definition.background}/${definition.foreground}/${definition.accent}`
);

const liftPreview = lift((definition: TokenDefinition) => ({
  background: definition.background,
  foreground: definition.foreground,
  accent: definition.accent,
  summary: `bg ${definition.background} fg ${definition.foreground}`,
}));

const liftHistoryView = lift((value: string[] | undefined) =>
  Array.isArray(value) ? value : []
);

const liftLastApplied = lift((value: string[]) => {
  if (value.length === 0) return "none";
  return value[value.length - 1];
});

export const designTokenSwitcher = pattern<DesignTokenSwitcherArgs>(
  ({ tokens, activeToken }) => {
    const appliedHistory = cell<string[]>([]);

    const sanitizedCatalog = liftSanitizeCatalog(tokens);

    const tokenNames = liftTokenNames(sanitizedCatalog);

    const currentToken = liftCurrentToken({
      candidate: activeToken,
      names: tokenNames,
    });

    const currentDefinition = liftCurrentDefinition({
      name: currentToken,
      catalog: sanitizedCatalog,
    });

    const backgroundColor = liftBackgroundColor(currentDefinition);

    const foregroundColor = liftForegroundColor(currentDefinition);

    const accentColor = liftAccentColor(currentDefinition);

    const colorSummary = liftColorSummary(currentDefinition);

    const preview = liftPreview(currentDefinition);

    const historyView = liftHistoryView(appliedHistory);

    const lastApplied = liftLastApplied(historyView);

    return {
      tokens: sanitizedCatalog,
      tokenNames,
      activeToken: currentToken,
      backgroundColor,
      foregroundColor,
      accentColor,
      preview,
      history: historyView,
      lastApplied,
      colorSummary,
      label: str`Active token ${currentToken} renders ${colorSummary}`,
      switchToken: switchDesignToken({
        active: activeToken,
        tokens,
        history: appliedHistory,
      }),
    };
  },
);

export default designTokenSwitcher;
