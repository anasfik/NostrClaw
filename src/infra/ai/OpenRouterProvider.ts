import OpenAI from "openai";
import type { AiProvider } from "../../contracts";
import type { AiDecision, AiEvaluationInput } from "../../types";

const OUTPUT_INSTRUCTION =
  'Return ONLY raw JSON, no markdown, no code blocks: {"notify": boolean, "message": string, "actionable_link": string, "recommended_actions": string[], "match_score": number}. If no signal, return {"notify": false}.';

/** Strip markdown code fences that some models add despite instructions. */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return fenced ? fenced[1].trim() : text.trim();
}

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

export class OpenRouterProvider implements AiProvider {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        // Documented optional headers for app attribution on openrouter.ai
        "HTTP-Referer": "https://github.com/nostrmind",
        "X-Title": "NostrMind",
      },
    });
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

    const completion = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      // Cap tokens — the JSON response is always small; avoids runaway costs.
      //   max_tokens: 512,
      // Tells supporting models to return valid JSON. Non-supporting models
      // ignore this per OpenRouter docs, so it is always safe to send.
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) },
      ],
    });

    const choice = completion.choices[0];
    if (choice === undefined) return { notify: false };

    // OpenRouter embeds provider-level errors inside the choice object
    // (e.g. upstream rate-limit, context-length exceeded).
    const choiceError = (choice as unknown as Record<string, unknown>).error as
      | { message?: string; code?: number }
      | undefined;
    if (choiceError) {
      throw new Error(
        `OpenRouter provider error (${choiceError.code ?? "?"}): ${choiceError.message ?? JSON.stringify(choiceError)}`,
      );
    }

    // Normalised finish reasons: "stop", "length", "tool_calls",
    // "content_filter" — skip parsing on non-stop outcomes.
    const finishReason = choice.finish_reason;
    if (finishReason === "content_filter") {
      return { notify: false };
    }

    const text = choice.message?.content?.trim();
    if (!text) return { notify: false };

    try {
      const parsed = JSON.parse(extractJson(text)) as AiDecision;
      if (parsed.notify !== true) return { notify: false };
      return parsed;
    } catch {
      return { notify: false };
    }
  }
}
