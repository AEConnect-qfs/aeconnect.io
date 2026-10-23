/**
 * Swappable LLM client. Callers depend on this interface, not on a vendor SDK.
 *
 * Provider selection (first match):
 *   LLM_PROVIDER=mock                deterministic draft, no network
 *   LLM_PROVIDER=anthropic           Claude
 *   LLM_PROVIDER=openai-compatible   any /v1/chat/completions host (Ollama, vLLM, hosted)
 *   LLM_PROVIDER unset               anthropic when ANTHROPIC_API_KEY is set, otherwise mock
 *
 * ANTHROPIC_API_KEY and ANTHROPIC_MODEL keep working when the LLM_* vars are unset,
 * so an existing Netlify deploy stays on Claude.
 */

import Anthropic from '@anthropic-ai/sdk';

export class AssessmentError extends Error {
  readonly kind: 'invalid_draft' | 'provider';
  /** Operator-facing detail. Never send this string to the browser. */
  readonly detail: string;
  constructor(kind: 'invalid_draft' | 'provider', detail: string) {
    super(kind === 'invalid_draft' ? 'Invalid assessment draft' : 'Assessment provider failed');
    this.name = 'AssessmentError';
    this.kind = kind;
    this.detail = detail;
  }
}

export type ProviderName = 'mock' | 'anthropic' | 'openai-compatible';

export interface LlmConfig {
  provider: ProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens: number;
}

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  jsonSchema?: Record<string, unknown>;
}

export interface LlmResult {
  text: string;
  model: string;
  truncated: boolean;
}

export interface LlmClient {
  readonly provider: ProviderName;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResult>;
}

/** Default Claude model. Override with LLM_MODEL or ANTHROPIC_MODEL. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5';
export const MOCK_MODEL_ID = 'mock-dev-0';

/**
 * Output budget for Claude. Current Sonnet models spend part of max_tokens on
 * adaptive thinking before the JSON, so a 3k cap can truncate the draft.
 * 16k leaves room for that thinking plus the assessment object. A response that
 * still stops on max_tokens is rejected rather than parsed as a partial draft.
 */
export const ANTHROPIC_MAX_TOKENS = 16_000;

/** JSON drafts are a few thousand tokens. Kept under typical small-model context. */
export const OPENAI_COMPAT_MAX_TOKENS = 4_096;

const REQUEST_TIMEOUT_MS = 55_000;

export function resolveLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const requested = (env.LLM_PROVIDER || '').trim().toLowerCase();
  const anthropicKey = (env.ANTHROPIC_API_KEY || '').trim();
  const llmKey = (env.LLM_API_KEY || '').trim();
  const llmModel = (env.LLM_MODEL || '').trim();
  const anthropicModel = (env.ANTHROPIC_MODEL || '').trim();

  const provider = requested ? parseProvider(requested) : anthropicKey ? 'anthropic' : 'mock';

  if (provider === 'mock') {
    return { provider, model: MOCK_MODEL_ID, maxTokens: 0 };
  }

  if (provider === 'anthropic') {
    const apiKey = anthropicKey || llmKey;
    if (!apiKey) {
      throw new AssessmentError('provider', 'Anthropic provider requires ANTHROPIC_API_KEY or LLM_API_KEY');
    }
    return {
      provider,
      model: llmModel || anthropicModel || DEFAULT_ANTHROPIC_MODEL,
      apiKey,
      maxTokens: ANTHROPIC_MAX_TOKENS,
    };
  }

  const baseUrl = (env.LLM_BASE_URL || '').trim().replace(/\/$/, '');
  if (!baseUrl) {
    throw new AssessmentError('provider', 'openai-compatible provider requires LLM_BASE_URL');
  }
  if (!llmModel) {
    throw new AssessmentError('provider', 'openai-compatible provider requires LLM_MODEL');
  }
  return {
    provider,
    model: llmModel,
    apiKey: llmKey || undefined,
    baseUrl,
    maxTokens: OPENAI_COMPAT_MAX_TOKENS,
  };
}

export function createLlmClient(config: LlmConfig): LlmClient {
  if (config.provider === 'anthropic') return new AnthropicClient(config);
  if (config.provider === 'openai-compatible') return new OpenAICompatibleClient(config);
  throw new AssessmentError('provider', `No remote client for provider ${config.provider}`);
}

