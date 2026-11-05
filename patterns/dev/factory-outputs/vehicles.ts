// PATTERN TIER: legacy — superseded or non-idiomatic; kept for what
// depends on it. Do not copy from this file. Tiers: patterns/index.md
// ============================================================
// Vehicle catalog and utilities for the Parking Coordinator
// ============================================================

export interface Vehicle {
  plateId: string; // REQUIRED — normalized to uppercase alphanumerics
  plateState: string; // optional, default "CA"
  color: string; // optional, MUST be "" or a member of VEHICLE_COLORS
  make: string; // optional, MUST be "" or a member of VEHICLE_MAKES
  model: string; // optional, MUST be "" or a member of MODELS_BY_MAKE[make]
}

export const VEHICLE_COLORS: string[] = [
  "Black",
  "White",
  "Gray",
  "Silver",
  "Red",
  "Blue",
  "Green",
  "Brown",
  "Beige",
  "Gold",
  "Orange",
  "Yellow",
  "Purple",
  "Maroon",
  "Tan",
  "Other",
];

export const US_STATES: string[] = [
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "DC",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
];

export const VEHICLE_MAKES: string[] = [
  "Acura",
  "Alfa Romeo",
  "Audi",
  "BMW",
  "Buick",
  "Cadillac",
  "Chevrolet",
  "Chrysler",
  "Dodge",
  "Ferrari",
  "Fiat",
  "Ford",
  "Genesis",
  "GMC",
  "Honda",
  "Hyundai",
  "Infiniti",
  "Jaguar",
  "Jeep",
  "Kia",
  "Land Rover",
  "Lexus",
  "Lincoln",
  "Maserati",
  "Mazda",
  "Mercedes-Benz",
  "Mini",
  "Mitsubishi",
  "Nissan",
  "Polestar",
  "Porsche",
  "Ram",
  "Rivian",
  "Subaru",
  "Tesla",
  "Toyota",
  "Volkswagen",
  "Volvo",
  "Other",
];

export const MODELS_BY_MAKE: Record<string, string[]> = {
  "Acura": ["ILX", "MDX", "RDX", "TLX", "Integra", "ZDX", "Other"],
  "Alfa Romeo": ["Giulia", "Stelvio", "Tonale", "Other"],
  "Audi": ["A3", "A4", "A6", "Q3", "Q5", "Q7", "e-tron", "TT", "Other"],
  "BMW": [
    "3 Series",
    "5 Series",
    "7 Series",
    "X1",
    "X3",
    "X5",
    "X7",
    "i4",
    "iX",
    "Other",
  ],
  "Buick": ["Enclave", "Encore", "Envision", "LaCrosse", "Other"],
  "Cadillac": [
    "CT4",
    "CT5",
    "Escalade",
    "XT4",
    "XT5",
    "XT6",
    "Lyriq",
    "Other",
  ],
  "Chevrolet": [
    "Blazer",
    "Camaro",
    "Colorado",
    "Corvette",
    "Equinox",
    "Malibu",
    "Silverado",
    "Suburban",
    "Tahoe",
    "Trailblazer",
    "Traverse",
    "Other",
  ],
  "Chrysler": ["300", "Pacifica", "Voyager", "Other"],
  "Dodge": ["Challenger", "Charger", "Durango", "Hornet", "Other"],
  "Ferrari": ["296", "F8", "Roma", "SF90", "Other"],
  "Fiat": ["500", "500X", "Other"],
  "Ford": [
    "Bronco",
    "Edge",
    "Escape",
    "Expedition",
    "Explorer",
    "F-150",
    "Maverick",
    "Mustang",
    "Mustang Mach-E",
    "Ranger",
    "Transit",
    "Other",
  ],
  "Genesis": ["G70", "G80", "G90", "GV70", "GV80", "Other"],
  "GMC": [
    "Acadia",
    "Canyon",
    "Envoy",
    "Sierra",
    "Terrain",
    "Yukon",
    "Other",
  ],
  "Honda": [
    "Accord",
    "Civic",
    "CR-V",
    "HR-V",
    "Odyssey",
    "Passport",
    "Pilot",
    "Ridgeline",
    "Other",
  ],
  "Hyundai": [
    "Elantra",
    "Ioniq 5",
    "Ioniq 6",
    "Kona",
    "Palisade",
    "Santa Fe",
    "Sonata",
    "Tucson",
    "Other",
  ],
  "Infiniti": ["Q50", "Q60", "QX50", "QX60", "QX80", "Other"],
  "Jaguar": ["E-Pace", "F-Pace", "F-Type", "I-Pace", "XE", "XF", "Other"],
  "Jeep": [
    "Cherokee",
    "Compass",
    "Gladiator",
    "Grand Cherokee",
    "Renegade",
    "Wrangler",
    "Other",
  ],
  "Kia": [
    "Carnival",
    "EV6",
    "EV9",
    "K5",
    "Niro",
    "Seltos",
    "Sorento",
    "Soul",
    "Sportage",
    "Telluride",
    "Other",
  ],
  "Land Rover": [
    "Defender",
    "Discovery",
    "Discovery Sport",
    "Range Rover",
    "Range Rover Evoque",
    "Range Rover Sport",
    "Other",
  ],
  "Lexus": [
    "ES",
    "GX",
    "IS",
    "LC",
    "LS",
    "LX",
    "NX",
    "RX",
    "TX",
    "UX",
    "Other",
  ],
  "Lincoln": [
    "Aviator",
    "Corsair",
    "Nautilus",
    "Navigator",
    "Other",
  ],
  "Maserati": [
    "Ghibli",
    "Grecale",
    "GranTurismo",
    "Levante",
    "Quattroporte",
    "Other",
  ],
  "Mazda": [
    "CX-30",
    "CX-5",
    "CX-50",
    "CX-90",
    "Mazda3",
    "Mazda6",
    "MX-5",
    "Other",
  ],
  "Mercedes-Benz": [
    "A-Class",
    "C-Class",
    "E-Class",
    "GLA",
    "GLC",
    "GLE",
    "GLS",
    "S-Class",
    "EQB",
    "EQS",
    "Other",
  ],
  "Mini": [
    "Clubman",
    "Convertible",
    "Cooper",
    "Countryman",
    "Paceman",
    "Other",
  ],
  "Mitsubishi": [
    "Eclipse Cross",
    "Mirage",
    "Outlander",
    "Outlander Sport",
    "Other",
  ],
  "Nissan": [
    "Altima",
    "Armada",
    "Frontier",
    "Kicks",
    "Leaf",
    "Maxima",
    "Murano",
    "Pathfinder",
    "Rogue",
    "Sentra",
    "Titan",
    "Versa",
    "Other",
  ],
  "Polestar": ["Polestar 2", "Polestar 3", "Polestar 4", "Other"],
  "Porsche": ["718", "911", "Cayenne", "Macan", "Panamera", "Taycan", "Other"],
  "Ram": ["1500", "2500", "3500", "ProMaster", "Other"],
  "Rivian": ["R1S", "R1T", "R2", "Other"],
  "Subaru": [
    "Ascent",
    "BRZ",
    "Crosstrek",
    "Forester",
    "Impreza",
    "Legacy",
    "Outback",
    "Solterra",
    "WRX",
    "Other",
  ],
  "Tesla": ["Model 3", "Model S", "Model X", "Model Y", "Cybertruck", "Other"],
  "Toyota": [
    "4Runner",
    "Avalon",
    "bZ4X",
    "Camry",
    "Corolla",
    "Crown",
    "GR86",
    "Highlander",
    "Land Cruiser",
    "Prius",
    "RAV4",
    "Sequoia",
    "Sienna",
    "Tacoma",
    "Tundra",
    "Venza",
    "Other",
  ],
  "Volkswagen": [
    "Atlas",
    "Golf",
    "ID.4",
    "Jetta",
    "Passat",
    "Taos",
    "Tiguan",
    "Other",
  ],
  "Volvo": ["C40", "S60", "S90", "V90", "XC40", "XC60", "XC90", "Other"],
  "Other": ["Other"],
};

