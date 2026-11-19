import { badRequest, errorResponse, readJson } from '../../server/http.ts';
import { getOrderStore } from '../../server/store-instance.ts';
import type { Channel, MenuItemInput, OrderSource } from '../../domain/types.ts';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(getOrderStore().snapshot());
}

// 키오스크·배달앱·예시 주문 접수. request_id가 같으면 같은 주문을 돌려준다(재시도 안전).
export async function POST(request: Request) {
  const body = await readJson(request);
  if (!body) return badRequest('JSON 본문이 필요해요.');
  if (body.request_id !== undefined && (typeof body.request_id !== 'string' || body.request_id.length > 100)) return badRequest('request_id는 100자 이하 문자열이어야 해요.');
  if (!Array.isArray(body.menu_items) || !body.menu_items.every((item) => item && typeof item === 'object' && typeof item.menu === 'string')) {
    return badRequest('menu_items는 [{ menu, qty, size?, options? }] 배열이어야 해요.');
  }
  const result = getOrderStore().createOrder({
    request_id: body.request_id as string | undefined,
    channel: body.channel as Channel,
    source: body.source as OrderSource,
    menu_items: (body.menu_items as Record<string, unknown>[]).map((item): MenuItemInput => ({
      menu: item.menu as string,
      qty: item.qty as number,
      size: item.size as MenuItemInput['size'],
      options: Array.isArray(item.options) ? item.options.filter((option): option is string => typeof option === 'string') : undefined,
    })),
    request_note: body.request_note as string | undefined,
    rider_note: body.rider_note as string | undefined,
  });
  if ('error' in result) return errorResponse(result);
  return Response.json(result, { status: result.duplicate ? 200 : 201 });
}
