import type { Order, Signals } from '../domain/types.ts';

// aiserver(feat/ai-skeleton) app/schemas.py와 맞춘 요청·응답 형식이다. 서버 스키마가 바뀌면 이 파일과 tests/ai-contract.test.ts를 함께 고친다.
// 응답은 aiserver main README 초안(tips 대신 feed, moves.confidence 생략)도 받는다.
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

export type AiStoreState = {
  orders: AiOrder[];
  store: Record<string, string>;
  external: Record<string, string>;
  inventory: Record<string, string>;
  baristas: number;
};

export type AiMove = { order_id: string; from: number; to: number; reason: string; confidence?: number; source: AiSource };
export type AiFeedItem = { category: string; text: string; origin?: string; confidence?: number; source: AiSource };
export type AiTip = { id: string; text: string; confidence: number; source: AiSource };

export type DecideResult = {
  orders: string[];
  locked_count: number;
  moves: AiMove[];
  eta: Record<string, string>;
  tips: AiTip[];
  feed: AiFeedItem[];
  fallback: boolean;
};

export type IntentResult = { intent: string; confidence: number; source: AiSource };

const sources: AiSource[] = ['zoro', 'llm', 'rule'];

// cafe_db.json의 값(dine-in/takeout/delivery, not_dispatched/dispatched/arrived)을 aiserver 값으로 바꾼다.
export function toAiChannel(channel: Order['channel']): AiOrder['channel'] {
  return channel === 'delivery' ? 'delivery' : 'store';
}

export function toAiRiderStatus(order: Pick<Order, 'channel' | 'rider_status'>): AiOrder['rider_status'] {
  if (order.channel !== 'delivery') return 'none';
  if (order.rider_status === 'arrived') return 'arrived';
  return order.rider_status === 'dispatched' ? 'assigned' : 'none';
}