function parseProvider(value: string): ProviderName {
  if (value === 'mock' || value === 'anthropic' || value === 'openai-compatible') return value;
  throw new AssessmentError('provider', `Unknown LLM_PROVIDER "${value}"`);
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new SyntaxError('Model output was not JSON');
  }
}

class AnthropicClient implements LlmClient {
  readonly provider = 'anthropic' as const;
  readonly model: string;
  private readonly apiKey: string;
  constructor(private readonly config: LlmConfig) {
    this.model = config.model;
    this.apiKey = config.apiKey || '';
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const anthropic = new Anthropic({ apiKey: this.apiKey, timeout: REQUEST_TIMEOUT_MS });
    try {
      const msg = await anthropic.messages.create({
        model: this.model,
        // Thinking tokens on current Claude models count toward this budget.
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      });
      if (msg.stop_reason === 'refusal') {
        throw new AssessmentError('invalid_draft', 'Model refused to draft an assessment');
      }
      const textBlock = msg.content.find((b) => b.type === 'text');
      const text = textBlock && textBlock.type === 'text' ? textBlock.text : '';
      if (!text.trim()) {
        throw new AssessmentError('invalid_draft', 'Model response had no text block');
      }
      return {
        text,
        model: msg.model || this.model,
        truncated: msg.stop_reason === 'max_tokens',
      };
    } catch (err) {
      if (err instanceof AssessmentError) throw err;
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      const message = err instanceof Error ? err.message : String(err);
      throw new AssessmentError(
        'provider',
        `Anthropic request failed${status ? ` (${status})` : ''}: ${message.slice(0, 300)}`,
      );
    }
  }
}

class OpenAICompatibleClient implements LlmClient {
  readonly provider = 'openai-compatible' as const;
  readonly model: string;
  constructor(private readonly config: LlmConfig) {
    this.model = config.model;
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const url = `${this.config.baseUrl}/chat/completions`;
    // Prefer JSON-schema mode so small local models stay inside the enums.
    // Hosts that reject response_format are retried down to plain text.
    const modes: Array<'schema' | 'json' | 'plain'> = req.jsonSchema ? ['schema', 'json', 'plain'] : ['json', 'plain'];
    let response: Response | undefined;
    try {
      for (const mode of modes) {
        response = await this.post(url, req, mode);
        if (response.ok) break;
        if (response.status !== 400 || mode === 'plain') break;
        const probe = await response.clone().text();
        if (!/response_format|json_schema|unsupported/i.test(probe)) break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AssessmentError('provider', `OpenAI-compatible request failed: ${message.slice(0, 300)}`);
    }
    if (!response) {
      throw new AssessmentError('provider', 'OpenAI-compatible request produced no response');
    }

    if (!response.ok) {
      const body = await response.text();
      throw new AssessmentError(
        'provider',
        `OpenAI-compatible request failed (${response.status}): ${body.slice(0, 300)}`,
      );
    }

    let payload: OpenAIChatResponse;
    try {
      payload = (await response.json()) as OpenAIChatResponse;
    } catch {
      throw new AssessmentError('invalid_draft', 'OpenAI-compatible response was not JSON');
    }

    const choice = payload.choices?.[0];
    const text = messageText(choice?.message?.content);
    if (!text.trim()) {
      throw new AssessmentError('invalid_draft', 'Model response had no message content');
    }
    return {
      text,
      model: payload.model || this.model,
      truncated: choice?.finish_reason === 'length',
    };
  }

  private post(url: string, req: LlmRequest, mode: 'schema' | 'json' | 'plain'): Promise<Response> {
    const body: Record<string, unknown> = {
      model: this.model,
      temperature: 0,
      max_tokens: req.maxTokens,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    };
    if (mode === 'schema' && req.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'assessment_draft', strict: true, schema: req.jsonSchema },
      };
    } else if (mode === 'json') {
      body.response_format = { type: 'json_object' };
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    return fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }
}

interface OpenAIChatResponse {
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: unknown };
  }>;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text;
      return '';
    })
    .join('');
}
