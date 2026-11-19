import { badRequest, errorResponse, readJson } from '../../../server/http.ts';
import { getOrderStore } from '../../../server/store-instance.ts';

// 주문 상태 변경: { action: 'start' | 'complete' }. 경로의 번호는 #를 뺀 주문 번호다(/api/orders/108).
// 요청사항 메모 ⚠ 처리: { action: 'note', sentence_id: 's2', decision: 'confirm' | 'revert' }
//   confirm: 확인했어요(보류를 풀어 1번과 같이 만들 수 있게 된다), revert: 메모로 붙인 옵션을 되돌린다.
export async function PATCH(request: Request, { params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  if (!/^\d{1,6}$/.test(number)) return badRequest('주문 번호는 숫자여야 해요.');
  const body = await readJson(request);
  const action = body?.action;
  if (action === 'note') {
    const sentenceId = body?.sentence_id;
    const decision = body?.decision;
    if (typeof sentenceId !== 'string' || !/^s\d{1,2}$/.test(sentenceId)) return badRequest('sentence_id는 s1 같은 문장 id여야 해요.');
    if (decision !== 'confirm' && decision !== 'revert') return badRequest("decision은 'confirm' 또는 'revert'여야 해요.");
    const result = getOrderStore().resolveNote(`#${number}`, sentenceId, decision);
    return 'error' in result ? errorResponse(result) : Response.json(result);
  }
  if (action !== 'start' && action !== 'complete') return badRequest("action은 'start', 'complete', 'note' 중 하나여야 해요.");
  const result = getOrderStore().updateOrderStatus(`#${number}`, action);
  return 'error' in result ? errorResponse(result) : Response.json(result);
}
