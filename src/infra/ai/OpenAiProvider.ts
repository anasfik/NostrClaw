import OpenAI from "openai";
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

export class OpenAiProvider implements AiProvider {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new OpenAI({ apiKey });
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
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) },
      ],
    });

    const text = completion.choices[0]?.message?.content?.trim();
    if (!text) return { notify: false };

    try {
      const parsed = JSON.parse(text) as AiDecision;
      if (typeof parsed.notify !== "boolean") return { notify: false };
      return parsed;
    } catch {
      return { notify: false };
    }
  }
}
