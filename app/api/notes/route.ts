import { badRequest, errorResponse, readJson } from '../../server/http.ts';
import { getOrderStore } from '../../server/store-instance.ts';

export const dynamic = 'force-dynamic';

// 빠른 주문 카드의 "내보냈어요": { note_id }(quick:#번호). 그 주문을 완료한다. 1번 카드의 완료는 주문 완료 API(PATCH /api/orders/번호)를 쓴다.
export async function POST(request: Request) {
  const body = await readJson(request);
  if (typeof body?.note_id !== 'string' || body.note_id.length > 80) return badRequest('note_id가 필요해요.');
  const result = getOrderStore().handleNote(body.note_id);
  return 'error' in result ? errorResponse(result) : Response.json(result);
}
