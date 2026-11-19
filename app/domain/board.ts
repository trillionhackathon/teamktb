import type { Move, Order } from './types.ts';

// 2x5 KDS 보드(data/cafe_db.json kds_board). board는 진행 중인 주문의 칸 순서이며 11번째부터는 화면 밖 대기열이다.
export type BoardConfig = { lockedCount: number; visibleCount: number };

export const moveReasonLabels: Record<string, string> = {
  rider_waiting: '라이더가 도착해 기다리고 있어요',
  fifo: '먼저 접수된 주문이라 앞으로 왔어요',
  short_job: '제조 시간이 짧아 먼저 처리해요',
  ai_hint: 'Zoro가 먼저 만들 주문으로 골랐어요',
  remake: '재제조 주문이라 맨 앞에 넣었어요',
};

export function flexibleRange(board: string[], config: BoardConfig): [number, number] {
  return [Math.min(config.lockedCount, board.length), Math.min(config.visibleCount, board.length)];
}

// 재배치 후보: 6~10번 칸의 대기 주문 중 제조할 수 있는 주문. 진행 중이거나 장비 고장으로 막힌 주문은 제자리를 지킨다(INV-02, SC-05).
export function candidateIds(board: string[], orders: Map<string, Order>, config: BoardConfig, isBlocked: (order: Order) => boolean): string[] {
  const [start, end] = flexibleRange(board, config);
  return board.slice(start, end).filter((id) => {
    const order = orders.get(id);
    return order !== undefined && order.status === 'waiting' && !isBlocked(order);
  });
}

// 후보끼리의 새 순서를 후보 칸에만 채운다. 고정칸과 후보가 아닌 주문의 칸은 바뀌지 않는다.
export function placeCandidates(board: string[], config: BoardConfig, candidates: string[], orderedCandidates: string[]): string[] {
  const set = new Set(candidates);
  const [start, end] = flexibleRange(board, config);
  const queue = [...orderedCandidates];
  return board.map((id, index) => (index >= start && index < end && set.has(id) ? queue.shift()! : id));
}

export function diffMoves(before: string[], after: string[], reasonFor: (id: string) => { reason: string; confidence: number; source: Move['source'] }): Move[] {
  return after.flatMap((id, index) => {
    const from = before.indexOf(id);
    return from > index ? [{ order_id: id, from: from + 1, to: index + 1, ...reasonFor(id) }] : [];
  });
}

// cafe_db.json fallback_rules[priority_order]: FIFO + 라이더 도착 우선.
export function ruleArrange(board: string[], orders: Map<string, Order>, config: BoardConfig, isBlocked: (order: Order) => boolean): { board: string[]; moves: Move[] } {
  const candidates = candidateIds(board, orders, config, isBlocked);
  const sorted = [...candidates].sort((a, b) => {
    const left = orders.get(a)!;
    const right = orders.get(b)!;
    return Number(right.rider_status === 'arrived') - Number(left.rider_status === 'arrived')
      || Date.parse(left.received_at) - Date.parse(right.received_at)
      || a.localeCompare(b);
  });
  const next = placeCandidates(board, config, candidates, sorted);
  const moves = diffMoves(board, next, (id) => ({
    reason: orders.get(id)?.rider_status === 'arrived' ? 'rider_waiting' : 'fifo',
    confidence: 1,
    source: 'rule',
  }));
  return { board: next, moves };
}

// AI 응답(aiserver DecideResult.orders)을 검증해 적용한다. 고정칸이 바뀌었거나 보드에 없는 주문이 있으면 적용하지 않는다(INV-01, INV-02).
export function applyAiOrder(board: string[], orders: Map<string, Order>, config: BoardConfig, isBlocked: (order: Order) => boolean, aiOrders: string[]):
  | { board: string[] }
  | { error: string } {
  const visible = board.slice(0, config.visibleCount);
  const [start] = flexibleRange(board, config);
  if (aiOrders.length !== visible.length || new Set(aiOrders).size !== aiOrders.length || !aiOrders.every((id) => visible.includes(id))) {
    return { error: 'AI 응답의 주문 목록이 현재 보드와 달라요.' };
  }
  if (aiOrders.slice(0, start).some((id, index) => id !== visible[index])) {
    return { error: 'AI 응답이 1~5번 고정칸을 바꿨어요.' };
  }
  const candidates = candidateIds(board, orders, config, isBlocked);
  const orderedCandidates = aiOrders.filter((id) => candidates.includes(id));
  return { board: placeCandidates(board, config, candidates, orderedCandidates) };
}

// scenarios.md: 현재 시각부터 해당 주문 완료까지 남은 작업 시간을 앞 주문부터 합산한다. 동시 작업은 계산하지 않는다.
export function remainingSeconds(order: Order, now: number): number {
  if (order.status === 'done') return 0;
  if (order.status === 'in_progress' && order.started_at) {
    return Math.max(0, order.remaining_work_seconds - (now - Date.parse(order.started_at)) / 1000);
  }
  return order.remaining_work_seconds;
}

export function boardEtas(board: string[], orders: Map<string, Order>, now: number): Map<string, number> {
  const etas = new Map<string, number>();
  let total = 0;
  for (const id of board) {
    const order = orders.get(id);
    if (!order) continue;
    total += remainingSeconds(order, now);
    etas.set(id, Math.round(total));
  }
  return etas;
}
