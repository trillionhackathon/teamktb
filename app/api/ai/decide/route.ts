import { isStoreState, parseDecideResult } from '../../../ai/contract';
import { forwardToAiServer, toJsonResponse } from '../../../ai/server-proxy';

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => undefined);
  if (!isStoreState(body)) return Response.json({ error: 'StoreState 형식이 아니에요.' }, { status: 400 });
  return toJsonResponse(await forwardToAiServer('/ai/decide', body, parseDecideResult));
}
