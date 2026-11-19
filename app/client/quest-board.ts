import type { BoardSnapshot, OrderItemView, OrderView } from '../domain/views.ts';

// 일머리 퀘스트 보드(목업). 서버 보드 순서를 받아 화면에서 4칸 고정 + 4칸 후보로 다시 나누고,
// 후보 승격과 일머리 TIP은 Zoro 판단을 흉내 낸 규칙으로 만든다. 도메인 데이터가 정해지면 Zoro 응답으로 바꾼다.

export const FIXED_COUNT = 4;
export const CANDIDATE_COUNT = 4;
// 뒤에 접수된 주문이 먼저 올라가며 앞지를 수 있는 횟수. 이 횟수만큼 밀린 주문은 다음 승격 때 무조건 올라간다.
export const MAX_OVERTAKES = 2;

export type RemainingItem = { key: string; label: string; qty: number };

// order_id -> 메뉴 key -> 앞 주문을 만들 때 같이 만들어 둔 잔 수
export type Prepared = Record<string, Record<string, number>>;

export type TipLine =
  | { kind: 'make'; key: string; label: string; qty: number; parts: { order_id: string; qty: number }[] }
  | { kind: 'complete'; order_id: string; preparedQty: number };

// head 주문의 퀘스트. 고정 4칸이 다 차면 frozen이 되어, head를 완료할 때까지 줄이 바뀌지 않는다.
// 다만 같이 만들기로 한 주문이 먼저 완료되어 빠지면 다시 계산한다.
export type TipPlan = { head: string; frozen: boolean; lines: TipLine[] };

export type QuestState = {
  fixed: string[];
  prepared: Prepared;
  overtakes: Record<string, number>;
  promoted: Record<string, string>;
  plan: TipPlan | null;
};

export type RankedCandidate = { order: OrderView; reason: string };

export const emptyQuestState: QuestState = { fixed: [], prepared: {}, overtakes: {}, promoted: {}, plan: null };

export function itemKey(item: OrderItemView): string {
  return [item.name, ...[...item.options].sort()].join('|');
}

export function itemLabel(item: OrderItemView): string {
  return item.options.length > 0 ? `${item.name}(${item.options.join(', ')})` : item.name;
}

// 메뉴와 옵션이 같으면 한 줄로 합치고, 앞 주문을 만들 때 미리 만든 잔 수를 뺀다.
export function remainingItems(order: OrderView, prepared: Prepared): RemainingItem[] {
  const merged = new Map<string, RemainingItem>();
  for (const item of order.items) {
    const key = itemKey(item);
    const current = merged.get(key);
    if (current) current.qty += item.qty;
    else merged.set(key, { key, label: itemLabel(item), qty: item.qty });
  }
  const done = prepared[order.order_id] ?? {};
  return [...merged.values()]
    .map((item) => ({ ...item, qty: item.qty - (done[item.key] ?? 0) }))
    .filter(({ qty }) => qty > 0);
}

// 받침에 맞춰 을/를을 붙인다. 옵션 괄호는 떼고 메뉴 이름 끝 글자로 판단한다.
export function withObjectParticle(label: string): string {
  const word = label.replace(/\(.*\)$/, '');
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (code < 0 || code > 11171) return `${word}을(를)`;
  return `${word}${code % 28 === 0 ? '를' : '을'}`;
}

function receivedAt(order: OrderView): number {
  return Date.parse(order.received_at);
}

