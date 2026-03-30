import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { z } from "zod";
import {
  ProcessingRepository,
  WatchlistRepository,
} from "./infra/repositories";
import type { EventBus } from "./services/EventBus";
import type { WatchlistFilter } from "./types";

const watchlistCreateSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(3),
  active: z.boolean().optional(),
  filters: z
    .object({
      keywords: z.array(z.string().min(1)).optional(),
      authors: z.array(z.string().min(1)).optional(),
      kinds: z.array(z.number().int()).optional(),
      tags: z.record(z.array(z.string().min(1))).optional(),
    })
    .default({}),
});

const watchlistUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  prompt: z.string().min(3).optional(),
  active: z.boolean().optional(),
  filters: z
    .object({
      keywords: z.array(z.string().min(1)).optional(),
      authors: z.array(z.string().min(1)).optional(),
      kinds: z.array(z.number().int()).optional(),
      tags: z.record(z.array(z.string().min(1))).optional(),
      since: z.number().int().optional(),
      limit: z.number().int().optional(),
    })
    .optional(),
});

const insightQuerySchema = z.object({
  watchlistId: z.string().optional(),
  sinceMinutes: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

const bridgeQuerySchema = z.object({
  query: z.string().min(2),
  sinceMinutes: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

export interface RuntimeMeta {
  startTime: Date;
  aiProvider: string;
  aiModel: string;
  relayCount: number;
  aiQueuePending: () => number;
  aiQueueShed: () => number;
}

export function createApp(
  deps: {
    watchlistRepo: WatchlistRepository;
    processingRepo: ProcessingRepository;
    eventBus: EventBus;
    runtimeMeta: RuntimeMeta;
    onWatchlistsChanged?: () => void;
  },
  fastifyOptions?: FastifyServerOptions,
): FastifyInstance {
  const app = Fastify(fastifyOptions);

  // Serve the dashboard SPA
  app.register(fastifyStatic, {
    root: path.join(__dirname, "..", "public"),
    prefix: "/",
    decorateReply: false,
  });

  // ── Health ──────────────────────────────────────────────────────────────────

  app.get("/health", async () => ({
    status: "ok",
    watchlists: deps.watchlistRepo.list().length,
  }));

  // ── Stats ───────────────────────────────────────────────────────────────────

  app.get("/api/stats", async () => {
    const dbStats = deps.processingRepo.getStats();
    const uptimeMs = Date.now() - deps.runtimeMeta.startTime.getTime();

    return {
      uptime: uptimeMs,
      aiProvider: deps.runtimeMeta.aiProvider,
      aiModel: deps.runtimeMeta.aiModel,
      relayCount: deps.runtimeMeta.relayCount,
      aiQueuePending: deps.runtimeMeta.aiQueuePending(),
      aiQueueShed: deps.runtimeMeta.aiQueueShed(),
      ...dbStats,
    };
  });

  // ── Watchlists ───────────────────────────────────────────────────────────────

  app.get("/api/watchlists", async () => ({
    data: deps.watchlistRepo.list(),
  }));

  // keep legacy path working
  app.get("/watchlists", async () => ({
    data: deps.watchlistRepo.list(),
  }));

  app.post(
    "/api/watchlists",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = watchlistCreateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const filters = parsed.data.filters as WatchlistFilter;
      const watchlist = deps.watchlistRepo.create({
        name: parsed.data.name,
        prompt: parsed.data.prompt,
        active: parsed.data.active,
        filters,
      });
      deps.onWatchlistsChanged?.();
      return reply.status(201).send({ data: watchlist });
    },
  );

  // keep legacy path
  app.post(
    "/watchlists",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = watchlistCreateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const filters = parsed.data.filters as WatchlistFilter;
      const watchlist = deps.watchlistRepo.create({
        name: parsed.data.name,
        prompt: parsed.data.prompt,
        active: parsed.data.active,
        filters,
      });
      deps.onWatchlistsChanged?.();
      return reply.status(201).send({ data: watchlist });
    },
  );

  app.patch(
    "/api/watchlists/:id",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsedBody = watchlistUpdateSchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.status(400).send({ error: parsedBody.error.flatten() });
      }
      const params = request.params as { id?: string };
      if (!params.id) {
        return reply.status(400).send({ error: "missing watchlist id" });
      }
      const updated = deps.watchlistRepo.update(params.id, parsedBody.data);
      if (!updated) {
        return reply.status(404).send({ error: "watchlist not found" });
      }
      deps.onWatchlistsChanged?.();
      return { data: updated };
    },
  );

  app.delete(
    "/api/watchlists/:id",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { id?: string };
      if (!params.id) {
        return reply.status(400).send({ error: "missing watchlist id" });
      }
      const deleted = deps.watchlistRepo.remove(params.id);
      if (!deleted) {
        return reply.status(404).send({ error: "watchlist not found" });
      }
      deps.onWatchlistsChanged?.();
      return reply.status(204).send();
    },
  );

  // keep legacy path
  app.patch(
    "/watchlists/:id",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsedBody = watchlistUpdateSchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.status(400).send({ error: parsedBody.error.flatten() });
      }
      const params = request.params as { id?: string };
      if (!params.id) {
        return reply.status(400).send({ error: "missing watchlist id" });
      }
      const updated = deps.watchlistRepo.update(params.id, parsedBody.data);
      if (!updated) {
        return reply.status(404).send({ error: "watchlist not found" });
      }
      deps.onWatchlistsChanged?.();
      return { data: updated };
    },
  );

  // ── Insights ─────────────────────────────────────────────────────────────────

  app.get("/api/insights", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = insightQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    return { data: deps.processingRepo.listInsights(parsed.data) };
  });

  // keep legacy path
  app.get("/insights", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = insightQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    return { data: deps.processingRepo.listInsights(parsed.data) };
  });

  // ── Bridge / search ──────────────────────────────────────────────────────────

  app.post(
    "/bridge/query",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = bridgeQuerySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const hits = deps.processingRepo.queryInsightsByText(parsed.data);
      return { query: parsed.data.query, count: hits.length, data: hits };
    },
  );

  // ── Admin ────────────────────────────────────────────────────────────────────

  app.post("/admin/wipe-processed", async () => {
    const deleted = deps.processingRepo.wipeProcessedEvents();
    return { deleted };
  });

  // ── SSE — live event stream ──────────────────────────────────────────────────

  app.get("/api/events/stream", async (request, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("Access-Control-Allow-Origin", "*");
    reply.raw.flushHeaders();

    // Initial ping so the browser knows the connection is live
    reply.raw.write(":ok\n\n");

    const heartbeat = setInterval(() => {
      reply.raw.write(":ping\n\n");
    }, 20_000);

    const cleanup = deps.eventBus.onPipelineEvent((payload) => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    });

    await new Promise<void>((resolve) => {
      request.raw.on("close", resolve);
      request.raw.on("error", resolve);
    });

    clearInterval(heartbeat);
    cleanup();
  });

  return app;
}

