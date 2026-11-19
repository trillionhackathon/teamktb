import { badRequest, errorResponse, readJson } from '../../server/http.ts';
import { getOrderStore } from '../../server/store-instance.ts';

// 매장 상황·라이더 메시지 입력. event_id가 같으면 다시 처리하지 않는다(INV-03).
export async function POST(request: Request) {
  const body = await readJson(request);
  if (!body) return badRequest('JSON 본문이 필요해요.');
  if (body.order_id !== undefined && (typeof body.order_id !== 'string' || !/^#\d{1,6}$/.test(body.order_id))) return badRequest("order_id는 '#101' 형식이어야 해요.");
  const result = getOrderStore().addEvent({
    event_id: body.event_id as string,
    raw_text: body.raw_text as string,
    order_id: body.order_id as string | undefined,
  });
  if ('error' in result) return errorResponse(result);
  return Response.json(result, { status: result.duplicate ? 200 : 201 });
}