// 후보 순위: 오래 밀린 주문 > 라이더 도착 > 고정칸과 같이 만들 수 있는 잔 수 > 짧은 작업 > 접수순.
export function rankCandidates(candidates: OrderView[], fixedOrders: OrderView[], prepared: Prepared, overtakes: Record<string, number>): RankedCandidate[] {
  const fixedKeys = new Map<string, number[]>();
  fixedOrders.forEach((order, index) => {
    for (const { key } of remainingItems(order, prepared)) fixedKeys.set(key, [...(fixedKeys.get(key) ?? []), index + 1]);
  });

  const overdue = [...candidates]
    .filter(({ order_id: id }) => (overtakes[id] ?? 0) >= MAX_OVERTAKES)
    .sort((a, b) => receivedAt(a) - receivedAt(b))[0];

  const scored = candidates.map((order) => {
    const shared = remainingItems(order, prepared).filter(({ key }) => fixedKeys.has(key));
    const sharedQty = shared.reduce((sum, { qty }) => sum + qty, 0);
    const rider = order.rider_status === 'arrived';
    const short = order.remaining_work_seconds <= 90;
    const score = (rider ? 1000 : 0) + sharedQty * 10 + (short ? 3 : 0);
    let reason = '먼저 접수된 주문이에요';
    if (order === overdue) reason = `앞에서 ${overtakes[order.order_id]}번 밀려서 이번에는 먼저 올려요`;
    else if (rider) reason = '라이더가 도착해서 먼저 올려요';
    else if (shared.length > 0) {
      const slots = [...new Set(shared.flatMap(({ key }) => fixedKeys.get(key)!))].sort((a, b) => a - b);
      reason = `${slots.join(', ')}번 주문과 ${withObjectParticle(shared[0].label)} 같이 만들 수 있어요`;
    } else if (short) reason = '금방 끝나는 주문이라 먼저 올려요';
    return { order, reason, score };
  });

  return scored
    .sort((a, b) => Number(b.order === overdue) - Number(a.order === overdue) || b.score - a.score || receivedAt(a.order) - receivedAt(b.order))
    .map(({ order, reason }) => ({ order, reason }));
}

export function candidateOrders(board: OrderView[], fixed: string[]): OrderView[] {
  return board.filter(({ order_id: id }) => !fixed.includes(id)).slice(0, CANDIDATE_COUNT);
}

// head 주문 퀘스트: 다른 고정칸과 겹치는 메뉴를 묶어 먼저 만들고, head에만 있는 메뉴를 만든 뒤, 완료를 누른다.
export function buildPlan(fixedOrders: OrderView[], prepared: Prepared): TipPlan | null {
  const [head, ...others] = fixedOrders;
  if (!head) return null;
  const otherItems = others.map((order) => ({ order, items: remainingItems(order, prepared) }));
  const batched: TipLine[] = [];
  const solo: TipLine[] = [];
  for (const item of remainingItems(head, prepared)) {
    const parts = otherItems.flatMap(({ order, items }) => {
      const match = items.find(({ key }) => key === item.key);
      return match ? [{ order_id: order.order_id, qty: match.qty }] : [];
    });
    const line: TipLine = { kind: 'make', key: item.key, label: item.label, qty: item.qty + parts.reduce((sum, { qty }) => sum + qty, 0), parts: [{ order_id: head.order_id, qty: item.qty }, ...parts] };
    (parts.length > 0 ? batched : solo).push(line);
  }
  const preparedQty = Object.values(prepared[head.order_id] ?? {}).reduce((sum, qty) => sum + qty, 0);
  return { head: head.order_id, frozen: fixedOrders.length >= FIXED_COUNT, lines: [...batched, ...solo, { kind: 'complete', order_id: head.order_id, preparedQty }] };
}

function keepActive<T>(record: Record<string, T>, active: Set<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => active.has(id)));
}

// 서버 보드가 바뀔 때마다 호출한다. 같은 보드로 다시 호출해도 결과가 같다.
export function reconcile(state: QuestState, board: OrderView[]): QuestState {
  const byId = new Map(board.map((order) => [order.order_id, order]));
  const active = new Set(byId.keys());
  let prepared: Prepared = structuredClone(state.prepared);

  // head가 끝났으면 퀘스트에서 같이 만든 다른 주문의 메뉴를 미리 만든 것으로 기록한다.
  if (state.plan && !active.has(state.plan.head)) {
    for (const line of state.plan.lines) {
      if (line.kind !== 'make') continue;
      for (const part of line.parts) {
        if (part.order_id === state.plan.head || !active.has(part.order_id)) continue;
        const done = (prepared[part.order_id] ??= {});
        done[line.key] = (done[line.key] ?? 0) + part.qty;
      }
    }
  }
  prepared = keepActive(prepared, active);
  const overtakes = keepActive(state.overtakes, active);
  const promoted = keepActive(state.promoted, active);

  const fixed = state.fixed.filter((id) => active.has(id));
  for (const order of board) {
    if (fixed.length >= FIXED_COUNT) break;
    if (order.status === 'in_progress' && !fixed.includes(order.order_id)) fixed.push(order.order_id);
  }
  while (fixed.length < FIXED_COUNT) {
    const ranked = rankCandidates(candidateOrders(board, fixed), fixed.map((id) => byId.get(id)!), prepared, overtakes);
    const top = ranked[0];
    if (!top) break;
    for (const { order } of ranked) {
      if (receivedAt(order) < receivedAt(top.order)) overtakes[order.order_id] = (overtakes[order.order_id] ?? 0) + 1;
    }
    delete overtakes[top.order.order_id];
    promoted[top.order.order_id] = top.reason;
    fixed.push(top.order.order_id);
  }

  // 처음 채울 때는 접수순으로 놓는다. 그 뒤로 올라오는 주문은 비어 있는 맨 뒤 칸에 들어간다.
  if (state.fixed.length === 0) fixed.sort((a, b) => receivedAt(byId.get(a)!) - receivedAt(byId.get(b)!));
  const fixedOrders = fixed.map((id) => byId.get(id)!);
  const partnersStay = state.plan?.lines.every((line) => line.kind !== 'make' || line.parts.every(({ order_id: id }) => fixed.includes(id))) ?? false;
  const keep = state.plan && fixedOrders[0] && state.plan.head === fixedOrders[0].order_id && state.plan.frozen && partnersStay;
  return { fixed, prepared, overtakes, promoted, plan: keep ? state.plan : buildPlan(fixedOrders, prepared) };
}

