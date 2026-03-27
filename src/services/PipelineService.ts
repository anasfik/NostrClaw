import crypto from "node:crypto";
import { appendFile } from "node:fs/promises";
import type {
  AiProvider,
  NotificationSender,
  RelayConnector,
  RelayFilter,
} from "../contracts";
import { matchesQuickFilter } from "../domain/filter";
import {
  ProcessingRepository,
  WatchlistRepository,
} from "../infra/repositories";
import type { AppLogger } from "../logger";
import type { Watchlist } from "../types";
import { AiQueue } from "./AiQueue";

export class PipelineService {
  private watchlists: Watchlist[] = [];
  private unbindRelay?: () => void;
  private refreshTimer?: NodeJS.Timeout;
  /** Guards against duplicate concurrent processing of the same (event, watchlist) pair. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly deps: {
      relayConnector: RelayConnector;
      watchlistRepo: WatchlistRepository;
      processingRepo: ProcessingRepository;
      aiProvider: AiProvider;
      aiQueue: AiQueue;
      notificationSender?: NotificationSender;
      logger: AppLogger;
      logFilePath: string;
      watchlistRefreshMs: number;
    },
  ) {}

  private async appendProcessingLog(input: {
    watchlist: Watchlist;
    event: {
      id: string;
      created_at: number;
      content: string;
      pubkey: string;
      kind: number;
      tags: string[][];
    };
    aiDecision: { notify: boolean; message?: string; match_score?: number };
  }): Promise<void> {
    const line = JSON.stringify({
      watchlistId: input.watchlist.id,
      watchlistName: input.watchlist.name,
      eventId: input.event.id,
      eventPubkey: input.event.pubkey,
      eventKind: input.event.kind,
      eventCreatedAt: input.event.created_at,
      notify: input.aiDecision.notify,
      matchScore: input.aiDecision.match_score ?? null,
      message: input.aiDecision.message ?? null,
      content: input.event.content,
    });

    await appendFile(this.deps.logFilePath, `${line}\n`, "utf8");
  }

  start(): void {
    this.deps.logger.info("pipeline:start");
    this.refreshWatchlistsAndSubscriptions();
    this.unbindRelay = this.deps.relayConnector.onEvent((event) => {
      void this.handleEvent(event);
    });

    if (this.deps.watchlistRefreshMs > 0) {
      this.deps.logger.info(
        { refreshIntervalMs: this.deps.watchlistRefreshMs },
        "pipeline:watchlist-refresh:enabled",
      );
      this.refreshTimer = setInterval(() => {
        this.refreshWatchlistsAndSubscriptions();
      }, this.deps.watchlistRefreshMs);
    } else {
      this.deps.logger.info("pipeline:watchlist-refresh:disabled");
    }
  }

  stop(): void {
    this.deps.logger.info("pipeline:stop");
    if (this.unbindRelay) {
      this.unbindRelay();
      this.unbindRelay = undefined;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.deps.relayConnector.stop();
  }

  refreshWatchlistsAndSubscriptions(): void {
    this.watchlists = this.deps.watchlistRepo.listActive();
    const filters = this.toRelayFilters(this.watchlists);

    this.deps.logger.info(
      {
        activeWatchlistCount: this.watchlists.length,
        filtersCount: filters.length,
      },
      "pipeline:subscriptions:refresh",
    );

    this.deps.logger.debug(
      {
        filters,
      },
      "pipeline:subscriptions:filters",
    );

    this.deps.relayConnector.stop();
    this.deps.relayConnector.start(filters);
  }

  private toRelayFilters(watchlists: Watchlist[]): RelayFilter[] {
    if (watchlists.length === 0) {
      return [{ kinds: [1] }];
    }

    return watchlists.map((watchlist) => {
      const filter: RelayFilter = {};

      // Include since timestamp from watchlist creation
      if (watchlist.filters.since !== undefined) {
        filter.since = watchlist.filters.since;
      }

      if (watchlist.filters.limit !== undefined) {
        filter.limit = watchlist.filters.limit;
      }

      if (watchlist.filters.kinds?.length) {
        filter.kinds = [...new Set(watchlist.filters.kinds)];
      }

      if (watchlist.filters.authors?.length) {
        filter.authors = [...new Set(watchlist.filters.authors)];
      }

      for (const [tagKey, values] of Object.entries(
        watchlist.filters.tags ?? {},
      )) {
        if (values.length > 0) {
          filter[`#${tagKey}`] = [...new Set(values)];
        }
      }

      if (
        !filter.kinds &&
        !filter.authors &&
        !filter.since &&
        Object.keys(filter).length === 0
      ) {
        filter.kinds = [1];
      }

      return filter;
    });
  }

  private async handleEvent(event: {
    id: string;
    created_at: number;
    content: string;
    pubkey: string;
    kind: number;
    tags: string[][];
  }): Promise<void> {
    this.deps.logger.debug(
      {
        eventId: event.id,
        kind: event.kind,
        pubkey: event.pubkey,
      },
      "pipeline:event:received",
    );

    for (const watchlist of this.watchlists) {
      const isProcessed = this.deps.processingRepo.hasProcessed(
        event.id,
        watchlist.id,
      );

      const quickMatch = matchesQuickFilter(event, watchlist.filters, {
        isProcessed,
      });

      if (!quickMatch) {
        this.deps.logger.debug(
          {
            eventId: event.id,
            watchlistId: watchlist.id,
            reason: isProcessed ? "already_processed" : "quick_filter_no_match",
          },
          "pipeline:event:skipped",
        );
        continue;
      }

      // Prevent concurrent duplicate processing for the same (event, watchlist)
      const flightKey = `${event.id}:${watchlist.id}`;
      if (this.inFlight.has(flightKey)) {
        this.deps.logger.debug(
          { eventId: event.id, watchlistId: watchlist.id },
          "pipeline:event:skipped:in-flight",
        );
        continue;
      }
      this.inFlight.add(flightKey);

      try {
        this.deps.logger.info(
          {
            eventId: event.id,
            watchlistId: watchlist.id,
            watchlistName: watchlist.name,
          },
          "pipeline:event:processing",
        );

        const aiDecision = await this.deps.aiQueue.enqueue(() =>
          this.deps.aiProvider.evaluate({ watchlist, event }),
        );

        this.deps.logger.info(
          {
            eventId: event.id,
            watchlistId: watchlist.id,
            notify: aiDecision.notify,
            matchScore: aiDecision.match_score ?? null,
          },
          "pipeline:event:processed",
        );

        const hash = crypto
          .createHash("sha256")
          .update(event.content)
          .digest("hex");
        this.deps.processingRepo.logProcessed({
          eventId: event.id,
          watchlistId: watchlist.id,
          eventTimestamp: event.created_at,
          contentHash: hash,
          aiDecision,
        });

        this.deps.logger.debug(
          { eventId: event.id, watchlistId: watchlist.id },
          "pipeline:event:saved",
        );

        await this.appendProcessingLog({ watchlist, event, aiDecision });

        this.deps.logger.debug(
          { eventId: event.id, watchlistId: watchlist.id },
          "pipeline:event:log-written",
        );

        if (aiDecision.notify) {
          this.deps.logger.info(
            {
              eventId: event.id,
              watchlistId: watchlist.id,
              message: aiDecision.message ?? null,
              matchScore: aiDecision.match_score ?? null,
            },
            "pipeline:match:found",
          );

          this.deps.processingRepo.addInsight({
            watchlistId: watchlist.id,
            eventId: event.id,
            eventPubkey: event.pubkey,
            eventCreatedAt: event.created_at,
            content: event.content,
            aiDecision,
          });

          this.deps.logger.debug(
            { eventId: event.id, watchlistId: watchlist.id },
            "pipeline:match:insight-saved",
          );

          await this.deps.notificationSender?.sendMatchNotification({
            watchlist,
            event,
            aiDecision,
          });

          this.deps.logger.info(
            {
              eventId: event.id,
              watchlistId: watchlist.id,
              notificationsEnabled: Boolean(this.deps.notificationSender),
            },
            "pipeline:match:notified",
          );
        } else {
          this.deps.logger.debug(
            { eventId: event.id, watchlistId: watchlist.id },
            "pipeline:event:no-match",
          );
        }
      } catch (error) {
        this.deps.logger.error(
          { error, eventId: event.id, watchlistId: watchlist.id },
          "pipeline:event:failed",
        );
      } finally {
        this.inFlight.delete(flightKey);
      }
    }
  }
}
