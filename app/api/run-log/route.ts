import { badRequest } from '../../server/http.ts';
import { formatRunLog } from '../../server/run-log.ts';
import { getOrderStore } from '../../server/store-instance.ts';

export const dynamic = 'force-dynamic';

// 에이전트 실행 로그(본 것 → 판단 → 행동).
// ?scenario=SC-N: 그 시나리오의 마지막 실행, ?run=3: 3번째 실행, 없으면 지금 실행. ?format=text면 사람이 읽는 줄 형식.
export function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const runParam = params.get('run');
  const run = runParam === null ? undefined : Number(runParam);
  if (run !== undefined && !Number.isSafeInteger(run)) return badRequest('run은 정수여야 해요.');
  const entries = getOrderStore().runLogEntries({ run, scenario: params.get('scenario') ?? undefined });
  if (params.get('format') === 'text') {
    return new Response(`${formatRunLog(entries)}\n`, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
  return Response.json({ run: entries[0]?.run ?? null, scenario: entries[0]?.scenario ?? null, entries });
}