export type AgentAlert = { id: string; level: 'danger' | 'warn' | 'info'; title: string; detail: string; at?: string; sample?: boolean };

const equipmentLabels: Record<string, string> = { blender: '블렌더', espresso_machine: '에스프레소 머신', steam_wand: '스팀 완드' };

// 도메인 데이터가 나오기 전까지 보여 줄 예시 알림
const sampleAlerts: AgentAlert[] = [
  { id: 'sample-milk', level: 'warn', title: '우유가 1팩 남았어요', detail: '라떼 5잔 정도 만들 수 있어요. 창고에서 미리 꺼내 두세요.', sample: true },
  { id: 'sample-peak', level: 'info', title: '30분 뒤 점심 피크가 시작돼요', detail: '지난주 같은 시간에 주문이 평소의 2배였어요.', sample: true },
];

// 왼쪽 에이전트 패널: 서버 스냅샷의 재고, 장비, 라이더, 대기 시간, 최근 상황을 알림으로 바꾼다.
export function agentAlerts(snapshot: BoardSnapshot, now: number): AgentAlert[] {
  const alerts: AgentAlert[] = [];
  const { inventory, store } = snapshot.signals;
  for (const [name, status] of Object.entries(store.equipment_status)) {
    if (status === 'broken') alerts.push({ id: `equipment-${name}`, level: 'danger', title: `${equipmentLabels[name] ?? name} 점검 중`, detail: '이 장비가 필요한 메뉴는 시작할 수 없어요.' });
  }
  for (const order of snapshot.board) {
    if (order.rider_status === 'arrived') alerts.push({ id: `rider-${order.order_id}`, level: 'danger', title: `${order.order_id} 라이더 도착`, detail: '라이더가 기다리고 있어요. 이 주문을 먼저 마무리하세요.' });
    if (order.needs_confirmation) alerts.push({ id: `confirm-${order.order_id}`, level: 'warn', title: `${order.order_id} 픽업 시간 확인`, detail: '손님에게 픽업 시간을 확인해 주세요.' });
  }
  const longWaits = snapshot.board.filter((order) => order.status === 'waiting' && now - Date.parse(order.received_at) >= 10 * 60000);
  if (longWaits.length > 0) {
    const oldest = Math.floor(Math.max(...longWaits.map((order) => now - Date.parse(order.received_at))) / 60000);
    alerts.push({ id: 'long-wait', level: 'warn', title: `10분 넘게 기다린 주문 ${longWaits.length}건`, detail: `${longWaits.map(({ order_id: id }) => id).join(', ')} 주문이 기다리고 있어요. 가장 오래된 주문은 ${oldest}분째예요.` });
  }
  if (inventory.coffee_beans_shots_left <= 30) alerts.push({ id: 'beans', level: 'warn', title: `원두가 ${inventory.coffee_beans_shots_left}샷 남았어요`, detail: '원두 보충을 준비하세요.' });
  if (inventory.strawberry_servings_left <= 5) alerts.push({ id: 'strawberry', level: 'warn', title: `딸기가 ${inventory.strawberry_servings_left}인분 남았어요`, detail: '딸기 스무디 주문이 곧 막힐 수 있어요.' });
  for (const event of snapshot.events.slice(0, 3)) {
    alerts.push({ id: `event-${event.event_id}`, level: event.needs_confirmation ? 'warn' : 'info', title: event.summary, detail: event.raw_text, at: event.received_at });
  }
  return [...alerts, ...sampleAlerts];
}