// 보드 순서(1~5번 고정 + 재배치칸 + 대기열) 그대로 보낸다. 진행 중인 주문은 남은 작업 시간만 보낸다.
export function toAiStoreState(board: Order[], signals: Signals, options: { describe: (order: Order) => string; remainingSeconds: (order: Order) => number }): AiStoreState {
  const broken = Object.entries(signals.store.equipment_status).filter(([, status]) => status === 'broken').map(([name]) => name);
  return {
    orders: board.map((order) => ({
      id: order.order_id,
      items: options.describe(order),
      channel: toAiChannel(order.channel),
      created_at: order.received_at,
      prep_seconds: Math.round(options.remainingSeconds(order)),
      rider_status: toAiRiderStatus(order),
      overtaken: 0,
      remake: false,
    })),
    store: Object.fromEntries(broken.map((name) => [name === 'blender' ? '블렌더' : name, '고장'])),
    external: signals.delivery.weather ? { 날씨: signals.delivery.weather } : {},
    inventory: {
      원두: `약 ${signals.inventory.coffee_beans_shots_left}샷`,
      딸기: `${signals.inventory.strawberry_servings_left}인분`,
    },
    baristas: Math.max(1, signals.store.staff_count),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isSource = (value: unknown): value is AiSource => sources.includes(value as AiSource);

export function parseDecideResult(value: unknown): DecideResult | undefined {
  if (!isRecord(value)) return undefined;
  const { orders, locked_count: lockedCount, moves = [], eta = {}, tips = [], feed = [], fallback = false } = value;
  if (!Array.isArray(orders) || !orders.every((id) => typeof id === 'string')) return undefined;
  if (!Number.isSafeInteger(lockedCount) || (lockedCount as number) < 0) return undefined;
  if (!Array.isArray(moves) || !moves.every((move) => isRecord(move)
    && typeof move.order_id === 'string' && Number.isSafeInteger(move.from) && Number.isSafeInteger(move.to)
    && typeof move.reason === 'string' && (move.confidence === undefined || isFiniteNumber(move.confidence)) && isSource(move.source))) return undefined;
  if (!isRecord(eta) || !Object.values(eta).every((time) => typeof time === 'string' && !Number.isNaN(Date.parse(time)))) return undefined;
  if (!Array.isArray(tips) || !tips.every((tip) => isRecord(tip)
    && typeof tip.id === 'string' && typeof tip.text === 'string' && isFiniteNumber(tip.confidence) && isSource(tip.source))) return undefined;
  if (!Array.isArray(feed) || !feed.every((item) => isRecord(item)
    && typeof item.category === 'string' && typeof item.text === 'string'
    && (item.confidence === undefined || isFiniteNumber(item.confidence)) && isSource(item.source))) return undefined;
  if (typeof fallback !== 'boolean') return undefined;
  return { orders, locked_count: lockedCount as number, moves: moves as AiMove[], eta: eta as Record<string, string>, tips: tips as AiTip[], feed: feed as AiFeedItem[], fallback };
}

export function parseIntentResult(value: unknown): IntentResult | undefined {
  if (!isRecord(value) || typeof value.intent !== 'string' || !isFiniteNumber(value.confidence) || !isSource(value.source)) return undefined;
  return { intent: value.intent, confidence: value.confidence, source: value.source };
}

// ---- 일머리 퀘스트 보드: POST /ai/quest (aiserver feat/quest-api app/schemas.py QuestState, QuestResult) ----

export type AiQuestItem = { key: string; label: string; qty: number };

export type AiQuestOrder = {
  id: string;
  items: AiQuestItem[];
  channel: 'store' | 'delivery';
  created_at: string;
  prep_seconds: number;
  rider_status: 'none' | 'assigned' | 'arrived';
  overtaken: number;
  prepared_qty: number;
};

export type AiQuestState = {
  fixed: AiQuestOrder[];
  candidates: AiQuestOrder[];
  store: Record<string, string>;
  inventory: Record<string, string>;
};

export type AiCandidatePick = { order_id: string; reason_code: string; reason: string; confidence: number; source: AiSource };

export type AiQuestLine =
  | { kind: 'make'; key: string; label: string; qty: number; parts: { order_id: string; qty: number }[] }
  | { kind: 'complete'; order_id: string; prepared_qty: number };

export type QuestResult = {
  candidates: AiCandidatePick[];
  plan: { head: string; lines: AiQuestLine[]; source: AiSource } | null;
  fallback: boolean;
};

function parseQuestLine(value: unknown): AiQuestLine | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'complete') {
    if (typeof value.order_id !== 'string') return undefined;
    return { kind: 'complete', order_id: value.order_id, prepared_qty: Number.isSafeInteger(value.prepared_qty) ? value.prepared_qty as number : 0 };
  }
  if (value.kind !== 'make' || typeof value.key !== 'string' || typeof value.label !== 'string' || !Number.isSafeInteger(value.qty)) return undefined;
  if (!Array.isArray(value.parts) || value.parts.length === 0
    || !value.parts.every((part) => isRecord(part) && typeof part.order_id === 'string' && Number.isSafeInteger(part.qty))) return undefined;
  return { kind: 'make', key: value.key, label: value.label, qty: value.qty as number, parts: (value.parts as Record<string, unknown>[]).map((part) => ({ order_id: part.order_id as string, qty: part.qty as number })) };
}

export function parseQuestResult(value: unknown): QuestResult | undefined {
  if (!isRecord(value)) return undefined;
  const { candidates, plan, fallback = false } = value;
  if (!Array.isArray(candidates) || !candidates.every((pick) => isRecord(pick)
    && typeof pick.order_id === 'string' && typeof pick.reason_code === 'string' && typeof pick.reason === 'string'
    && isFiniteNumber(pick.confidence) && isSource(pick.source))) return undefined;
  if (typeof fallback !== 'boolean') return undefined;
  let parsedPlan: QuestResult['plan'] = null;
  if (plan !== null && plan !== undefined) {
    if (!isRecord(plan) || typeof plan.head !== 'string' || !isSource(plan.source) || !Array.isArray(plan.lines)) return undefined;
    const lines = plan.lines.map(parseQuestLine);
    if (lines.some((line) => line === undefined)) return undefined;
    parsedPlan = { head: plan.head, lines: lines as AiQuestLine[], source: plan.source };
  }
  return { candidates: candidates as AiCandidatePick[], plan: parsedPlan, fallback };
}
