import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const menuPlannerScenario: PatternIntegrationScenario<
  { days?: string[]; recipes?: unknown; plan?: unknown }
> = {
  name: "menu planner aggregates shopping list",
  module: new URL("./menu-planner.pattern.ts", import.meta.url),
  exportName: "menuPlanner",
  steps: [
    {
      expect: [
        {
          path: "planByDay",
          value: {
            Monday: { breakfast: "", lunch: "", dinner: "" },
            Tuesday: { breakfast: "", lunch: "", dinner: "" },
            Wednesday: { breakfast: "", lunch: "", dinner: "" },
            Thursday: { breakfast: "", lunch: "", dinner: "" },
            Friday: { breakfast: "", lunch: "", dinner: "" },
          },
        },
        { path: "shoppingList", value: [] },
        { path: "plannedCount", value: 0 },
        { path: "status", value: "0 meals scheduled" },
        { path: "lastAction", value: "initialized" },
      ],
    },
    {
      events: [
        {
          stream: "assignMeal",
          payload: {
            day: "Monday",
            meal: "breakfast",
            pattern: "Oatmeal Bowl",
          },
        },
      ],
      expect: [
        {
          path: "planByDay.Monday.breakfast",
          value: "Oatmeal Bowl",
        },
        {
          path: "shoppingList",
          value: [
            { name: "Berries", unit: "cup", quantity: 0.5 },
            { name: "Milk", unit: "cup", quantity: 1 },
            { name: "Rolled Oats", unit: "cup", quantity: 1 },
          ],
        },
        { path: "plannedCount", value: 1 },
        {
          path: "status",
          value: "1 meals scheduled",
        },
        {
          path: "lastAction",
          value: "Assigned Oatmeal Bowl to Monday breakfast",
        },
      ],
    },
    {
      events: [
        {
          stream: "assignMeal",
          payload: { day: "Monday", meal: "dinner", pattern: "Veggie Curry" },
        },
      ],
      expect: [
        {
          path: "planByDay.Monday.dinner",
          value: "Veggie Curry",
        },
        {
          path: "shoppingList",
          value: [
            { name: "Berries", unit: "cup", quantity: 0.5 },
            { name: "Chickpeas", unit: "can", quantity: 1 },
            { name: "Curry Paste", unit: "tbsp", quantity: 2 },
            { name: "Milk", unit: "cup", quantity: 1 },
            { name: "Rolled Oats", unit: "cup", quantity: 1 },
            { name: "Spinach", unit: "cup", quantity: 2 },
          ],
        },
        { path: "plannedCount", value: 2 },
        {
          path: "lastAction",
          value: "Assigned Veggie Curry to Monday dinner",
        },
      ],
    },
    {
      events: [
        {
          stream: "assignMeal",
          payload: { day: "Tuesday", meal: "lunch", pattern: "Quinoa Salad" },
        },
      ],
      expect: [
        {
          path: "planByDay.Tuesday.lunch",
          value: "Quinoa Salad",
        },
        {
          path: "shoppingList",
          value: [
            { name: "Berries", unit: "cup", quantity: 0.5 },
            { name: "Cherry Tomato", unit: "cup", quantity: 1 },
            { name: "Chickpeas", unit: "can", quantity: 1 },
            { name: "Curry Paste", unit: "tbsp", quantity: 2 },
            { name: "Milk", unit: "cup", quantity: 1 },
            { name: "Olive Oil", unit: "tbsp", quantity: 2 },
            { name: "Quinoa", unit: "cup", quantity: 1 },
            { name: "Rolled Oats", unit: "cup", quantity: 1 },
            { name: "Spinach", unit: "cup", quantity: 2 },
          ],
        },
        { path: "plannedCount", value: 3 },
        {
          path: "lastAction",
          value: "Assigned Quinoa Salad to Tuesday lunch",
        },
      ],
    },
    {
      events: [
        {
          stream: "assignMeal",
          payload: { day: "Monday", meal: "dinner", pattern: "Quinoa Salad" },
        },
      ],
      expect: [
        {
          path: "planByDay.Monday.dinner",
          value: "Quinoa Salad",
        },
        {
          path: "shoppingList",
          value: [
            { name: "Berries", unit: "cup", quantity: 0.5 },
            { name: "Cherry Tomato", unit: "cup", quantity: 2 },
            { name: "Milk", unit: "cup", quantity: 1 },
            { name: "Olive Oil", unit: "tbsp", quantity: 4 },
            { name: "Quinoa", unit: "cup", quantity: 2 },
            { name: "Rolled Oats", unit: "cup", quantity: 1 },
          ],
        },
        { path: "plannedCount", value: 3 },
        {
          path: "lastAction",
          value: "Assigned Quinoa Salad to Monday dinner",
        },
      ],
    },
    {
      events: [
        {
          stream: "clearMeal",
          payload: { day: "Tuesday", meal: "lunch" },
        },
      ],
      expect: [
        {
          path: "planByDay.Tuesday.lunch",
          value: "",
        },
        {
          path: "shoppingList",
          value: [
            { name: "Berries", unit: "cup", quantity: 0.5 },
            { name: "Cherry Tomato", unit: "cup", quantity: 1 },
            { name: "Milk", unit: "cup", quantity: 1 },
            { name: "Olive Oil", unit: "tbsp", quantity: 2 },
            { name: "Quinoa", unit: "cup", quantity: 1 },
            { name: "Rolled Oats", unit: "cup", quantity: 1 },
          ],
        },
        { path: "plannedCount", value: 2 },
        {
          path: "lastAction",
          value: "Cleared Tuesday lunch",
        },
      ],
    },
  ],
};

export const scenarios = [menuPlannerScenario];

describe("menu-planner", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
