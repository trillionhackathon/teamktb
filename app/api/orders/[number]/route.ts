import { badRequest, errorResponse, readJson } from '../../../server/http.ts';
import { getOrderStore } from '../../../server/store-instance.ts';

// 주문 상태 변경: { action: 'start' | 'complete' }. 경로의 번호는 #를 뺀 주문 번호다(/api/orders/108).
export async function PATCH(request: Request, { params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  if (!/^\d{1,6}$/.test(number)) return badRequest('주문 번호는 숫자여야 해요.');
  const body = await readJson(request);
  const action = body?.action;
  if (action !== 'start' && action !== 'complete') return badRequest("action은 'start' 또는 'complete'여야 해요.");
  const result = getOrderStore().updateOrderStatus(`#${number}`, action);
  return 'error' in result ? errorResponse(result) : Response.json(result);
}
