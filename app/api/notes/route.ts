import { badRequest, errorResponse, readJson } from '../../server/http.ts';
import { getOrderStore } from '../../server/store-instance.ts';

export const dynamic = 'force-dynamic';

// 제조 작업(task:)은 메뉴 줄만, 빠른 주문(quick:)은 주문 전체를 완료한다.
export async function POST(request: Request) {
  const body = await readJson(request);
  if (typeof body?.note_id !== 'string' || body.note_id.length > 200) return badRequest('note_id가 필요해요.');
  const result = getOrderStore().handleNote(body.note_id);
  return 'error' in result ? errorResponse(result) : Response.json(result);
}
