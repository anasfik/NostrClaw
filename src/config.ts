import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ConfigWatchlist, WatchlistFilter } from "./types";

export const DEFAULT_CONFIG_PATH = "./nostr-claw.config.json";
export const CONFIG_PATH_ENV = "NOSTR_CLAW_CONFIG";

const watchlistFilterSchema = z.object({
  keywords: z.array(z.string().min(1)).optional(),
  authors: z.array(z.string().min(1)).optional(),
  kinds: z.array(z.number().int()).optional(),
  tags: z.record(z.array(z.string().min(1))).optional(),
  since: z.number().int().optional(),
  limit: z.number().int().optional(),
});

const watchlistSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  prompt: z.string().min(3),
  active: z.boolean().default(true),
  filters: watchlistFilterSchema,
  messageTemplate: z.string().min(1).optional(),
});

const configSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  logLevel: z.string().default("info"),
  logFilePath: z.string().default("./log.txt"),
  dbPath: z.string().default("./nostr-claw.sqlite"),
  nostrRelays: z
    .array(z.string().min(1))
    .default([
      "wss://relay.damus.io",
      "wss://relay.primal.net",
      "wss://nos.lol",
    ]),
  ai: z
    .object({
      provider: z.enum(["openai", "openrouter"]).default("openai"),
      rpm: z.number().int().min(0).default(20),
      openai: z
        .object({
          apiKey: z.string().min(1),
          model: z.string().default("gpt-4.1-mini"),
        })
        .optional(),
      openrouter: z
        .object({
          apiKey: z.string().min(1),
          model: z.string().default("openai/gpt-4o-mini"),
        })
        .optional(),
    })
    .default({ provider: "openai", rpm: 20 }),
  notifications: z
    .object({
      recipientNpub: z.string().min(1).optional(),
      senderNsec: z.string().min(1).optional(),
    })
    .default({}),
  watchlists: z.array(watchlistSchema).default([]),
});

export type AppConfig = {
  configPath: string;
  nodeEnv: "development" | "test" | "production";
  logLevel: string;
  logFilePath: string;
  dbPath: string;
  nostrRelays: string[];
  aiProvider: "openai" | "openrouter";
  openAiApiKey?: string;
  openAiModel: string;
  openRouterApiKey?: string;
  openRouterModel: string;
  notifyRecipientNpub?: string;
  notifierSenderNsec?: string;
  watchlistRefreshMs: number;
  aiRpm: number;
  watchlists: ConfigWatchlist[];
};

function resolveRelativePath(configPath: string, value: string): string {
  return path.isAbsolute(value)
    ? value
    : path.resolve(path.dirname(configPath), value);
}

function deriveWatchlistId(input: { id?: string; name: string }): string {
  if (input.id?.trim()) {
    return input.id.trim();
  }

  const digest = createHash("sha256").update(input.name.trim()).digest("hex");
  return `watchlist-${digest.slice(0, 12)}`;
}

function normalizeFilters(filters: WatchlistFilter): WatchlistFilter {
  return {
    keywords: filters.keywords?.map((value) => value.trim()).filter(Boolean),
    authors: filters.authors?.map((value) => value.trim()).filter(Boolean),
    kinds: filters.kinds,
    tags: filters.tags,
    since: filters.since,
    limit: filters.limit,
  };
}

export function getConfig(
  configPath = process.env[CONFIG_PATH_ENV] || DEFAULT_CONFIG_PATH,
): AppConfig {
  const resolvedConfigPath = path.resolve(configPath);

  if (!existsSync(resolvedConfigPath)) {
    throw new Error(
      `config file not found at ${resolvedConfigPath}. Copy nostr-claw.config.json.example and edit it before starting.`,
    );
  }

  const rawText = readFileSync(resolvedConfigPath, "utf8");
  const parsedJson = JSON.parse(rawText) as unknown;
  const parsed = configSchema.parse(parsedJson);

  return {
    configPath: resolvedConfigPath,
    nodeEnv: parsed.nodeEnv,
    logLevel: parsed.logLevel,
    logFilePath: resolveRelativePath(resolvedConfigPath, parsed.logFilePath),
    dbPath: resolveRelativePath(resolvedConfigPath, parsed.dbPath),
    nostrRelays: parsed.nostrRelays
      .map((relay) => relay.trim())
      .filter(Boolean),
    aiProvider: parsed.ai.provider,
    openAiApiKey: parsed.ai.openai?.apiKey,
    openAiModel: parsed.ai.openai?.model ?? "gpt-4.1-mini",
    openRouterApiKey: parsed.ai.openrouter?.apiKey,
    openRouterModel: parsed.ai.openrouter?.model ?? "openai/gpt-4o-mini",
    notifyRecipientNpub: parsed.notifications.recipientNpub,
    notifierSenderNsec: parsed.notifications.senderNsec,
    watchlistRefreshMs: 0,
    aiRpm: parsed.ai.rpm,
    watchlists: parsed.watchlists.map((watchlist) => ({
      id: deriveWatchlistId(watchlist),
      name: watchlist.name,
      prompt: watchlist.prompt,
      active: watchlist.active,
      filters: normalizeFilters(watchlist.filters),
      messageTemplate: watchlist.messageTemplate,
    })),
  };
}
