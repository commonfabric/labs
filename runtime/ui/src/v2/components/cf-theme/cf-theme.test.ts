import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  createMockCellHandle,
  pushRefusal,
  pushUpdate,
} from "../../test-utils/mock-cell-handle.ts";
import { defaultTheme, mergeWithDefaultTheme } from "../theme-context.ts";
import { subscribeToThemeCellValues, unwrapThemeCellValues } from "./index.ts";

describe("cf-theme reactive theme values", () => {
  it("unwraps top-level CellHandle values before theme merge", () => {
    const accentColor = createMockCellHandle("#3b82f6");

    expect(unwrapThemeCellValues({ accentColor })).toEqual({
      accentColor: "#3b82f6",
    });
  });

  it("unwraps nested CellHandle values in color tokens", () => {
    const primary = createMockCellHandle("#121826");
    const darkText = createMockCellHandle("#f8fafc");

    expect(
      unwrapThemeCellValues({
        colors: {
          primary,
          text: {
            light: "#111827",
            dark: darkText,
          },
        },
      }),
    ).toEqual({
      colors: {
        primary: "#121826",
        text: {
          light: "#111827",
          dark: "#f8fafc",
        },
      },
    });
  });

  it("leaves out a color the worker refuses or has not answered, so the default stands", () => {
    const primary = createMockCellHandle("#121826");
    pushRefusal(primary);
    const accent = createMockCellHandle<string>();

    const unwrapped = unwrapThemeCellValues({ colors: { primary, accent } });

    expect(unwrapped).toEqual({ colors: {} });
    const merged = mergeWithDefaultTheme(unwrapped);
    expect(merged.colors.primary).toEqual(defaultTheme.colors.primary);
    expect(merged.colors.accent).toEqual(defaultTheme.colors.accent);
  });

  it("subscribes to nested CellHandle values without firing for initial values", () => {
    const primary = createMockCellHandle("#121826");
    const theme = { colors: { primary } };
    let changeCount = 0;

    const [off] = subscribeToThemeCellValues(theme, () => {
      changeCount++;
    });

    expect(changeCount).toBe(0);

    pushUpdate(primary, "#334155");
    expect(changeCount).toBe(1);

    off();
    pushUpdate(primary, "#475569");
    expect(changeCount).toBe(1);
  });
});
