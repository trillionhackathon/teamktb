import { scenarios } from '../../domain/scenarios.ts';
import { badRequest, errorResponse, readJson } from '../../server/http.ts';
import { getOrderStore } from '../../server/store-instance.ts';

export function GET() {
  return Response.json(scenarios.map(({ id, title, source, description, expected, triggers }) => ({ id, title, source, description, expected, triggers: triggers.map(({ label }) => label) })));
}

// { scenario_id }: 시나리오 시작 상태로 저장소를 초기화한다. { scenario_id, trigger }: 그 시나리오의 n번째 입력을 재생한다.
export async function POST(request: Request) {
  const body = await readJson(request);
  if (!body || typeof body.scenario_id !== 'string') return badRequest('scenario_id가 필요해요.');
  const store = getOrderStore();
  if (body.trigger === undefined) {
    const error = store.loadScenario(body.scenario_id);
    return error ? errorResponse(error) : Response.json(store.snapshot());
  }
  if (!Number.isSafeInteger(body.trigger)) return badRequest('trigger는 정수여야 해요.');
  const error = await store.runTrigger(body.scenario_id, body.trigger as number);
  return error ? errorResponse(error) : Response.json(store.snapshot());
}
