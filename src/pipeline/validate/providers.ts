// Per-role inference provider (D-65) and A6/D-47 family independence.

import {
  createClient,
  PINNED_BASE_URL,
  PINNED_MODEL,
  SECOND_CODER_MODEL,
  type FetchImpl,
} from "../coding/nebius-client.ts";
import { CONFIRMER_MODEL } from "../confirm/confirm.ts";
import { SCREENER_MODEL } from "../select/screen-model.ts";

export const OLLAMA_BASE_URL = "http://localhost:11434";

export type RoleName = "gold" | "auditor" | "gatherer";

export interface RoleSpec {
  provider: "ollama" | "token-factory";
  model: string;
  /** string → reasoning_effort / think; boolean → Ollama think / chat_template_kwargs */
  reasoning: "low" | "medium" | "high" | boolean;
}

/** Gold re-pinned in plan 04-02 Task 2 from spikes/gold-labeller.md. */
export const ROLE_CONFIG: Record<RoleName, RoleSpec> = {
  gold: { provider: "ollama", model: "glm-5.3:cloud", reasoning: "low" },
  auditor: { provider: "ollama", model: "kimi-k3:cloud", reasoning: true },
  gatherer: { provider: "ollama", model: "kimi-k3:cloud", reasoning: true },
};

const FAMILY_NAMES = ["deepseek", "nemotron", "qwen", "glm", "kimi", "gemma", "llama"] as const;

export function familyOf(model: string): string {
  const lower = model.toLowerCase();
  for (const f of FAMILY_NAMES) {
    if (lower.includes(f)) return f;
  }
  const slash = lower.indexOf("/");
  return slash >= 0 ? lower.slice(0, slash) : lower;
}

export function assertIndependent(role: RoleName, model: string): void {
  const fam = familyOf(model);
  if (role === "gold") {
    for (const banned of [PINNED_MODEL, SECOND_CODER_MODEL, CONFIRMER_MODEL, SCREENER_MODEL]) {
      if (fam === familyOf(banned)) throw new Error(`A6: gold labeller family ${fam} overlaps ${banned}`);
    }
    return;
  }
  if (fam === familyOf(SCREENER_MODEL)) throw new Error(`A6: ${role} family ${fam} overlaps screener`);
  if (fam === familyOf(ROLE_CONFIG.gold.model)) throw new Error(`A6: ${role} family ${fam} overlaps gold labeller`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Translate an OpenAI-style chat body into Ollama /api/chat; return OpenAI-shaped json. */
export function ollamaClient({
  baseUrl = OLLAMA_BASE_URL,
  fetchImpl = fetch,
  maxRetries = 3,
}: {
  baseUrl?: string;
  fetchImpl?: FetchImpl;
  maxRetries?: number;
} = {}) {
  async function request(
    _path: string,
    { method = "POST", body }: { method?: string; body?: any } = {},
  ): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
    if (!body?.model || !body?.messages) throw new Error("ollamaClient: body.model and body.messages required");
    const rf = body.response_format;
    const format =
      rf?.type === "json_schema" ? rf.json_schema?.schema : rf?.type === "json_object" ? "json" : undefined;
    const think =
      body.reasoning_effort !== undefined
        ? body.reasoning_effort
        : body.chat_template_kwargs?.enable_thinking;
    const ollamaBody = {
      model: body.model,
      messages: body.messages,
      stream: false,
      ...(format !== undefined ? { format } : {}),
      ...(think !== undefined ? { think } : {}),
      options: {
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        ...(body.max_tokens !== undefined ? { num_predict: body.max_tokens } : {}),
      },
    };
    for (let attempt = 1; ; attempt += 1) {
      const res = await fetchImpl(`${baseUrl}/api/chat`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ollamaBody),
      });
      const text = await res.text();
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (res.status === 429 && attempt <= maxRetries) {
        await sleep(400 * attempt);
        continue;
      }
      const content = parsed?.message?.content ?? "";
      const finish = parsed?.done_reason ?? (parsed?.done ? "stop" : undefined);
      return {
        ok: res.ok,
        status: res.status,
        text,
        json: { choices: [{ message: { content }, finish_reason: finish }] },
      };
    }
  }
  return { request };
}

export function roleClient(
  role: RoleName,
  {
    nebiusKey,
    fetchImpl,
    roleSpec,
  }: { nebiusKey?: string; fetchImpl?: FetchImpl; roleSpec?: RoleSpec } = {},
) {
  const spec = roleSpec ?? ROLE_CONFIG[role];
  if (!spec) throw new Error(`unknown role: ${role}`);
  if (spec.model === "openrouter/free") throw new Error("D-65: openrouter/free is never a valid model");
  assertIndependent(role, spec.model);
  if (spec.provider === "token-factory") {
    if (!nebiusKey) throw new Error("token-factory role needs nebiusKey");
    return createClient({ baseUrl: PINNED_BASE_URL, apiKey: nebiusKey, fetchImpl });
  }
  return ollamaClient({ fetchImpl });
}
