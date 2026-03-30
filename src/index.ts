import { getConfig, type AppConfig } from "./config";
import type { AiProvider } from "./contracts";
import { createApp } from "./app";
import { FallbackAiProvider } from "./infra/ai/FallbackAiProvider";
import { GeminiProvider } from "./infra/ai/GeminiProvider";
import { OllamaProvider } from "./infra/ai/OllamaProvider";
import { OpenAiProvider } from "./infra/ai/OpenAiProvider";
import { OpenRouterProvider } from "./infra/ai/OpenRouterProvider";
import { initDb } from "./infra/db";
import { NostrDmNotificationSender } from "./infra/notify/NostrDmNotificationSender";
import {
  AppIdentityRepository,
  ProcessingRepository,
  WatchlistRepository,
} from "./infra/repositories";
import { NostrWsRelayConnector } from "./infra/relay/NostrWsRelayConnector";
import { createLogger } from "./logger";
import { AiQueue } from "./services/AiQueue";
import { EventBus } from "./services/EventBus";
import { PipelineService } from "./services/PipelineService";

async function main(): Promise<void> {
  const config = getConfig();
  const logger = createLogger(config.logLevel);
  const db = initDb(config.dbPath);
  const watchlistRepo = new WatchlistRepository(db);
  const processingRepo = new ProcessingRepository(db);
  const identityRepo = new AppIdentityRepository(db);

  if (config.notifierSenderNsec) {
    identityRepo.setNotifierIdentity(config.notifierSenderNsec);
  }

  const syncedWatchlists = watchlistRepo.syncFromConfig(config.watchlists);

  const createProvider = (
    providerName: AppConfig["aiProvider"],
    required = false,
  ): AiProvider | undefined => {
    if (providerName === "openai") {
      if (!config.openAiApiKey) {
        if (required) {
          throw new Error("OPENAI_API_KEY is required when AI_PROVIDER=openai");
        }
        return undefined;
      }
      return new OpenAiProvider(config.openAiApiKey, config.openAiModel);
    }

    if (providerName === "openrouter") {
      if (!config.openRouterApiKey) {
        if (required) {
          throw new Error(
            "OPENROUTER_API_KEY is required when AI_PROVIDER=openrouter",
          );
        }
        return undefined;
      }
      return new OpenRouterProvider(
        config.openRouterApiKey,
        config.openRouterModel,
      );
    }

    if (providerName === "gemini") {
      if (!config.geminiApiKey) {
        if (required) {
          throw new Error("GEMINI_API_KEY is required when AI_PROVIDER=gemini");
        }
        return undefined;
      }
      return new GeminiProvider(config.geminiApiKey, config.geminiModel);
    }

    // Ollama provider
    return new OllamaProvider(config.ollamaBaseUrl, config.ollamaModel);
  };

  const providerOrder = [
    config.aiProvider,
    ...config.aiFallbackProviders,
  ].filter((providerName, index, all) => all.indexOf(providerName) === index);

  const providerChain: Array<{ name: string; provider: AiProvider }> = [];
  for (let i = 0; i < providerOrder.length; i += 1) {
    const providerName = providerOrder[i];
    const provider = createProvider(providerName, i === 0);

    if (!provider) {
      logger.warn(
        { provider: providerName },
        "ai-provider:fallback:skipped-unconfigured",
      );
      continue;
    }

    providerChain.push({ name: providerName, provider });
  }

  if (providerChain.length === 0) {
    throw new Error("No configured AI providers are available");
  }

  const aiProvider: AiProvider =
    providerChain.length === 1
      ? providerChain[0].provider
      : new FallbackAiProvider(providerChain, logger);

  const relayConnector = new NostrWsRelayConnector(
    config.nostrRelays,
    5000,
    logger,
  );

  const notificationSender = config.notifyRecipientNpub
    ? new NostrDmNotificationSender({
        relays: config.nostrRelays,
        recipientNpub: config.notifyRecipientNpub,
        identityRepo,
        logger,
      })
    : undefined;

  await notificationSender?.initialize?.();

  const aiQueue = new AiQueue(
    config.aiRpm,
    (waitMs) =>
      logger.warn({ waitMs, pending: aiQueue.pending }, "ai-queue:throttled"),
    200,
    (pending) =>
      logger.warn(
        { pending, shed: aiQueue.shed },
        "ai-queue:full:event-dropped",
      ),
  );

  const eventBus = new EventBus();

  const pipeline = new PipelineService({
    relayConnector,
    watchlistRepo,
    processingRepo,
    aiProvider,
    aiQueue,
    notificationSender,
    logFilePath: config.logFilePath,
    watchlistRefreshMs: config.watchlistRefreshMs,
    logger,
    eventBus,
  });

  pipeline.start();

  // ── Dashboard HTTP server ──────────────────────────────────────────────────

  const activeModel = (() => {
    if (config.aiProvider === "openrouter") return config.openRouterModel;
    if (config.aiProvider === "gemini") return config.geminiModel;
    if (config.aiProvider === "ollama") return config.ollamaModel;
    return config.openAiModel;
  })();

  if (config.dashboardEnabled) {
    const server = createApp(
      {
        watchlistRepo,
        processingRepo,
        eventBus,
        runtimeMeta: {
          startTime: new Date(),
          aiProvider: config.aiProvider,
          aiModel: activeModel,
          relayCount: config.nostrRelays.length,
          aiQueuePending: () => aiQueue.pending,
          aiQueueShed: () => aiQueue.shed,
        },
        onWatchlistsChanged: () => pipeline.refreshWatchlistsAndSubscriptions(),
      },
      { logger: false },
    );

    await server.listen({
      port: config.dashboardPort,
      host: config.dashboardHost,
    });

    logger.info(
      { url: `http://${config.dashboardHost}:${config.dashboardPort}` },
      "dashboard:started",
    );
  }

  logger.info(
    {
      configPath: config.configPath,
      dbPath: config.dbPath,
      relayCount: config.nostrRelays.length,
      watchlistCount: syncedWatchlists.filter((watchlist) => watchlist.active)
        .length,
      notifyRecipientNpub: config.notifyRecipientNpub ?? null,
    },
    "NostrMind started in config-file mode",
  );

  logger.debug(
    {
      aiProvider: config.aiProvider,
      aiFallbackProviders: config.aiFallbackProviders,
      aiModel: activeModel,
      aiRpm: config.aiRpm,
      watchlists: syncedWatchlists.map((watchlist) => ({
        id: watchlist.id,
        name: watchlist.name,
        active: watchlist.active,
        since: watchlist.filters.since,
        limit: watchlist.filters.limit,
      })),
    },
    "runtime configuration snapshot",
  );

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info("shutting down NostrMind");
    pipeline.stop();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>(() => undefined);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
