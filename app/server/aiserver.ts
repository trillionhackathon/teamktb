import { parseDecideResult, parseIntentResult, type AiStoreState, type DecideResult, type IntentResult } from '../ai/contract.ts';

// Next.js 서버에서 aiserver(FastAPI)를 호출한다. 브라우저는 aiserver 주소를 모른다.
export type AiResult<T> = { ok: true; data: T } | { ok: false; error: string };

export type AiClient = {
  decide: (state: AiStoreState) => Promise<AiResult<DecideResult>>;
  classify: (text: string) => Promise<AiResult<IntentResult>>;
};

async function post<T>(baseUrl: string, path: string, body: unknown, timeoutMs: number, parse: (value: unknown) => T | undefined): Promise<AiResult<T>> {
  let response: Response;
  try {
    response = await fetch(new URL(path, baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    console.warn(`[aiserver] ${path} ${timedOut ? 'timeout' : 'request failed'}: ${error instanceof Error ? error.message : error}`);
    return { ok: false, error: timedOut ? `AI 서버가 ${timeoutMs}ms 안에 응답하지 않았어요.` : 'AI 서버에 연결하지 못했어요.' };
  }
  if (!response.ok) {
    console.warn(`[aiserver] ${path} responded ${response.status}: ${await response.text().catch(() => '')}`);
    return { ok: false, error: `AI 서버가 ${response.status} 오류를 반환했어요.` };
  }
  const data = parse(await response.json().catch(() => undefined));
  if (!data) {
    console.warn(`[aiserver] ${path} returned a response outside the contract`);
    return { ok: false, error: 'AI 서버 응답이 계약 형식과 달라요.' };
  }
  return { ok: true, data };
}

export function createAiClient(baseUrl: string, timeoutMs = 1500): AiClient {
  return {
    decide: (state) => post(baseUrl, '/ai/decide', state, timeoutMs, parseDecideResult),
    classify: (text) => post(baseUrl, '/ai/operator-input', { text }, timeoutMs, parseIntentResult),
  };
}

export function aiClientFromEnv(): AiClient | undefined {
  const baseUrl = process.env.AISERVER_URL?.trim();
  if (!baseUrl) return undefined;
  return createAiClient(baseUrl, Number(process.env.AISERVER_TIMEOUT_MS) || 1500);
}
