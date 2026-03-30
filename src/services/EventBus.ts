import { EventEmitter } from "node:events";

export interface PipelineEvent {
  type: "match" | "skip";
  watchlistId: string;
  watchlistName: string;
  eventId: string;
  eventPubkey: string;
  eventKind: number;
  eventCreatedAt: number;
  eventTags: string[][];
  eventSig?: string;
  content: string;
  matchScore?: number;
  message?: string;
  actionableLink?: string;
  recommendedActions?: string[];
  timestamp: string;
}

/**
 * Lightweight in-process event bus.
 * PipelineService publishes events; SSE endpoint subscribes to fan them out to browser clients.
 */
export class EventBus extends EventEmitter {
  private static readonly CHANNEL = "pipeline:event";

  publish(payload: PipelineEvent): void {
    this.emit(EventBus.CHANNEL, payload);
  }

  /** Returns a cleanup function that removes the listener. */
  onPipelineEvent(listener: (payload: PipelineEvent) => void): () => void {
    this.on(EventBus.CHANNEL, listener);
    return () => this.off(EventBus.CHANNEL, listener);
  }
}
