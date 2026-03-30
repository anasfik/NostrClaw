import type { AiProvider } from "../../contracts";
import type { AppLogger } from "../../logger";
import type { AiDecision, AiEvaluationInput } from "../../types";

export class FallbackAiProvider implements AiProvider {
  constructor(
    private readonly providers: Array<{
      name: string;
      provider: AiProvider;
    }>,
    private readonly logger: AppLogger,
  ) {}

  async evaluate(input: AiEvaluationInput): Promise<AiDecision> {
    let lastError: unknown;

    for (let i = 0; i < this.providers.length; i += 1) {
      const candidate = this.providers[i];

      if (i > 0) {
        this.logger.warn(
          { provider: candidate.name, position: i + 1 },
          "ai-provider:fallback:trying-next",
        );
      }

      try {
        return await candidate.provider.evaluate(input);
      } catch (error) {
        lastError = error;
        this.logger.warn(
          {
            provider: candidate.name,
            error,
          },
          "ai-provider:fallback:provider-failed",
        );
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }

    throw new Error("All configured AI providers failed");
  }
}