export const modelsForMake = (make: string): string[] =>
  MODELS_BY_MAKE[make] ?? [];

export const formatVehicle = (v: Vehicle): string => {
  const parts: string[] = [];
  if (v.color) parts.push(v.color);
  if (v.make) parts.push(v.make);
  if (v.model) parts.push(v.model);

  const descriptor = parts.join(" ");
  const plate = `${v.plateId}${v.plateState ? ` (${v.plateState})` : ""}`;

  if (descriptor) {
    return `${descriptor} — ${plate}`;
  }
  return plate;
};

export const normalizePlateId = (raw: string): string =>
  raw.toUpperCase().replace(/[^A-Z0-9]/g, "");

// Constrain one vehicle to the catalog: normalize plate, default+validate state,
// and DROP any color/make/model not in the fixed sets. Model is only kept when a
// valid make is set AND the model belongs to that make (fixes stale-cascade data).
// `plateState` is uppercased+trimmed and required to be a real US state code;
// anything else (blank, "XX", whitespace) falls back to "CA" — without this,
// junk states would pollute downstream classification matches.
export const normalizeVehicle = (v: Vehicle): Vehicle => {
  const make = VEHICLE_MAKES.includes(v.make) ? v.make : "";
  const model = make && modelsForMake(make).includes(v.model) ? v.model : "";
  const rawState = (v.plateState ?? "").trim().toUpperCase();
  const plateState = US_STATES.includes(rawState) ? rawState : "CA";
  return {
    plateId: normalizePlateId(v.plateId),
    plateState,
    color: VEHICLE_COLORS.includes(v.color) ? v.color : "",
    make,
    model,
  };
};

// Normalize a list, drop blank-plate entries, and dedupe by plateId|plateState
// (keep first occurrence). This is the single source of truth for vehicle hygiene.
export const normalizeVehicles = (list: readonly Vehicle[]): Vehicle[] => {
  const seen = new Set<string>();
  const result: Vehicle[] = [];
  for (const v of list) {
    const norm = normalizeVehicle(v);
    if (!norm.plateId) continue;
    const key = `${norm.plateId}|${norm.plateState}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(norm);
  }
  return result;
};
