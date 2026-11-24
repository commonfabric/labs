import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface SurveyResponseArgs {
  responses: Default<SurveyResponseInput[], []>;
  questions: Default<string[], []>;
}

interface SurveyResponseInput {
  respondent?: string;
  demographic?: string;
  answers?: Record<string, number>;
}

interface SurveyResponse {
  respondent: string;
  demographic: string;
  answers: Record<string, number>;
}

interface QuestionSummary {
  question: string;
  total: number;
  answered: number;
  average: number;
}

interface DemographicSummary {
  demographic: string;
  responseCount: number;
  questionAverages: Record<string, number>;
  overallAverage: number;
}

interface RecordResponseEvent {
  respondent?: string;
  demographic?: string;
  answers?: Record<string, number>;
}

const defaultDemographic = "general";

const roundAverage = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
};

const normalizeName = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const ensureUnique = (candidate: string, used: Set<string>): string => {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let index = 2;
  let next = `${candidate}-${index}`;
  while (used.has(next)) {
    index += 1;
    next = `${candidate}-${index}`;
  }
  used.add(next);
  return next;
};

const sanitizeScore = (value: unknown): number => {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  const clamped = Math.min(5, Math.max(0, value));
  return roundAverage(clamped);
};

const sanitizeAnswerMap = (
  value: Record<string, unknown> | undefined,
): Record<string, number> => {
  if (!value || typeof value !== "object") return {};
  const entries: [string, number][] = [];
  for (const [key, raw] of Object.entries(value)) {
    const question = normalizeName(key);
    if (!question) continue;
    const score = sanitizeScore(raw);
    entries.push([question, score]);
  }
  entries.sort((left, right) => left[0].localeCompare(right[0]));
  const record: Record<string, number> = {};
  for (const [question, score] of entries) {
    record[question] = score;
  }
  return record;
};

const sanitizeResponseEntry = (
  value: SurveyResponseInput | undefined,
  fallbackIndex: number,
  used: Set<string>,
): SurveyResponse => {
  const fallbackRespondent = `respondent-${Math.max(1, fallbackIndex)}`;
  const respondentName = normalizeName(value?.respondent) ?? fallbackRespondent;
  const uniqueRespondent = ensureUnique(respondentName, used);
  const demographic = normalizeName(value?.demographic) ?? defaultDemographic;
  const answers = sanitizeAnswerMap(
    value?.answers as Record<string, unknown> | undefined,
  );
  return {
    respondent: uniqueRespondent,
    demographic,
    answers,
  };
};

const sanitizeResponses = (value: unknown): SurveyResponse[] => {
  if (!Array.isArray(value)) return [];
  const used = new Set<string>();
  const sanitized: SurveyResponse[] = [];
  for (let index = 0; index < value.length; index++) {
    const input = value[index] as SurveyResponseInput | undefined;
    sanitized.push(sanitizeResponseEntry(input, index + 1, used));
  }
  sanitized.sort((left, right) =>
    left.respondent.localeCompare(right.respondent)
  );
  return sanitized;
};

const sanitizeQuestionList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const set = new Set<string>();
  for (const entry of value) {
    const name = normalizeName(entry);
    if (!name) continue;
    set.add(name);
  }
  const list = Array.from(set);
  list.sort((left, right) => left.localeCompare(right));
  return list;
};

const cloneResponse = (response: SurveyResponse): SurveyResponse => ({
  respondent: response.respondent,
  demographic: response.demographic,
  answers: { ...response.answers },
});

const buildQuestionCatalog = (input: {
  provided: readonly string[] | undefined;
  responses: readonly SurveyResponse[] | undefined;
}): string[] => {
  const set = new Set<string>();
  if (Array.isArray(input.provided)) {
    for (const question of input.provided) {
      if (question.length > 0) set.add(question);
    }
  }
  if (Array.isArray(input.responses)) {
    for (const response of input.responses) {
      for (const question of Object.keys(response.answers)) {
        if (question.length > 0) set.add(question);
      }
    }
  }
  const list = Array.from(set);
  list.sort((left, right) => left.localeCompare(right));
  return list;
};

const buildDemographicCatalog = (
  responses: readonly SurveyResponse[],
): string[] => {
  const set = new Set<string>();
  for (const response of responses) {
    if (response.demographic.length > 0) {
      set.add(response.demographic);
    }
  }
  if (set.size === 0) set.add(defaultDemographic);
  const list = Array.from(set);
  list.sort((left, right) => left.localeCompare(right));
  return list;
};

