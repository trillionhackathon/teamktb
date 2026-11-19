// 브라우저에서 Next.js API를 호출한다. 실패하면 서버가 준 오류 문구를 그대로 돌려준다.
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

export async function callApi<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  try {
    const response = await fetch(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
    });
    if (response.status === 204) return { ok: true, data: undefined as T };
    const data: unknown = await response.json().catch(() => undefined);
    if (response.ok) return { ok: true, data: data as T };
    const error = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : `요청 실패 (${response.status})`;
    return { ok: false, error, status: response.status };
  } catch {
    return { ok: false, error: '서버에 연결하지 못했어요.', status: 0 };
  }
}

export function createRequestId(prefix: string): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

export function orderPath(orderId: string): string {
  return `/api/orders/${orderId.replace(/^#/, '')}`;
}
