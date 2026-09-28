import type { FabricInstance } from "@/interface.ts";
import type { LiveEnvironment } from "./interface.ts";

/**
 * Abstract base for `LiveEnvironment` implementations, and the class to build
 * one on. Subclasses implement `getCell()` for their own boundary semantics.
 */
export abstract class BaseLiveEnvironment implements LiveEnvironment {
  //
  // Subclass contract
  //

  /** Resolves a cell reference. Subclass-specific. */
  abstract getCell(
    ref: { id: string; path: string[]; space: string },
  ): FabricInstance;
}
