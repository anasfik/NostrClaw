import { describe, expect, it, vi } from "vitest";
import { FallbackAiProvider } from "../src/infra/ai/FallbackAiProvider";
import type { AiProvider } from "../src/contracts";
import type { AiEvaluationInput } from "../src/types";

const input: AiEvaluationInput = {
  watchlist: {
    id: "wl-1",
    name: "Test",
    prompt: "Find signal",
    filters: {},
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  event: {
    id: "evt-1",
    pubkey: "pubkey-1",
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [],
    content: "hello",
  },
};

describe("FallbackAiProvider", () => {
  it("uses the next provider when the first one fails", async () => {
    const first: AiProvider = {
      evaluate: vi.fn(async () => {
        throw new Error("provider down");
      }),
    };

    const second: AiProvider = {
      evaluate: vi.fn(async () => ({ notify: true, message: "matched" })),
    };

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const provider = new FallbackAiProvider(
      [
        { name: "openai", provider: first },
        { name: "openrouter", provider: second },
      ],
      logger,
    );

    const result = await provider.evaluate(input);

    expect(result.notify).toBe(true);
    expect(first.evaluate).toHaveBeenCalledTimes(1);
    expect(second.evaluate).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("throws when all configured providers fail", async () => {
    const failing: AiProvider = {
      evaluate: vi.fn(async () => {
        throw new Error("all down");
      }),
    };

    const provider = new FallbackAiProvider(
      [
        { name: "openai", provider: failing },
        { name: "gemini", provider: failing },
      ],
      {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    );

    await expect(provider.evaluate(input)).rejects.toThrow("all down");
  });
});
