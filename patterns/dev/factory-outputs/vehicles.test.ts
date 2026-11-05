/**
 * Unit tests for vehicles.ts helpers.
 * Plain Deno.test — NOT a pattern.
 */
import { assertEquals } from "@std/assert";
import {
  formatVehicle,
  modelsForMake,
  normalizePlateId,
  normalizeVehicle,
  normalizeVehicles,
  type Vehicle,
} from "./vehicles.ts";

//
// normalizePlateId
//

Deno.test("normalizePlateId: uppercases and strips non-alphanumerics", () => {
  assertEquals(normalizePlateId("7abc-123!"), "7ABC123");
});

Deno.test("normalizePlateId: already clean plate unchanged", () => {
  assertEquals(normalizePlateId("ABC123"), "ABC123");
});

Deno.test("normalizePlateId: all special chars → empty string", () => {
  assertEquals(normalizePlateId("---"), "");
});

Deno.test("normalizePlateId: empty string → empty string", () => {
  assertEquals(normalizePlateId(""), "");
});

//
// modelsForMake
//

Deno.test("modelsForMake: returns models for a known make", () => {
  const models = modelsForMake("Honda");
  assertEquals(models.includes("Civic"), true);
  assertEquals(models.includes("Accord"), true);
});

Deno.test("modelsForMake: returns empty array for unknown make", () => {
  assertEquals(modelsForMake("FakeMake"), []);
});

Deno.test("modelsForMake: returns empty array for empty string", () => {
  assertEquals(modelsForMake(""), []);
});

//
// formatVehicle
//

Deno.test("formatVehicle: full vehicle", () => {
  const v: Vehicle = {
    plateId: "ABC123",
    plateState: "CA",
    color: "Red",
    make: "Honda",
    model: "Civic",
  };
  assertEquals(formatVehicle(v), "Red Honda Civic — ABC123 (CA)");
});

Deno.test("formatVehicle: plate only (no descriptor)", () => {
  const v: Vehicle = {
    plateId: "XYZ",
    plateState: "NY",
    color: "",
    make: "",
    model: "",
  };
  assertEquals(formatVehicle(v), "XYZ (NY)");
});

Deno.test("formatVehicle: no plateState", () => {
  const v: Vehicle = {
    plateId: "XYZ",
    plateState: "",
    color: "",
    make: "",
    model: "",
  };
  assertEquals(formatVehicle(v), "XYZ");
});

//
// normalizeVehicle
//

Deno.test("normalizeVehicle: normalizes plate and defaults state", () => {
  const result = normalizeVehicle({
    plateId: "7abc-123!",
    plateState: "",
    color: "",
    make: "",
    model: "",
  });
  assertEquals(result.plateId, "7ABC123");
  assertEquals(result.plateState, "CA");
});

Deno.test("normalizeVehicle: uppercases provided state", () => {
  const result = normalizeVehicle({
    plateId: "X1",
    plateState: "wa",
    color: "",
    make: "",
    model: "",
  });
  assertEquals(result.plateState, "WA");
});

Deno.test("normalizeVehicle: invalid state falls back to CA", () => {
  // Junk codes ("XX", "ZZ", whitespace) would otherwise pollute downstream
  // classification matches keyed on (plateId, plateState).
  const xx = normalizeVehicle({
    plateId: "P1",
    plateState: "XX",
    color: "",
    make: "",
    model: "",
  });
  assertEquals(xx.plateState, "CA");

  const blanks = normalizeVehicle({
    plateId: "P2",
    plateState: "   ",
    color: "",
    make: "",
    model: "",
  });
  assertEquals(blanks.plateState, "CA");
});

Deno.test("normalizeVehicle: valid make kept, invalid make dropped", () => {
  const valid = normalizeVehicle({
    plateId: "P1",
    plateState: "CA",
    color: "",
    make: "Honda",
    model: "",
  });
  assertEquals(valid.make, "Honda");

  const invalid = normalizeVehicle({
    plateId: "P2",
    plateState: "CA",
    color: "",
    make: "FakeMake",
    model: "",
  });
  assertEquals(invalid.make, "");
});

Deno.test("normalizeVehicle: model dropped when make is invalid (cascade)", () => {
  const result = normalizeVehicle({
    plateId: "P1",
    plateState: "CA",
    color: "",
    make: "FakeMake",
    model: "Civic",
  });
  assertEquals(result.make, "");
  assertEquals(result.model, "");
});

Deno.test("normalizeVehicle: model dropped when not in make's list (stale cascade)", () => {
  // Honda does not have Camry
  const result = normalizeVehicle({
    plateId: "P1",
    plateState: "CA",
    color: "",
    make: "Honda",
    model: "Camry",
  });
  assertEquals(result.make, "Honda");
  assertEquals(result.model, "");
});

Deno.test("normalizeVehicle: model kept when valid make+model combo", () => {
  const result = normalizeVehicle({
    plateId: "P1",
    plateState: "CA",
    color: "",
    make: "Honda",
    model: "Civic",
  });
  assertEquals(result.make, "Honda");
  assertEquals(result.model, "Civic");
});

Deno.test("normalizeVehicle: valid color kept", () => {
  const result = normalizeVehicle({
    plateId: "P1",
    plateState: "CA",
    color: "Red",
    make: "",
    model: "",
  });
  assertEquals(result.color, "Red");
});

Deno.test("normalizeVehicle: invalid color dropped", () => {
  const result = normalizeVehicle({
    plateId: "P1",
    plateState: "CA",
    color: "Chartreuse",
    make: "",
    model: "",
  });
  assertEquals(result.color, "");
});

//
// normalizeVehicles
//

Deno.test("normalizeVehicles: drops blank-plate entries", () => {
  const result = normalizeVehicles([
    { plateId: "---", plateState: "CA", color: "", make: "", model: "" },
    { plateId: "ABC123", plateState: "NY", color: "", make: "", model: "" },
  ]);
  assertEquals(result.length, 1);
  assertEquals(result[0].plateId, "ABC123");
});

Deno.test("normalizeVehicles: dedupes by plateId|plateState, keeps first", () => {
  const result = normalizeVehicles([
    { plateId: "DUP001", plateState: "CA", color: "Red", make: "", model: "" },
    { plateId: "DUP001", plateState: "CA", color: "Blue", make: "", model: "" },
  ]);
  assertEquals(result.length, 1);
  assertEquals(result[0].color, "Red");
});

Deno.test("normalizeVehicles: same plateId different state → both kept", () => {
  const result = normalizeVehicles([
    { plateId: "ABC123", plateState: "CA", color: "", make: "", model: "" },
    { plateId: "ABC123", plateState: "NY", color: "", make: "", model: "" },
  ]);
  assertEquals(result.length, 2);
});

Deno.test("normalizeVehicles: empty list → empty list", () => {
  assertEquals(normalizeVehicles([]), []);
});

Deno.test("normalizeVehicles: normalizes each entry", () => {
  const result = normalizeVehicles([
    {
      plateId: "abc-123",
      plateState: "ca",
      color: "Chartreuse",
      make: "Honda",
      model: "Camry",
    },
  ]);
  assertEquals(result.length, 1);
  assertEquals(result[0].plateId, "ABC123");
  assertEquals(result[0].plateState, "CA");
  assertEquals(result[0].color, "");
  assertEquals(result[0].make, "Honda");
  assertEquals(result[0].model, ""); // Camry not in Honda
});
