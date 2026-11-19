import { demoFeedStatus, startDemoFeed, stopDemoFeed } from '../../server/demo-feed.ts';
import { badRequest, readJson } from '../../server/http.ts';
import { getOrderStore } from '../../server/store-instance.ts';

export const dynamic = 'force-dynamic';

// 시연용 자동 주문 상태: { running, created, last_error? }
export function GET() {
  return Response.json(demoFeedStatus());
}

// 자동 주문 켜기/끄기: { running: boolean }
export async function POST(request: Request) {
  const body = await readJson(request);
  if (typeof body?.running !== 'boolean') return badRequest('running은 true 또는 false여야 해요.');
  return Response.json(body.running ? startDemoFeed(getOrderStore()) : stopDemoFeed());
}
