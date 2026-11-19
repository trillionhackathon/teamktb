import type { AiGroupRequest } from '../ai/contract.ts';
import { findDrink, lineName, type MenuCatalog } from './menu.ts';
import type { Order, ReviewGroup } from './types.ts';

// 위 4칸 묶기와 아래 자연어 칸에 쓰는 코드. 순서와 잔 수 계산은 여기서 하고,
// Zoro는 어떤 주문이 비슷한지(묶음)만 판단한다. "같이 처리해요" 문장과 빠른 주문 팝업은 코드가 만든다.

// 묶음 색. 묶음 번호 순서대로 배정한다(번호는 왼쪽 위 주문이 있는 묶음부터).
export const reviewColors = [
  { name: '초록', color: '#2e9d5b' },
  { name: '파랑', color: '#3d85c6' },
  { name: '주황', color: '#e07a2f' },
  { name: '보라', color: '#8e5bd6' },
];

// 맨 앞 주문들의 메뉴와 레시피를 aiserver에 보낸다.
export function buildGroupRequest(ids: string[], orders: Map<string, Order>, catalog: MenuCatalog): AiGroupRequest {
  return {
    orders: ids.flatMap((id) => {
      const order = orders.get(id);
      if (!order || order.status === 'done') return [];
      const menus = order.menu_items.flatMap((line) => {
        const drink = findDrink(catalog, line.menu);
        return drink ? [{ id: drink.id, name: drink.name_kr, equipment: drink.equipment, steps: drink.steps ?? [] }] : [];
      });
      return menus.length ? [{ id, menus }] : [];
    }),
  };
}

// aiserver가 준 묶음 번호를 색과 이름으로 바꾼다. 맨 앞 주문 중 둘 이상 남은 묶음만 쓴다.
export function groupViews(groups: Record<string, number>, present: Set<string>): Record<string, ReviewGroup> {
  const members = new Map<number, string[]>();
  for (const [orderId, n] of Object.entries(groups)) {
    if (present.has(orderId)) members.set(n, [...(members.get(n) ?? []), orderId]);
  }
  const result: Record<string, ReviewGroup> = {};
  for (const [n, ids] of [...members].sort(([a], [b]) => a - b)) {
    if (ids.length < 2) continue;
    const { name, color } = reviewColors[(n - 1) % reviewColors.length];
    for (const orderId of ids) result[orderId] = { id: n, label: `${name} 묶음`, color, size: ids.length };
  }
  return result;
}

// "카페 라떼 2잔, 딸기 스무디 1잔". 같은 메뉴는 잔 수를 더한다.
export function cupsText(ids: string[], orders: Map<string, Order>, catalog: MenuCatalog): string {
  const cups = new Map<string, number>();
  for (const id of ids) {
    for (const line of orders.get(id)?.menu_items ?? []) {
      const name = lineName(catalog, line);
      cups.set(name, (cups.get(name) ?? 0) + line.qty);
    }
  }
  return [...cups].map(([name, qty]) => `${name} ${qty}잔`).join(', ');
}

// 1번 카드: 위 문장은 1번의 메뉴, 아래 문장은 같이 만드는 2~4번. 이미 같이 만들어 둔 주문(made)이면 포장만 남았다고 알린다.
export function headNote(head: Order, companions: string[], orders: Map<string, Order>, catalog: MenuCatalog): { text: string; detail: string } {
  const text = `${head.order_id} ${cupsText([head.order_id], orders, catalog)}`;
  if (head.made) return { text, detail: '앞 주문과 같이 만들어 뒀어요 — 포장만 하면 돼요' };
  if (companions.length === 0) return { text, detail: '같이 만들 주문이 없어요' };
  const each = companions.map((id) => `${id} ${cupsText([id], orders, catalog)}`).join(' · ');
  return { text, detail: `같이 만들어요 — ${each} (합쳐서 ${cupsText([head.order_id, ...companions], orders, catalog)})` };
}

export function nextText(ids: string[], orders: Map<string, Order>, catalog: MenuCatalog): string {
  return `${ids.join(' · ')}도 같이 만들면 좋아요 — ${cupsText(ids, orders, catalog)}`;
}

// 룰: 포장 디저트 1잔(아이스크림 등)은 금방 끝나서 기다리게 두지 않고 알린다.
export const quickCategory = 'dessert';

export function quickText(order: Order, position: number, catalog: MenuCatalog): string | undefined {
  if (order.status !== 'waiting' || order.channel !== 'takeout' || order.menu_items.length !== 1 || order.menu_items[0].qty !== 1) return undefined;
  const [line] = order.menu_items;
  if (findDrink(catalog, line.menu)?.category !== quickCategory) return undefined;
  return `${order.order_id} ${lineName(catalog, line)} 1잔(포장)은 금방 끝나요 — 대기 ${position}번째지만 먼저 내보낼 수 있어요`;
}