const computeQuestionSummaries = (input: {
  questions: readonly string[];
  responses: readonly SurveyResponse[];
}): QuestionSummary[] => {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const responses = Array.isArray(input.responses) ? input.responses : [];
  const summaries: QuestionSummary[] = [];
  for (const question of questions) {
    let total = 0;
    let answered = 0;
    for (const response of responses) {
      const value = response.answers[question];
      if (typeof value === "number") {
        total += value;
        answered += 1;
      }
    }
    const average = answered > 0 ? roundAverage(total / answered) : 0;
    summaries.push({ question, total, answered, average });
  }
  summaries.sort((left, right) => left.question.localeCompare(right.question));
  return summaries;
};

const cloneQuestionSummary = (summary: QuestionSummary): QuestionSummary => ({
  question: summary.question,
  total: summary.total,
  answered: summary.answered,
  average: summary.average,
});

const computeDemographicSummaries = (input: {
  demographics: readonly string[];
  questions: readonly string[];
  responses: readonly SurveyResponse[];
}): DemographicSummary[] => {
  const demographics = Array.isArray(input.demographics)
    ? input.demographics
    : [];
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const responses = Array.isArray(input.responses) ? input.responses : [];
  const summaries: DemographicSummary[] = [];
  for (const demographic of demographics) {
    const matching = responses.filter((entry) =>
      entry.demographic === demographic
    );
    const questionTotals: Record<string, { total: number; answered: number }> =
      {};
    for (const question of questions) {
      questionTotals[question] = { total: 0, answered: 0 };
    }
    for (const response of matching) {
      for (const question of questions) {
        const value = response.answers[question];
        if (typeof value === "number") {
          const bucket = questionTotals[question];
          bucket.total += value;
          bucket.answered += 1;
        }
      }
    }
    const questionAverages: Record<string, number> = {};
    let overallTotal = 0;
    let overallAnswered = 0;
    for (const question of questions) {
      const bucket = questionTotals[question];
      if (bucket.answered > 0) {
        const average = roundAverage(bucket.total / bucket.answered);
        questionAverages[question] = average;
        overallTotal += bucket.total;
        overallAnswered += bucket.answered;
      } else {
        questionAverages[question] = 0;
      }
    }
    const overallAverage = overallAnswered > 0
      ? roundAverage(overallTotal / overallAnswered)
      : 0;
    summaries.push({
      demographic,
      responseCount: matching.length,
      questionAverages,
      overallAverage,
    });
  }
  summaries.sort((left, right) =>
    left.demographic.localeCompare(right.demographic)
  );
  return summaries;
};

const cloneDemographicSummary = (
  summary: DemographicSummary,
): DemographicSummary => ({
  demographic: summary.demographic,
  responseCount: summary.responseCount,
  questionAverages: { ...summary.questionAverages },
  overallAverage: summary.overallAverage,
});

const buildQuestionAverageMap = (
  summaries: readonly QuestionSummary[],
): Record<string, number> => {
  const record: Record<string, number> = {};
  for (const summary of summaries) {
    record[summary.question] = summary.average;
  }
  return record;
};

const buildDemographicAverageMap = (
  summaries: readonly DemographicSummary[],
): Record<string, Record<string, number>> => {
  const record: Record<string, Record<string, number>> = {};
  for (const summary of summaries) {
    record[summary.demographic] = { ...summary.questionAverages };
  }
  return record;
};

const appendSurveyResponse = handler(
  (
    event: RecordResponseEvent | undefined,
    context: {
      store: Cell<SurveyResponse[]>;
      base: Cell<SurveyResponse[]>;
      sequence: Cell<number>;
    },
  ) => {
    if (!event) return;
    const storeValue = context.store.get();
    const baseValue = context.base.get();
    const baseline = Array.isArray(storeValue) && storeValue.length > 0
      ? storeValue
      : Array.isArray(baseValue)
      ? baseValue
      : [];
    const used = new Set<string>();
    for (const entry of baseline) {
      used.add(entry.respondent);
    }
    const nextIndex = (context.sequence.get() ?? baseline.length) + 1;
    const sanitized = sanitizeResponseEntry(event, nextIndex, used);
    const next = baseline.map(cloneResponse);
    next.push(sanitized);
    next.sort((left, right) => left.respondent.localeCompare(right.respondent));
    context.store.set(next.map(cloneResponse));
    context.sequence.set(nextIndex);
  },
);

// Module-scope lift definitions
const liftSanitizeResponses = lift(sanitizeResponses);
const liftSanitizeQuestionList = lift(sanitizeQuestionList);

const liftNormalizedResponses = lift((input: {
  store: SurveyResponse[];
  base: SurveyResponse[];
}) => {
  const storeEntries = Array.isArray(input.store) ? input.store : [];
  if (storeEntries.length > 0) {
    return storeEntries.map(cloneResponse);
  }
  const baseEntries = Array.isArray(input.base) ? input.base : [];
  return baseEntries.map(cloneResponse);
});

const liftQuestionCatalog = lift((input: {
  provided: readonly string[];
  responses: readonly SurveyResponse[];
}) => buildQuestionCatalog(input));

