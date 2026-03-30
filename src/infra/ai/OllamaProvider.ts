import type { AiProvider } from "../../contracts";
import type { AiDecision, AiEvaluationInput } from "../../types";

const OUTPUT_INSTRUCTION =
  'Return strict JSON only: {"notify": boolean, "message": string, "actionable_link": string, "recommended_actions": string[], "match_score": number}. If no signal, return {"notify": false}.';

function buildSystemPrompt(): string {
  return [
    "You are NostrMind, a strict Nostr event classification gate.",
    "Your ONLY job is to decide whether a Nostr event matches the user's watchlist_prompt.",
    "RULES — you must follow ALL of them:",
    "1. Set notify=true ONLY if the event clearly and directly satisfies the watchlist_prompt. When in doubt, set notify=false.",
    "2. The watchlist_prompt is the absolute authority. Do NOT broaden, relax, or reinterpret it. Do NOT notify for loosely related or tangentially relevant content.",
    "3. Reject all spam, bot output, low-effort reposts, ads, and off-topic chatter regardless of other signals.",
    "4. Ignore event metadata (pubkey, tags, kind) unless the watchlist_prompt explicitly references them.",
    "5. match_score must reflect strict adherence to watchlist_prompt: 0.9-1.0 = exact match, 0.5-0.89 = partial match, below 0.5 = set notify=false.",
    "6. Never fabricate facts. message should summarise why the event matches the prompt.",
    OUTPUT_INSTRUCTION,
  ].join(" ");
}

interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  system?: string;
  stream: boolean;
  format?: string;
  options?: {
    temperature?: number;
    num_ctx?: number;
  };
}

interface OllamaGenerateResponse {
  model: string;
  response: string;
  done: boolean;
}

/**
 * Ollama AI Provider for local LLM inference.
 * Supports any model available in your local Ollama instance.
 * Zero API costs, full privacy, works offline.
 */
export class OllamaProvider implements AiProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
  ) {
    // Normalize baseUrl to remove trailing slash
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async evaluate(input: AiEvaluationInput): Promise<AiDecision> {
    const system = buildSystemPrompt();

    const user = {
      watchlist_name: input.watchlist.name,
      watchlist_prompt: input.watchlist.prompt,
      watchlist_filters: input.watchlist.filters,
      event: {
        id: input.event.id,
        pubkey: input.event.pubkey,
        kind: input.event.kind,
        created_at: input.event.created_at,
        tags: input.event.tags,
        content: input.event.content,
      },
    };

    const request: OllamaGenerateRequest = {
      model: this.model,
      prompt: JSON.stringify(user),
      system,
      stream: false,
      format: "json",
      options: {
        temperature: 0,
        num_ctx: 4096, // Context window size
      },
    };

    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
      }

      const data = (await response.json()) as OllamaGenerateResponse;
      const text = data.response?.trim();

      if (!text) return { notify: false };

      try {
        const parsed = JSON.parse(text) as AiDecision;
        if (typeof parsed.notify !== "boolean") return { notify: false };
        return parsed;
      } catch {
        // If JSON parsing fails, treat as no match
        return { notify: false };
      }
    } catch (error) {
      // Network errors, connection refused, etc.
      throw new Error(
        `Ollama provider failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Check if Ollama instance is reachable and model is available.
   * Call this during initialization to fail fast if Ollama is not ready.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: "GET",
      });

      if (!response.ok) return false;

      const data = (await response.json()) as {
        models: Array<{ name: string }>;
      };
      const modelExists = data.models.some((m) =>
        m.name.startsWith(this.model),
      );

      return modelExists;
    } catch {
      return false;
    }
  }
}
