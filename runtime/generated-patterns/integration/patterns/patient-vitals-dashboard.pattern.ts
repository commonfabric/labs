import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface VitalThresholdsInput {
  heartRate?: { min?: number; max?: number };
  systolic?: { max?: number };
  diastolic?: { max?: number };
  temperature?: { min?: number; max?: number };
  oxygen?: { min?: number };
}

interface VitalThresholds {
  heartRate: { min: number; max: number };
  systolic: { max: number };
  diastolic: { max: number };
  temperature: { min: number; max: number };
  oxygen: { min: number };
}

interface VitalReadingSeed {
  id?: string;
  recordedAt?: string;
  heartRate?: number;
  systolic?: number;
  diastolic?: number;
  temperature?: number;
  oxygenSaturation?: number;
}

interface VitalReading {
  id: string;
  recordedAt: string;
  heartRate: number;
  systolic: number;
  diastolic: number;
  temperature: number;
  oxygenSaturation: number;
}

interface PatientVitalsArgs {
  patientName: Default<string, "Unknown patient">;
  initialReadings: Default<VitalReadingSeed[], []>;
  thresholds: Default<VitalThresholdsInput, {}>;
}

interface RecordReadingEvent extends VitalReadingSeed {}

interface UpdateThresholdsEvent extends VitalThresholdsInput {}

interface AlertSnapshot {
  readingId: string;
  alerts: string[];
}

const defaultThresholds = {
  heartRate: { min: 55, max: 110 },
  systolic: { max: 140 },
  diastolic: { max: 90 },
  temperature: { min: 36, max: 38 },
  oxygen: { min: 95 },
} as const satisfies VitalThresholds;

const isoMinutePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/;

