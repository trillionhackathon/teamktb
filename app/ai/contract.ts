import type { Order } from '../demo-data';

// aiserver(feat/ai-skeleton) app/schemas.py와 맞춘 요청·응답 형식이다. 서버 스키마가 바뀌면 이 파일과 테스트를 함께 고친다.
export type AiSource = 'zoro' | 'llm' | 'rule';

export type AiOrder = {
  id: string;
  items: string;
  channel: 'store' | 'delivery';
  created_at: string;
  prep_seconds: number;
  rider_status: 'none' | 'assigned' | 'arrived';
  overtaken: number;
  remake: boolean;
};

export type StoreState = {
  orders: AiOrder[];
  store: Record<string, string>;
  external: Record<string, string>;
  inventory: Record<string, string>;
  baristas: number;
};

export type AiMove = { order_id: string; from: number; to: number; reason: string; confidence: number; source: AiSource };
export type AiTip = { id: string; text: string; confidence: number; source: AiSource };

export type DecideResult = {
  orders: string[];
  locked_count: number;
  moves: AiMove[];
  eta: Record<string, string>;
  tips: AiTip[];
  fallback: boolean;
};

export type IntentResult = { intent: string; confidence: number; source: AiSource };

const sources: AiSource[] = ['zoro', 'llm', 'rule'];

export const moveReasonLabels: Record<string, string> = {
  remake: '재제조 주문이라 맨 앞에 넣었어요',
  rider_waiting: '라이더가 도착해 기다리고 있어요',
  short_job: '제조 시간이 짧아 먼저 처리해요',
  ai_hint: 'Zoro가 먼저 만들 주문으로 골랐어요',
};

export function toAiOrderId(id: number): string {
  return `#${id}`;
}

export function fromAiOrderId(id: string): number | undefined {
  const match = /^#(\d+)$/.exec(id);
  return match ? Number(match[1]) : undefined;
}

export function parseDurationSeconds(duration: string): number {
  const minutes = /(\d+)\s*분/.exec(duration);
  const seconds = /(\d+)\s*초/.exec(duration);
  return (minutes ? Number(minutes[1]) * 60 : 0) + (seconds ? Number(seconds[1]) : 0);
}

// 대시보드 주문을 aiserver StoreState로 바꾼다. 포장은 aiserver에 별도 값이 없어 store로 보낸다.
// created_at은 데모 시계 기준 대기 시간이 실제 시각과 같도록 now에서 거꾸로 계산한다.
export function toStoreState(waiting: Order[], options: { clock: number; now: Date; riderArrivedIds?: number[] }): StoreState {
  const riderArrived = new Set(options.riderArrivedIds ?? []);
  const orders = [...waiting]
    .sort((a, b) => a.receivedAt - b.receivedAt || a.id - b.id)
    .map((order): AiOrder => ({
      id: toAiOrderId(order.id),
      items: order.items.map(({ name, quantity, note }) => `${name} ${quantity}잔${note ? `(${note})` : ''}`).join(', '),
      channel: order.channel === '배달' ? 'delivery' : 'store',
      created_at: new Date(options.now.getTime() - Math.max(0, options.clock - order.receivedAt) * 60_000).toISOString(),
      prep_seconds: parseDurationSeconds(order.duration),
      rider_status: order.channel === '배달' ? (riderArrived.has(order.id) ? 'arrived' : 'assigned') : 'none',
      overtaken: 0,
      remake: false,
    }));
  return { orders, store: {}, external: {}, inventory: {}, baristas: 2 };
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isSource = (value: unknown): value is AiSource => sources.includes(value as AiSource);

export function isStoreState(value: unknown): value is StoreState {
  if (!isRecord(value) || !Array.isArray(value.orders) || value.orders.length > 200) return false;
  return value.orders.every((order) => isRecord(order)
    && typeof order.id === 'string' && order.id.length > 0 && order.id.length <= 20
    && typeof order.items === 'string' && order.items.length <= 1000
    && (order.channel === 'store' || order.channel === 'delivery')
    && typeof order.created_at === 'string' && !Number.isNaN(Date.parse(order.created_at))
    && Number.isSafeInteger(order.prep_seconds) && (order.prep_seconds as number) >= 0
    && ['none', 'assigned', 'arrived'].includes(order.rider_status as string)
    && Number.isSafeInteger(order.overtaken) && (order.overtaken as number) >= 0
    && typeof order.remake === 'boolean')
    && Number.isSafeInteger(value.baristas) && (value.baristas as number) >= 1;
}

export function parseDecideResult(value: unknown): DecideResult | undefined {
  if (!isRecord(value)) return undefined;
  const { orders, locked_count: lockedCount, moves = [], eta = {}, tips = [], fallback = false } = value;
  if (!Array.isArray(orders) || !orders.every((id) => typeof id === 'string')) return undefined;
  if (!Number.isSafeInteger(lockedCount) || (lockedCount as number) < 0) return undefined;
  if (!Array.isArray(moves) || !moves.every((move) => isRecord(move)
    && typeof move.order_id === 'string' && Number.isSafeInteger(move.from) && Number.isSafeInteger(move.to)
    && typeof move.reason === 'string' && isFiniteNumber(move.confidence) && isSource(move.source))) return undefined;
  if (!isRecord(eta) || !Object.values(eta).every((time) => typeof time === 'string' && !Number.isNaN(Date.parse(time)))) return undefined;
  if (!Array.isArray(tips) || !tips.every((tip) => isRecord(tip)
    && typeof tip.id === 'string' && typeof tip.text === 'string' && isFiniteNumber(tip.confidence) && isSource(tip.source))) return undefined;
  if (typeof fallback !== 'boolean') return undefined;
  return { orders, locked_count: lockedCount as number, moves: moves as AiMove[], eta: eta as Record<string, string>, tips: tips as AiTip[], fallback };
}

export function parseIntentResult(value: unknown): IntentResult | undefined {
  if (!isRecord(value) || typeof value.intent !== 'string' || !isFiniteNumber(value.confidence) || !isSource(value.source)) return undefined;
  return { intent: value.intent, confidence: value.confidence, source: value.source };
}
