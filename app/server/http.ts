import type { StoreError } from './order-store.ts';

export async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  const body: unknown = await request.json().catch(() => undefined);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
}

export function errorResponse(error: StoreError): Response {
  return Response.json({ error: error.error }, { status: error.status });
}

export function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}
