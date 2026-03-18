export interface UiHealthResponse {
  ok: boolean;
  dbReady: boolean;
  memoryItemCount: number;
  latestMemoryAt: string | null;
  latestSyncAt: string | null;
}

export interface UiOverviewResponse {
  date: string;
  timezone: string;
  summary: {
    dayTotal: number;
    candidateCount: number;
    verifiedCount: number;
    archivedCount: number;
    byType: Record<string, number>;
    latestMemoryAt: string | null;
    latestSyncAt: string | null;
  };
  trend: Array<{
    date: string;
    count: number;
  }>;
}

export interface SourceInfo {
  sourceType: string | null;
  sourcePath: string;
  sourceLabel: string;
  sourceDecisionPath: string;
  sourceUrl: string | null;
  notionPageUrl: string | null;
  notionBlockUrl: string | null;
}

export interface TimelineItem {
  id: number;
  time: string;
  timestamp: string | null;
  type: string;
  title: string;
  body: string;
  displayBody: string;
  state: string;
  status: string;
  projectId: string | null;
  projectDisplayName: string;
  sourceSummary: string;
  contextSummary: string;
  meaningSummary: string;
  actionabilitySummary: string;
  nextAction: string;
  ownerHint: string;
  source: SourceInfo;
}

export interface UiTimelineResponse {
  date: string;
  filters: {
    projectId: string | null;
    state: string;
    types: string[];
  };
  items: TimelineItem[];
}

export interface MemoryEvidence {
  id: number;
  sourceType: string | null;
  sourcePath: string;
  sourceLabel: string;
  sourceDecisionPath: string;
  sourceUrl: string | null;
  notionPageUrl: string | null;
  notionBlockUrl: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  snippet: string;
  role: string | null;
  createdAt: string | null;
}

export interface MemoryRelation {
  relationType: string;
  weight: number;
  evidenceRef: string;
  targetId: number;
  targetTitle: string;
  targetType: string;
}

export interface UiMemoryDetailResponse {
  item: {
    id: number;
    type: string;
    title: string;
    body: string;
    displayBody: string;
    state: string;
    status: string;
    confidence: number;
    importance: number;
    freshnessTs: number;
    createdAt: string | null;
    updatedAt: string | null;
    projectId: string | null;
    projectDisplayName: string;
    sourceSummary: string;
    contextSummary: string;
    meaningSummary: string;
    actionabilitySummary: string;
    nextAction: string;
    ownerHint: string;
    source: SourceInfo;
    evidence: MemoryEvidence[];
    relations: {
      outgoing: MemoryRelation[];
      incoming: MemoryRelation[];
    };
  };
}
