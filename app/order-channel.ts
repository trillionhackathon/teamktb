import type { OrderDetails, OrderItem } from './demo-data';

// 서버 연결 전에는 같은 브라우저에서 키오스크와 배달 목업이 주방 보드로 주문을 보낸다.
const channelName = 'ilmori-orders';

export type OrderSubmission = { type: 'order-submitted'; requestId: string; details: OrderDetails };
type OrderAccepted = { type: 'order-accepted'; requestId: string; orderId: number };
type OrderMessage = OrderSubmission | OrderAccepted;

export function createOrderRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function openOrderChannel(onMessage: (message: OrderMessage) => void): { post: (message: OrderMessage) => void; close: () => void } | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  const channel = new BroadcastChannel(channelName);
  channel.onmessage = (event: MessageEvent<OrderMessage>) => {
    const message = event.data;
    if (message?.type === 'order-submitted' || message?.type === 'order-accepted') onMessage(message);
  };
  return { post: (message) => channel.postMessage(message), close: () => channel.close() };
}

export function isOrderDetails(value: unknown): value is OrderDetails {
  if (!value || typeof value !== 'object') return false;
  const details = value as Record<string, unknown>;
  return ['매장', '포장', '배달'].includes(details.channel as string)
    && Array.isArray(details.items) && details.items.length > 0 && details.items.every(isOrderItem)
    && (details.note === undefined || (typeof details.note === 'string' && details.note.length <= 200))
    && typeof details.duration === 'string'
    && typeof details.score === 'number' && details.score >= 0 && details.score <= 100
    && typeof details.reason === 'string';
}

function isOrderItem(value: unknown): value is OrderItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 80
    && typeof item.quantity === 'number' && Number.isSafeInteger(item.quantity) && item.quantity > 0
    && (item.note === undefined || (typeof item.note === 'string' && item.note.length <= 200));
}
