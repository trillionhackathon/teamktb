import type { QuestResult } from '../../ai/contract.ts';
import { toAiQuestState, type Prepared } from '../../client/quest-board.ts';
import { aiClientFromEnv } from '../../server/aiserver.ts';
import { badRequest, readJson } from '../../server/http.ts';
import { getOrderStore } from '../../server/store-instance.ts';

export const dynamic = 'force-dynamic';

export type QuestResponse =
  | { status: 'connected'; result: QuestResult }
  | { status: 'disabled' | 'unavailable'; error: string };

const isIdList = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length <= max && value.every((id) => typeof id === 'string' && id.length <= 20);
const isCountMap = (value: unknown): value is Record<string, number> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && Object.values(value as Record<string, unknown>).every((count) => Number.isSafeInteger(count) && (count as number) >= 0);

// 대시보드의 고정칸과 후보를 aiserver POST /ai/quest로 보내 후보 순위와 퀘스트를 받는다. 브라우저는 aiserver 주소를 모른다.
// 본문: { fixed: 주문번호[], candidates: 주문번호[], prepared: { 주문번호: { 메뉴key: 잔 수 } }, overtakes: { 주문번호: 횟수 } }
export async function POST(request: Request) {
  const body = await readJson(request);
  if (!body || !isIdList(body.fixed, 4) || !isIdList(body.candidates, 4)) return badRequest('fixed와 candidates는 주문 번호 배열(각 4개 이하)이어야 해요.');
  const prepared = body.prepared ?? {};
  if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared) || !Object.values(prepared).every(isCountMap)) return badRequest('prepared 형식이 달라요.');
  const overtakes = body.overtakes ?? {};
  if (!isCountMap(overtakes)) return badRequest('overtakes 형식이 달라요.');

  const ai = aiClientFromEnv();
  if (!ai) return Response.json({ status: 'disabled', error: 'AISERVER_URL이 설정되지 않았어요.' } satisfies QuestResponse);
  const state = toAiQuestState(getOrderStore().snapshot(), { fixed: body.fixed, candidates: body.candidates, prepared: prepared as Prepared, overtakes });
  const result = await ai.quest(state);
  return Response.json((result.ok ? { status: 'connected', result: result.data } : { status: 'unavailable', error: result.error }) satisfies QuestResponse);
}
