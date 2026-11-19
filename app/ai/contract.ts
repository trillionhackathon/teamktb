import type { Fact } from '../domain/facts.ts';
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

// 보드 순서(1~4번 고정 + 5~8번 대기) 그대로 보낸다. 진행 중인 주문은 남은 작업 시간만 보낸다.
// teamktb는 이 요청의 응답에서 팁만 쓰고 orders는 반영하지 않는다(보드 순서는 4번 고르기만 바꾼다).
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
      overtaken: order.overtaken ?? 0,
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

// ---- 4번 칸 고르기: POST /ai/pick-next (aiserver app/schemas.py PickRequest, PickResult) ----
// 숫자는 teamktb가 계산해 문장으로 넣고, Zoro는 사장님 기준을 보고 후보 중 하나를 고르기만 한다.

export type AiPickFact = { id: string; facts: string };

export type AiPickRequest = {
  now: string;                // ISO 8601 UTC
  baristas: number;
  owner_rules: string[];
  locked: AiPickFact[];       // 새 1~3번(칸 순서)
  candidates: AiPickFact[];   // 들어온 순서
  rule_pick: string;
  examples: string[];         // 알바가 고친 예시(처음엔 빈 배열)
};

export type AiPickResult = {
  pick: string;
  source: AiSource;
  confidence: number;
  scores: Record<string, number>;
  fallback: boolean;
};

export function toPickRequest(input: {
  now: number;
  baristas: number;
  ownerRules: string[];
  locked: AiPickFact[];
  candidates: string[];
  facts: Map<string, Fact>;
  rulePick: string;
  examples?: string[];
}): AiPickRequest {
  return {
    now: new Date(input.now).toISOString(),
    baristas: Math.max(1, input.baristas),
    owner_rules: input.ownerRules,
    locked: input.locked,
    candidates: input.candidates.map((id) => ({ id, facts: input.facts.get(id)?.line ?? '' })),
    rule_pick: input.rulePick,
    examples: input.examples ?? [],
  };
}

export function parsePickResult(value: unknown): AiPickResult | undefined {
  if (!isRecord(value)) return undefined;
  const { pick, source, confidence, scores = {}, fallback = false } = value;
  if (typeof pick !== 'string' || !isSource(source) || !isFiniteNumber(confidence) || typeof fallback !== 'boolean') return undefined;
  if (!isRecord(scores) || !Object.values(scores).every(isFiniteNumber)) return undefined;
  return { pick, source, confidence, scores: scores as Record<string, number>, fallback };
}


// ---- 위 4칸 묶기(/ai/group-orders): 주문이 바뀔 때마다 맨 앞 4건 중 비슷한 주문끼리 한 묶음 ----
// aiserver app/schemas.py GroupRequest/GroupResult와 맞춘다.
// anchor(1번 기준): FIFO 보드는 1번(먼저 만들 주문)과 비슷한 2~4번만 묻는다. 응답 groups는 anchor와 그 짝만 1번 묶음이고,
// scores는 anchor가 아닌 주문마다 anchor와 비슷한 정도(Zoro noul, 같은 메뉴면 1)다.
export type AiGroupMenu = { id: string; name: string; equipment: string[]; steps: string[] };
export type AiGroupRequest = { orders: { id: string; menus: AiGroupMenu[] }[]; anchor?: string };
export type AiGroupResult = { groups: Record<string, number>; scores: Record<string, number>; matched_menus: Record<string, string[]>; fallback: boolean };

export function parseGroupResult(value: unknown): AiGroupResult | undefined {
  if (!isRecord(value)) return undefined;
  const { groups = {}, scores = {}, matched_menus: matched = {}, fallback = false } = value;
  if (!isRecord(groups) || !Object.values(groups).every((n) => Number.isInteger(n)) || typeof fallback !== 'boolean') return undefined;
  if (!isRecord(scores) || !Object.values(scores).every((n) => typeof n === 'number' && n >= 0 && n <= 1)) return undefined;
  if (!isRecord(matched) || !Object.values(matched).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string'))) return undefined;
  return { groups: groups as Record<string, number>, scores: scores as Record<string, number>, matched_menus: matched as Record<string, string[]>, fallback };
}
