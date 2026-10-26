import { assertEquals } from "@std/assert";
import { initializeDashboardTheme } from "./theme.ts";

Deno.test("theme switch cycles through dark, light, and system", () => {
  const root = document.documentElement;
  root.dataset.theme = "dark";
  localStorage.removeItem("fabricWallTheme");
  let prefersLight = false;
  let preferenceChanged: (() => void) | undefined;
  const preference = {
    get matches() {
      return prefersLight;
    },
    addEventListener(_type: string, listener: () => void) {
      preferenceChanged = listener;
    },
  } as unknown as MediaQueryList;
  const fixture = document.createElement("div");
  fixture.innerHTML =
    "<button data-theme-toggle><span data-theme-icon></span><span data-theme-label></span></button>";
  document.body.append(fixture);
  const button = fixture.querySelector("button")!;
  let announced = "";
  let announcementCount = 0;
  const listener = (event: Event) => {
    announced = (event as CustomEvent<{ theme: string }>).detail.theme;
    announcementCount++;
  };
  addEventListener("dashboardthemechange", listener);

  try {
    initializeDashboardTheme(preference);
    assertEquals(button.ariaLabel, "Theme: Dark. Switch to light mode");
    assertEquals(button.textContent, "☾Dark");

    button.click();
    assertEquals(root.dataset.theme, "light");
    assertEquals(localStorage.getItem("fabricWallTheme"), "light");
    assertEquals(button.ariaLabel, "Theme: Light. Switch to system mode");
    assertEquals(button.textContent, "☀Light");
    assertEquals(announced, "light");

    button.click();
    assertEquals(root.dataset.theme, "dark");
    assertEquals(localStorage.getItem("fabricWallTheme"), "system");
    assertEquals(button.ariaLabel, "Theme: System. Switch to dark mode");
    assertEquals(button.textContent, "◐System");
    assertEquals(announced, "dark");

    prefersLight = true;
    preferenceChanged!();
    assertEquals(root.dataset.theme, "light");
    assertEquals(announced, "light");

    button.click();
    assertEquals(root.dataset.theme, "dark");
    assertEquals(localStorage.getItem("fabricWallTheme"), "dark");
    assertEquals(button.ariaLabel, "Theme: Dark. Switch to light mode");
    assertEquals(button.textContent, "☾Dark");
    assertEquals(announced, "dark");

    const explicitDarkAnnouncementCount = announcementCount;
    prefersLight = false;
    preferenceChanged!();
    assertEquals(root.dataset.theme, "dark");
    assertEquals(announced, "dark");
    assertEquals(announcementCount, explicitDarkAnnouncementCount);
  } finally {
    removeEventListener("dashboardthemechange", listener);
    fixture.remove();
    delete root.dataset.theme;
    localStorage.removeItem("fabricWallTheme");
  }
});
