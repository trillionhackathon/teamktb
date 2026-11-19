import { badRequest, readJson } from '../../../server/http.ts';
import { restockItem } from '../../../server/inventory-instance.ts';

export const dynamic = 'force-dynamic';

// 채움 기록: 마법사 대화에서 "채웠어요"를 누르면 { item_id }만큼 주문 단위(reorder_qty)를 채운다. 가득 찬 양은 넘지 않는다.
export async function POST(request: Request) {
  const body = await readJson(request);
  if (typeof body?.item_id !== 'string') return badRequest('item_id가 필요해요.');
  const item = restockItem(body.item_id);
  if (!item) return Response.json({ error: `${body.item_id} 재고 항목이 없어요.` }, { status: 404 });
  return Response.json({ item });
}
