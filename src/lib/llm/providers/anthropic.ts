/**
 * Anthropic LLM Provider
 * Anthropic Messages API with SSE streaming
 */

import { BaseLLMProvider } from '../base-provider';
import {
  type LLMConfig,
  type LLMStreamOptions,
  LLMAuthError,
  LLMRateLimitError,
  LLMStreamError,
} from '../types';
import { createStreamFromSSEResponse } from '../utils/streaming';
import { DEFAULT_API_URLS } from '../utils/config';
import { logger } from '@/lib/logger';

// ============================================================================
// Anthropic Provider
// ============================================================================

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

export class AnthropicProvider extends BaseLLMProvider {
  protected baseUrl: string;

  constructor(config: LLMConfig) {
    super(config);
    this.validate();
    this.baseUrl = config.apiUrl ?? DEFAULT_API_URLS.anthropic;
  }

  /**
   * Stream completion from Anthropic
   */
  public async stream(options: LLMStreamOptions): Promise<ReadableStream<Uint8Array>> {
    return this.streamWithRetry(async () => {
      const model = this.getModel(options);
      const system = this.getSystemMessage(options);
      const messages = this.getNonSystemMessages(options);

      try {
        const response = await this.fetchStream(model, system, messages, options);
        await this.validateResponse(response);

        return createStreamFromSSEResponse(response, this.name);
      } catch (error) {
        if (error instanceof LLMAuthError || error instanceof LLMRateLimitError) {
          throw error;
        }
        throw this.mapError(error);
      }
    });
  }

  /**
   * Fetch streaming response from Anthropic Messages API
   */
  protected async fetchStream(
    model: string,
    system: string | undefined,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    options: LLMStreamOptions
  ): Promise<Response> {
    const apiKey = this.ensureApiKey();

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(system !== undefined && { system }),
        ...(options.temperature !== undefined && { temperature: options.temperature }),
        ...(options.jsonSchema !== undefined && {
          output_config: {
            format: {
              type: 'json_schema',
              schema: options.jsonSchema,
            },
          },
        }),
      }),
    });

    return response;
  }

  /**
   * Validate response status and throw appropriate errors
   */
  protected async validateResponse(response: Response): Promise<void> {
    if (response.ok) {
      return;
    }

    let errorMessage = `HTTP ${response.status}`;

    try {
      const errorBody = await response.text();
      const errorJson = JSON.parse(errorBody);
      errorMessage = errorJson.error?.message ?? errorBody;
    } catch {
      logger.debug('Could not parse error response body as JSON', { provider: 'anthropic' });
    }

    if (response.status === 401 || response.status === 403) {
      throw new LLMAuthError(
        'Invalid API Key. Please check your Anthropic API configuration.',
        'anthropic'
      );
    }

    if (response.status === 429) {
      throw new LLMRateLimitError(
        'Rate limit exceeded. Please try again later or upgrade your plan.',
        'anthropic'
      );
    }

    throw new LLMStreamError(`Anthropic API error: ${errorMessage}`, 'anthropic');
  }

  /**
   * Map errors to LLM error types
   */
  protected mapError(error: unknown): Error {
    if (!(error instanceof Error)) {
      return new LLMStreamError(String(error), 'anthropic');
    }

    const message = error.message.toLowerCase();

    // Network errors
    if (message.includes('fetch') || message.includes('network')) {
      return new LLMStreamError(
        'Network error. Please check your connection.',
        'anthropic'
      );
    }

    return new LLMStreamError(error.message, 'anthropic');
  }
}
