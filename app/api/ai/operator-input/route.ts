import { parseIntentResult } from '../../../ai/contract';
import { forwardToAiServer, toJsonResponse } from '../../../ai/server-proxy';

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => undefined);
  const text = typeof body === 'object' && body && 'text' in body && typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 500) return Response.json({ error: 'text는 1~500자여야 해요.' }, { status: 400 });
  return toJsonResponse(await forwardToAiServer('/ai/operator-input', { text }, parseIntentResult));
}
