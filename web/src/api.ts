import type {
  UiHealthResponse,
  UiMemoryDetailResponse,
  UiOverviewResponse,
  UiTimelineResponse,
} from './types';

const API_BASE = (import.meta.env.VITE_HIPPOCORE_API_BASE as string | undefined)?.trim() || 'http://127.0.0.1:31337';

async function requestJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body?.error === 'string' ? body.error : `Request failed: ${response.status}`);
  }
  return body as T;
}

export function fetchHealth() {
  return requestJson<UiHealthResponse>('/v1/ui/health');
}

export function fetchOverview(date: string, days = 7) {
  return requestJson<UiOverviewResponse>(`/v1/ui/overview?date=${encodeURIComponent(date)}&days=${days}`);
}

export function fetchTimeline(date: string, state = 'all', types: string[] = []) {
  const params = new URLSearchParams();
  params.set('date', date);
  if (state && state !== 'all') params.set('state', state);
  for (const type of types) params.append('type', type);
  return requestJson<UiTimelineResponse>(`/v1/ui/timeline?${params.toString()}`);
}

export function fetchMemoryDetail(id: number) {
  return requestJson<UiMemoryDetailResponse>(`/v1/ui/memory/${id}`);
}
