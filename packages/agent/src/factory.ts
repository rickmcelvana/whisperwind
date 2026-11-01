/**
 * Build a provider from configuration. The only place a provider kind is turned into
 * an implementation, so adding a provider touches one file.
 */

import type { Provider, ProviderConfig } from "./provider.ts";
import { OllamaProvider } from "./ollama.ts";
import { OpenAIProvider } from "./openai.ts";

export function createProvider(config: ProviderConfig): Provider {
  switch (config.kind) {
    case "ollama":
      return new OllamaProvider({ baseUrl: config.baseUrl });
    case "openai":
      return new OpenAIProvider(config);
    default: {
      const never: never = config.kind;
      throw new Error(`unknown provider kind: ${String(never)}`);
    }
  }
}