const toIsoMinute = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (isoMinutePattern.test(trimmed)) {
      return trimmed;
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return `${parsed.toISOString().slice(0, 16)}Z`;
    }
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.toISOString().slice(0, 16)}Z`;
  }
  return fallback;
};

const toPositiveInt = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Math.max(0, Math.trunc(fallback));
  }
  return Math.max(0, Math.trunc(value));
};

const toBpm = (value: unknown, fallback: number): number => {
  const sanitized = toPositiveInt(value, fallback);
  return Math.min(240, sanitized);
};

const toBloodPressure = (value: unknown, fallback: number): number => {
  const sanitized = toPositiveInt(value, fallback);
  return Math.min(250, sanitized);
};

const toTemperature = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.max(30, Math.min(45, value));
    return Math.round(normalized * 10) / 10;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return Math.round(Math.max(30, Math.min(45, parsed)) * 10) / 10;
    }
  }
  return Math.round(fallback * 10) / 10;
};

const toOxygen = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Math.max(50, Math.min(100, Math.trunc(fallback)));
  }
  return Math.max(50, Math.min(100, Math.trunc(value)));
};

const sanitizeId = (
  value: unknown,
  fallback: string,
  used: Set<string>,
): string => {
  let base: string;
  if (typeof value === "string") {
    const trimmed = value.trim();
    base = trimmed.length > 0 ? trimmed : fallback;
  } else {
    base = fallback;
  }
  let id = base;
  let attempt = 1;
  while (used.has(id)) {
    attempt += 1;
    id = `${base}-${attempt}`;
  }
  used.add(id);
  return id;
};

const toFallbackTimestamp = (index: number): string => {
  const start = new Date(Date.UTC(2024, 0, 1, 8, 0, 0));
  start.setUTCMinutes(start.getUTCMinutes() + index * 90);
  return `${start.toISOString().slice(0, 16)}Z`;
};

const toVitalReading = (
  seed: VitalReadingSeed | undefined,
  index: number,
  usedIds: Set<string>,
): VitalReading => {
  const recordedAt = toIsoMinute(seed?.recordedAt, toFallbackTimestamp(index));
  const heartRate = toBpm(seed?.heartRate, 72);
  const systolic = toBloodPressure(seed?.systolic, 118);
  const diastolic = toBloodPressure(seed?.diastolic, 76);
  const temperature = toTemperature(seed?.temperature, 36.8);
  const oxygen = toOxygen(seed?.oxygenSaturation, 97);
  const id = sanitizeId(seed?.id, `reading-${index + 1}`, usedIds);
  return {
    id,
    recordedAt,
    heartRate,
    systolic,
    diastolic,
    temperature,
    oxygenSaturation: oxygen,
  };
};

const sanitizeReadings = (
  entries: readonly VitalReadingSeed[] | undefined,
): VitalReading[] => {
  if (!Array.isArray(entries)) {
    return [];
  }
  const used = new Set<string>();
  const sanitized = entries.map((entry, index) =>
    toVitalReading(entry, index, used)
  );
  sanitized.sort((left, right) => {
    if (left.recordedAt === right.recordedAt) {
      return left.id.localeCompare(right.id);
    }
    return left.recordedAt.localeCompare(right.recordedAt);
  });
  return sanitized;
};

const sanitizeThresholds = (
  seed: VitalThresholdsInput | undefined,
  fallback: VitalThresholds,
): VitalThresholds => {
  const heartMin = toBpm(seed?.heartRate?.min, fallback.heartRate.min);
  const heartMax = toBpm(seed?.heartRate?.max, fallback.heartRate.max);
  const systolicMax = toBloodPressure(
    seed?.systolic?.max,
    fallback.systolic.max,
  );
  const diastolicMax = toBloodPressure(
    seed?.diastolic?.max,
    fallback.diastolic.max,
  );
  const tempMin = toTemperature(
    seed?.temperature?.min,
    fallback.temperature.min,
  );
  const tempMax = toTemperature(
    seed?.temperature?.max,
    fallback.temperature.max,
  );
  const oxygenMin = toOxygen(seed?.oxygen?.min, fallback.oxygen.min);

  const heartRate = heartMin <= heartMax
    ? { min: heartMin, max: heartMax }
    : { min: heartMax, max: heartMin };
  const temperature = tempMin <= tempMax
    ? { min: tempMin, max: tempMax }
    : { min: tempMax, max: tempMin };

  return {
    heartRate,
    systolic: { max: systolicMax },
    diastolic: { max: diastolicMax },
    temperature,
    oxygen: { min: oxygenMin },
  };
};

const summarizeReading = (reading: VitalReading): string => {
  const bp = `${reading.systolic}/${reading.diastolic}`;
  return `${reading.recordedAt} · HR ${reading.heartRate} bpm · BP ${bp} mmHg · ` +
    `Temp ${
      reading.temperature.toFixed(1)
    }°C · SpO₂ ${reading.oxygenSaturation}%`;
};

const computeAlerts = (
  reading: VitalReading | null,
  thresholds: VitalThresholds,
): string[] => {
  if (!reading) {
    return [];
  }
  const alerts: string[] = [];
  if (reading.heartRate < thresholds.heartRate.min) {
    alerts.push(
      `Heart rate low: ${reading.heartRate} bpm (min ` +
        `${thresholds.heartRate.min})`,
    );
  } else if (reading.heartRate > thresholds.heartRate.max) {
    alerts.push(
      `Heart rate high: ${reading.heartRate} bpm (max ` +
        `${thresholds.heartRate.max})`,
    );
  }
  if (
    reading.systolic > thresholds.systolic.max ||
    reading.diastolic > thresholds.diastolic.max
  ) {
    alerts.push(
      `Blood pressure high: ${reading.systolic}/${reading.diastolic} mmHg (` +
        `max ${thresholds.systolic.max}/${thresholds.diastolic.max})`,
    );
  }
  if (reading.temperature < thresholds.temperature.min) {
    alerts.push(
      `Temperature low: ${reading.temperature.toFixed(1)}°C (min ` +
        `${thresholds.temperature.min.toFixed(1)}°C)`,
    );
  } else if (reading.temperature > thresholds.temperature.max) {
    alerts.push(
      `Temperature high: ${reading.temperature.toFixed(1)}°C (max ` +
        `${thresholds.temperature.max.toFixed(1)}°C)`,
    );
  }
  if (reading.oxygenSaturation < thresholds.oxygen.min) {
    alerts.push(
      `Oxygen saturation low: ${reading.oxygenSaturation}% (min ` +
        `${thresholds.oxygen.min}%)`,
    );
  }
  return alerts;
};

const buildAlertHistory = (
  readings: readonly VitalReading[],
  thresholds: VitalThresholds,
): AlertSnapshot[] => {
  return readings.map((reading) => ({
    readingId: reading.id,
    alerts: computeAlerts(reading, thresholds),
  }));
};

const buildHistorySummaries = (
  readings: readonly VitalReading[],
): string[] => {
  return readings.map(summarizeReading);
};

const recordVitalReading = handler(
  (
    event: RecordReadingEvent | undefined,
    context: {
      state: Cell<VitalReading[]>;
      combined: Cell<VitalReading[]>;
      thresholds: Cell<VitalThresholds>;
    },
  ) => {
    const existing = context.combined.get() ?? [];
    const used = new Set(existing.map((entry) => entry.id));
    const reading = toVitalReading(event, existing.length, used);
    const nextHistory = [...existing.slice(-11), reading];
    context.state.set(nextHistory);
  },
);

const updateThresholds = handler(
  (
    event: UpdateThresholdsEvent | undefined,
    context: { thresholds: Cell<VitalThresholdsInput> },
  ) => {
    const current = sanitizeThresholds(
      context.thresholds.get(),
      defaultThresholds,
    );
    const next = sanitizeThresholds(event, current);
    context.thresholds.set(next as VitalThresholdsInput);
  },
);

// Module-scope lift definitions
const liftReadableName = lift((value: string | undefined) => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return "Unknown patient";
});

const liftHistorySeed = lift((seed: VitalReadingSeed[] | undefined) =>
  sanitizeReadings(seed)
);

const liftHistoryView = lift(
  (
    input: { state: VitalReading[]; seed: VitalReading[] },
  ): VitalReading[] => {
    const stateEntries = Array.isArray(input.state) ? input.state : [];
    return stateEntries.length > 0 ? stateEntries : input.seed;
  },
);

const liftSummariesView = lift((entries: VitalReading[]) =>
  buildHistorySummaries(entries)
);

const liftThresholdsView = lift((seed: VitalThresholdsInput | undefined) =>
  sanitizeThresholds(seed, defaultThresholds)
);

const liftLatestReading = lift((entries: VitalReading[]) => {
  return entries.length === 0 ? null : entries[entries.length - 1];
});

const liftAlerts = lift(
  (
    input: {
      reading: VitalReading | null;
      thresholds: VitalThresholds;
    },
  ) => computeAlerts(input.reading, input.thresholds),
);

const liftAlertHistory = lift(
  (
    input: {
      readings: VitalReading[];
      thresholds: VitalThresholds;
    },
  ) => buildAlertHistory(input.readings, input.thresholds),
);

const liftAlertCount = lift((list: string[] | undefined) =>
  Array.isArray(list) ? list.length : 0
);

const liftCritical = lift((count: number) => count > 0);

const liftLatestSummaryText = lift((reading: VitalReading | null) =>
  reading ? summarizeReading(reading) : "No readings yet"
);

const liftAlertSummaryText = lift((count: number) =>
  count === 0 ? "All vitals within range" : `${count} active alerts`
);

/** Pattern tracking patient vitals with derived alert summaries. */
export const patientVitalsDashboardPattern = pattern<PatientVitalsArgs>(
  ({ patientName, initialReadings, thresholds }) => {
    const readableName = liftReadableName(patientName);

    const history = cell<VitalReading[]>([]);
    const historySeed = liftHistorySeed(initialReadings);
    const historyView = liftHistoryView({ state: history, seed: historySeed });
    const summariesView = liftSummariesView(historyView);
    const thresholdsView = liftThresholdsView(thresholds);

    const latestReading = liftLatestReading(historyView);

    const alerts = liftAlerts({
      reading: latestReading,
      thresholds: thresholdsView,
    });

    const alertHistory = liftAlertHistory({
      readings: historyView,
      thresholds: thresholdsView,
    });

    const alertCount = liftAlertCount(alerts);
    const critical = liftCritical(alertCount);

    const latestSummaryText = liftLatestSummaryText(latestReading);
    const alertSummaryText = liftAlertSummaryText(alertCount);

    const statusLabel = str`${readableName} · Alerts: ${alertCount}`;
    const latestSummary = str`Latest: ${latestSummaryText}`;
    const alertLabel = str`Alerts: ${alertSummaryText}`;

    return {
      patientName: readableName,
      thresholds: thresholdsView,
      readings: historyView,
      historySummaries: summariesView,
      alertHistory,
      alerts,
      alertCount,
      isCritical: critical,
      statusLabel,
      latestSummary,
      alertLabel,
      recordReading: recordVitalReading({
        state: history,
        combined: historyView,
        thresholds: thresholdsView,
      }),
      updateThresholds: updateThresholds({ thresholds }),
    };
  },
);

export default patientVitalsDashboardPattern;