const liftQuestionSummaries = lift((input: {
  questions: readonly string[];
  responses: readonly SurveyResponse[];
}) => computeQuestionSummaries(input));

const liftQuestionSummariesView = lift((summaries: QuestionSummary[]) =>
  summaries.map(cloneQuestionSummary)
);

const liftBuildQuestionAverageMap = lift(buildQuestionAverageMap);
const liftQuestionAverageMapView = lift((record: Record<string, number>) => ({
  ...record,
}));

const liftBuildDemographicCatalog = lift(buildDemographicCatalog);

const liftDemographicSummaries = lift((input: {
  demographics: readonly string[];
  questions: readonly string[];
  responses: readonly SurveyResponse[];
}) => computeDemographicSummaries(input));

const liftDemographicSummariesView = lift((summaries: DemographicSummary[]) =>
  summaries.map(cloneDemographicSummary)
);

const liftBuildDemographicAverageMap = lift(buildDemographicAverageMap);
const liftDemographicAverageMapView = lift((
  record: Record<
    string,
    Record<
      string,
      number
    >
  >,
) => {
  const copy: Record<string, Record<string, number>> = {};
  for (const key of Object.keys(record)) {
    copy[key] = { ...record[key] };
  }
  return copy;
});

const liftOverallAverage = lift((summaries: QuestionSummary[]) => {
  let total = 0;
  let answered = 0;
  for (const summary of summaries) {
    total += summary.total;
    answered += summary.answered;
  }
  return answered > 0 ? roundAverage(total / answered) : 0;
});

const liftOverallAverageLabel = lift((value: number | undefined) => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "0.00";
  }
  return value.toFixed(2);
});

const liftResponseCount = lift((entries: readonly SurveyResponse[]) =>
  entries.length
);
const liftQuestionCount = lift((entries: readonly string[]) => entries.length);
const liftDemographicCount = lift((entries: readonly string[]) =>
  entries.length
);

const liftResponsesView = lift((entries: SurveyResponse[]) =>
  entries.map(cloneResponse)
);

export const surveyResponseAnalyzer = pattern<SurveyResponseArgs>(
  ({ responses, questions }) => {
    const sanitizedArgumentResponses = liftSanitizeResponses(responses);
    const sanitizedQuestionList = liftSanitizeQuestionList(questions);

    const responseStore = cell<SurveyResponse[]>([]);
    const responseSequence = cell(0);

    const normalizedResponses = liftNormalizedResponses({
      store: responseStore,
      base: sanitizedArgumentResponses,
    });

    const questionCatalog = liftQuestionCatalog({
      provided: sanitizedQuestionList,
      responses: normalizedResponses,
    });

    const questionSummaries = liftQuestionSummaries({
      questions: questionCatalog,
      responses: normalizedResponses,
    });

    const questionSummariesView = liftQuestionSummariesView(questionSummaries);

    const questionAverageMap = liftBuildQuestionAverageMap(questionSummaries);
    const questionAverageMapView = liftQuestionAverageMapView(
      questionAverageMap,
    );

    const demographicCatalog = liftBuildDemographicCatalog(normalizedResponses);

    const demographicSummaries = liftDemographicSummaries({
      demographics: demographicCatalog,
      questions: questionCatalog,
      responses: normalizedResponses,
    });

    const demographicSummariesView = liftDemographicSummariesView(
      demographicSummaries,
    );

    const demographicAverageMap = liftBuildDemographicAverageMap(
      demographicSummaries,
    );
    const demographicAverageMapView = liftDemographicAverageMapView(
      demographicAverageMap,
    );

    const overallAverage = liftOverallAverage(questionSummaries);

    const overallAverageLabel = liftOverallAverageLabel(overallAverage);

    const responseCount = liftResponseCount(normalizedResponses);
    const questionCount = liftQuestionCount(questionCatalog);
    const demographicCount = liftDemographicCount(demographicCatalog);

    const summaryHead =
      str`${responseCount} responses · ${questionCount} questions`;
    const summary =
      str`${summaryHead} · ${demographicCount} demographics · avg ${overallAverageLabel}`;

    const responsesView = liftResponsesView(normalizedResponses);

    return {
      responses: responsesView,
      questionCatalog,
      demographicCatalog,
      questionSummaries: questionSummariesView,
      questionAverages: questionAverageMapView,
      demographicSummaries: demographicSummariesView,
      demographicAverages: demographicAverageMapView,
      overallAverage,
      overallAverageLabel,
      summary,
      responseCount,
      questionCount,
      demographicCount,
      recordResponse: appendSurveyResponse({
        store: responseStore,
        base: sanitizedArgumentResponses,
        sequence: responseSequence,
      }),
    };
  },
);

export default surveyResponseAnalyzer;
