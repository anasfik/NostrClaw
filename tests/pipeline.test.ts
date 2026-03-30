import { describe, expect, it, vi } from "vitest";
import { AiQueue } from "../src/services/AiQueue";
import { PipelineService } from "../src/services/PipelineService";
import type {
  AiProvider,
  NotificationSender,
  RelayConnector,
} from "../src/contracts";
import type { NostrEvent, Watchlist } from "../src/types";

describe("PipelineService notifications", () => {
  it("sends a DM notification when AI marks an event as notify=true", async () => {
    const watchlist: Watchlist = {
      id: "wl-1",
      name: "BTC L2",
      prompt: "Monitor Bitcoin L2 chatter",
      filters: { keywords: ["bitcoin"] },
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const event: NostrEvent = {
      id: "evt-1",
      pubkey: "pubkey-1",
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      tags: [],
      content: "bitcoin l2 is heating up",
    };

    const relayConnector: RelayConnector = {
      start: vi.fn(),
      stop: vi.fn(),
      onEvent: vi.fn(() => () => undefined),
    };

    const watchlistRepo = {
      listActive: vi.fn(() => [watchlist]),
    } as any;

    const processingRepo = {
      hasProcessed: vi.fn(() => false),
      logProcessed: vi.fn(),
      addInsight: vi.fn(),
    } as any;

    const aiProvider: AiProvider = {
      evaluate: vi.fn(async () => ({
        notify: true,
        message: "Strong signal",
        actionable_link: "https://example.com",
        recommended_actions: ["Follow up"],
        match_score: 0.91,
      })),
    };

    const notificationSender: NotificationSender = {
      sendMatchNotification: vi.fn(async () => undefined),
    };

    const pipeline = new PipelineService({
      relayConnector,
      watchlistRepo,
      processingRepo,
      aiProvider,
      aiQueue: new AiQueue(0),
      notificationSender,
      logFilePath: "/tmp/nostr-mind-pipeline.test.log",
      watchlistRefreshMs: 1000,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as any,
    });

    pipeline.refreshWatchlistsAndSubscriptions();
    await (pipeline as any).handleEvent(event);

    expect(notificationSender.sendMatchNotification).toHaveBeenCalledTimes(1);
    expect(processingRepo.addInsight).toHaveBeenCalledTimes(1);
  });
});
