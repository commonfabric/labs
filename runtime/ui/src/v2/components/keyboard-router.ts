export type ShortcutSpec = {
  name?: string;
  code?: string;
  key?: string;
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  ignoreEditable?: boolean;
  allowRepeat?: boolean;
  preventDefault?: boolean;
  stopPropagation?: boolean;
  when?: () => boolean;
  priority?: number;
};

export type ShortcutHandler = (e: KeyboardEvent) => void;

/**
 * Minimal interface expected by components to register shortcuts.
 * Implementations are provided by the application (e.g., the Shell).
 */
export interface KeyboardRouter {
  register(spec: ShortcutSpec, handler: ShortcutHandler): () => void;
  dispose(): void;
}
