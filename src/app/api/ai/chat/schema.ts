/**
 * Structured-output schemas for the nl2sql AI route.
 *
 * Passed to the LLM provider via `LLMStreamOptions.jsonSchema` to constrain the
 * response to valid JSON. Currently honored by the Anthropic provider.
 */

import type { JSONSchema } from '@/lib/llm';

export const SQL_ONLY_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    sql: {
      type: 'string',
      description: 'The generated SQL statement. Must include semicolon.',
    }
  },
  required: ['sql'],
  additionalProperties: false,
};
