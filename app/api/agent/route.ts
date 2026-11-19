import { agentMessages, inventoryViews, type AgentMessage, type InventoryView } from '../../server/agent.ts';
import { badRequest, readJson } from '../../server/http.ts';
import { getInventory } from '../../server/inventory-instance.ts';
import { getOrderStore } from '../../server/store-instance.ts';

export const dynamic = 'force-dynamic';

export type AgentResponse = { messages: AgentMessage[]; inventory: InventoryView[]; recent_cups: number; recent_minutes: number };

// 일머리 마법사 메시지. 본문 { order: 주문번호[] }는 대시보드에 보이는 순서(1~4번 고정, 5~8번 후보)다.
// 보내지 않은 보드 주문은 서버 보드 순서대로 뒤에 붙인다.
export async function POST(request: Request) {
  const body = await readJson(request);
  const order = body?.order ?? [];
  if (!Array.isArray(order) || order.length > 50 || !order.every((id) => typeof id === 'string' && id.length <= 20)) return badRequest('order는 주문 번호 배열이어야 해요.');
  const snapshot = getOrderStore().snapshot();
  const byId = new Map(snapshot.board.map((view) => [view.order_id, view]));
  const shown = order.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  const rest = snapshot.board.filter(({ order_id: id }) => !order.includes(id));
  const inventory = getInventory();
  const items = inventory.items();
  const recent = inventory.recentUse();
  const context = { items, usage: inventory.usage, orders: [...shown, ...rest], recent, events: snapshot.events, equipment: snapshot.signals.store.equipment_status };
  return Response.json({ messages: agentMessages(context), inventory: inventoryViews(context, inventory.usageSummary(recent.minutes)), recent_cups: Math.round(recent.cups), recent_minutes: recent.minutes } satisfies AgentResponse);
}
