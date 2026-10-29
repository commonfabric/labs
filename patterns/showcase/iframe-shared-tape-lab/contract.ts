export interface TapeAnnotation {
  id: string;
  range: {
    startSeconds: number;
    endSeconds: number;
  };
  label: string;
  note: string;
  authorId: string;
  initialConfidence: number;
}

export interface ConfidenceAssessment {
  id: string;
  annotationId: string;
  reviewerId: string;
  confidence: number;
}

export interface IframeInputData {
  title: string;
  recordingLabel: string;
  durationSeconds: number;
}

export interface IframeStateData {
  annotations: TapeAnnotation[];
  assessments: ConfidenceAssessment[];
}

export interface IframeOutputData {
  selectedAnnotationId: string | null;
  lastAssessmentId: string | null;
}

export const DEFAULT_INPUT: IframeInputData = {
  title: "Shared Tape Lab",
  recordingLabel: "Synthetic marsh at dusk",
  durationSeconds: 18,
};

export const DEFAULT_STATE: IframeStateData = {
  annotations: [
    {
      id: "seed-frog-cluster",
      range: { startSeconds: 3.2, endSeconds: 5.8 },
      label: "Frog cluster",
      note: "Three short calls above the low water tone.",
      authorId: "field-guide",
      initialConfidence: 0.82,
    },
    {
      id: "seed-wing-rustle",
      range: { startSeconds: 10.4, endSeconds: 12.1 },
      label: "Wing rustle",
      note: "A dry flutter crosses the right side of the sound field.",
      authorId: "field-guide",
      initialConfidence: 0.64,
    },
  ],
  assessments: [],
};

export const DEFAULT_OUTPUT: IframeOutputData = {
  selectedAnnotationId: null,
  lastAssessmentId: null,
};

export const IFRAME_PATTERN = {
  name: "IframeSharedTapeLab",
  displayName: "Shared Tape Lab",
  stateScope: "space",
  outputScope: "user",
  frameHeight: "100vh",
  databases: {},
} as const;
