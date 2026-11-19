// Next.js 서버에서만 쓴다. 브라우저는 aiserver 주소를 모르고 /api/ai/* 로만 요청한다.
export type ProxyResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

const defaultTimeoutMs = 1500;

export async function forwardToAiServer<T>(path: string, body: unknown, parse: (value: unknown) => T | undefined): Promise<ProxyResult<T>> {
  const baseUrl = process.env.AISERVER_URL?.trim();
  if (!baseUrl) return { ok: false, status: 503, error: 'AISERVER_URL이 설정되지 않았어요.' };

  const timeoutMs = Number(process.env.AISERVER_TIMEOUT_MS) || defaultTimeoutMs;
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
    console.warn(`[aiserver] ${path} ${timedOut ? 'timeout' : 'request failed'}`, error);
    return { ok: false, status: timedOut ? 504 : 502, error: timedOut ? `AI 서버가 ${timeoutMs}ms 안에 응답하지 않았어요.` : 'AI 서버에 연결하지 못했어요.' };
  }

  if (!response.ok) {
    console.warn(`[aiserver] ${path} responded ${response.status}`, await response.text().catch(() => ''));
    return { ok: false, status: 502, error: `AI 서버가 ${response.status} 오류를 반환했어요.` };
  }

  const data = parse(await response.json().catch(() => undefined));
  if (!data) {
    console.warn(`[aiserver] ${path} returned a response outside the contract`);
    return { ok: false, status: 502, error: 'AI 서버 응답이 계약 형식과 달라요.' };
  }
  return { ok: true, data };
}

export function toJsonResponse<T>(result: ProxyResult<T>): Response {
  return result.ok ? Response.json(result.data) : Response.json({ error: result.error }, { status: result.status });
}
