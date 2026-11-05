import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  DASHBOARD_MESSAGE_LIFETIME_MS,
  DASHBOARD_MESSAGE_VISIBLE_MS,
  dashboardMessageOpacity,
  DashboardMessageStore,
  normalizeDashboardMessageText,
} from "../dashboard-message.ts";

describe("dashboard-message", () => {
  const directories: string[] = [];

  afterEach(async () => {
    for (const directory of directories.splice(0)) {
      await Deno.remove(directory, { recursive: true });
    }
  });

  describe("dashboardMessageOpacity()", () => {
    it("returns full opacity through the first two hours", () => {
      expect(dashboardMessageOpacity(1_000, 1_000)).toBe(1);
      expect(
        dashboardMessageOpacity(
          1_000,
          1_000 + DASHBOARD_MESSAGE_VISIBLE_MS,
        ),
      ).toBe(1);
    });

    it("returns half opacity halfway through the four-hour fade", () => {
      expect(
        dashboardMessageOpacity(
          1_000,
          1_000 + DASHBOARD_MESSAGE_VISIBLE_MS + 2 * 60 * 60 * 1_000,
        ),
      ).toBe(0.5);
    });

    it("returns zero opacity after the six-hour lifetime", () => {
      expect(
        dashboardMessageOpacity(
          1_000,
          1_000 + DASHBOARD_MESSAGE_LIFETIME_MS,
        ),
      ).toBe(0);
    });
  });

  describe("normalizeDashboardMessageText()", () => {
    it("returns trimmed single-line text", () => {
      expect(normalizeDashboardMessageText("  hello\n  dashboard  ")).toBe(
        "hello dashboard",
      );
    });

    it("rejects text longer than the editor limit", () => {
      expect(() => normalizeDashboardMessageText("x".repeat(501))).toThrow(
        "Dashboard messages are limited to 500 characters.",
      );
    });
  });

  describe("DashboardMessageStore", () => {
    it("reloads the saved message from the dashboard cache", async () => {
      const directory = await Deno.makeTempDir({
        prefix: "dashboard-message-",
      });
      directories.push(directory);
      const file = `${directory}/message.json`;
      const now = 12_345;
      const first = new DashboardMessageStore({ file, now: () => now });

      expect(await first.set("Team lunch at noon")).toEqual({
        text: "Team lunch at noon",
        updatedAt: now,
        revision: 1,
      });

      const reloaded = new DashboardMessageStore({ file, now: () => now });
      expect((await reloaded.refresh()).message).toEqual({
        text: "Team lunch at noon",
        updatedAt: now,
        revision: 1,
      });
    });

    it("loads a version-one message written before revisions were added", async () => {
      const directory = await Deno.makeTempDir({
        prefix: "dashboard-message-",
      });
      directories.push(directory);
      const file = `${directory}/message.json`;
      await Deno.writeTextFile(
        file,
        JSON.stringify({
          version: 1,
          text: "Existing announcement",
          updatedAt: 12_345,
        }),
      );

      const store = new DashboardMessageStore({ file, now: () => 12_345 });
      expect((await store.refresh()).message).toEqual({
        text: "Existing announcement",
        updatedAt: 12_345,
        revision: 0,
      });
    });

    it("replaces expired text with the persisted empty string", async () => {
      const directory = await Deno.makeTempDir({
        prefix: "dashboard-message-",
      });
      directories.push(directory);
      const file = `${directory}/message.json`;
      let now = 12_345;
      const store = new DashboardMessageStore({ file, now: () => now });
      await store.set("Deploying");

      now += DASHBOARD_MESSAGE_LIFETIME_MS;
      expect(await store.refresh()).toEqual({
        message: { text: "", updatedAt: null, revision: 2 },
        expired: true,
      });
      expect(JSON.parse(await Deno.readTextFile(file))).toEqual({
        version: 1,
        text: "",
        updatedAt: null,
        revision: 2,
      });
    });

    it("keeps the prior message when persistence fails", async () => {
      const store = new DashboardMessageStore({
        file: "/missing/dashboard-message.json",
      });

      await expect(store.set("Not persisted")).rejects.toThrow(
        "Could not save the dashboard message",
      );
      expect((await store.refresh()).message).toEqual({
        text: "",
        updatedAt: null,
        revision: 0,
      });
    });

    it("retries a failed cache read before saving", async () => {
      let reads = 0;
      const writes: string[] = [];
      const store = new DashboardMessageStore({
        file: "/dashboard-message.json",
        now: () => 12_345,
        readTextFile: (() => {
          reads++;
          if (reads === 1) throw new Deno.errors.PermissionDenied("denied");
          return Promise.resolve(JSON.stringify({
            version: 1,
            text: "Stored message",
            updatedAt: 10_000,
            revision: 4,
          }));
        }) as typeof Deno.readTextFile,
        writeTextFile: ((_file: string | URL, data: string) => {
          writes.push(data);
          return Promise.resolve();
        }) as typeof Deno.writeTextFile,
        rename: (() => Promise.resolve()) as typeof Deno.rename,
      });

      await expect(store.refresh()).rejects.toThrow(
        "Could not load the dashboard message: denied",
      );
      expect(await store.set("Replacement")).toEqual({
        text: "Replacement",
        updatedAt: 12_345,
        revision: 5,
      });
      expect(reads).toBe(2);
      expect(JSON.parse(writes[0])).toEqual({
        version: 1,
        text: "Replacement",
        updatedAt: 12_345,
        revision: 5,
      });
    });

    it("retries invalid stored data instead of overwriting it", async () => {
      let reads = 0;
      const writes: string[] = [];
      const store = new DashboardMessageStore({
        file: "/dashboard-message.json",
        now: () => 12_345,
        readTextFile: (() => Promise.resolve([
          "null",
          JSON.stringify({ version: 2, text: "Unknown format" }),
          JSON.stringify({
            version: 1,
            text: "Stored message",
            updatedAt: 10_000,
            revision: 8,
          }),
        ][reads++])) as typeof Deno.readTextFile,
        writeTextFile: ((_file: string | URL, data: string) => {
          writes.push(data);
          return Promise.resolve();
        }) as typeof Deno.writeTextFile,
        rename: (() => Promise.resolve()) as typeof Deno.rename,
      });

      await expect(store.set("Replacement")).rejects.toThrow(
        "Could not load the dashboard message: invalid stored data",
      );
      await expect(store.set("Replacement")).rejects.toThrow(
        "Could not load the dashboard message: invalid stored data",
      );
      expect(writes).toEqual([]);
      expect(await store.set("Replacement")).toEqual({
        text: "Replacement",
        updatedAt: 12_345,
        revision: 9,
      });
      expect(reads).toBe(3);
    });

    it("keeps an expired message when clearing it cannot be saved", async () => {
      let now = 12_345;
      let failWrites = false;
      const store = new DashboardMessageStore({
        file: "/dashboard-message.json",
        now: () => now,
        readTextFile: (() => Promise.reject(new Deno.errors.NotFound())) as
          typeof Deno.readTextFile,
        writeTextFile: (() => failWrites
          ? Promise.reject(new Deno.errors.PermissionDenied("denied"))
          : Promise.resolve()) as typeof Deno.writeTextFile,
        rename: (() => Promise.resolve()) as typeof Deno.rename,
      });
      await store.set("Still stored");
      now += DASHBOARD_MESSAGE_LIFETIME_MS;
      failWrites = true;

      await expect(store.refresh()).rejects.toThrow(
        "Could not save the dashboard message: denied",
      );
      failWrites = false;
      expect(await store.refresh()).toEqual({
        message: { text: "", updatedAt: null, revision: 2 },
        expired: true,
      });
    });
  });
});
