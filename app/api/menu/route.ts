import { menuCatalog } from '../../domain/catalog-data.ts';
import { getOrderStore } from '../../server/store-instance.ts';

export const dynamic = 'force-dynamic';

// 메뉴 카탈로그(recipe.json + cafe_db.json)와 현재 주문 가능 여부.
export function GET() {
  return Response.json({ catalog: menuCatalog, availability: getOrderStore().availability() });
}
