export type NostrTag = string[];

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: NostrTag[];
  content: string;
  sig?: string;
}

export interface WatchlistFilter {
  keywords?: string[];
  authors?: string[];
  kinds?: number[];
  tags?: Record<string, string[]>;
  since?: number; // Unix timestamp (seconds)
  limit?: number; // Relay subscription limit
}

export interface Watchlist {
  id: string;
  name: string;
  prompt: string;
  filters: WatchlistFilter;
  active: boolean;
  messageTemplate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConfigWatchlist {
  id: string;
  name: string;
  prompt: string;
  filters: WatchlistFilter;
  active: boolean;
  messageTemplate?: string;
}

export interface AiDecision {
  notify: boolean;
  message?: string;
  actionable_link?: string;
  recommended_actions?: string[];
  match_score?: number;
}

export interface AiEvaluationInput {
  watchlist: Watchlist;
  event: NostrEvent;
}

export interface InsightRecord {
  watchlistId: string;
  eventId: string;
  eventPubkey: string;
  eventCreatedAt: number;
  content: string;
  aiDecision: AiDecision;
  createdAt: string;
}
