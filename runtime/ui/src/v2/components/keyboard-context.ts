import { createContext } from "@lit/context";
import type { KeyboardRouter } from "./keyboard-router.ts";

export const keyboardRouterContext = createContext<KeyboardRouter>(
  Symbol("cf.keyboard-router"),
);
