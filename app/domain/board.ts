import type { Fact } from './facts.ts';
import type { Order, OwnerLimits } from './types.ts';

// 2x4 KDS 보드(data/cafe_db.json kds_board). board는 진행 중인 주문의 칸 순서다.
// 1~4번은 고정, 5~8번은 들어온 순서로 대기, 9번째부터는 화면 밖 대기열이다.
// 1번(고정칸) 완료 때만 2~4번을 당기고 5~8번 중 하나를 골라 4번에 넣는다(order-store.ts fillSlot4).
// fifo: 들어온 순서(FIFO)로만 채운다. 4번 고르기(Zoro)와 빠른 메뉴 끌어오기를 끄고, 비슷한 주문은 화면에서 묶어 알리기만 한다.
// quickMenuSec: 이 시간 이하로 만드는 주문은 대기칸 앞으로 올린다. quickSlots: 대기칸 중 앞 몇 칸까지. 둘 중 하나라도 없으면 끈다.
export type BoardConfig = { lockedCount: number; visibleCount: number; quickMenuSec?: number; quickSlots?: number; fifo?: boolean };

// cafe_db.json output_example(/ai/decide)의 이동 사유를 화면 말로 바꾼다.
export const moveReasonLabels: Record<string, string> = {
  rider_waiting: '라이더가 도착해 기다리고 있어요',
  fifo: '먼저 접수된 주문이라 앞으로 왔어요',
  short_job: '제조 시간이 짧아 먼저 처리해요',
  ai_hint: 'Zoro가 먼저 만들 주문으로 골랐어요',
  remake: '재제조 주문이라 맨 앞에 넣었어요',
};

// 4번 고르기 룰(Zoro가 실패하거나 확신이 0.7보다 낮을 때). 위에서부터 먼저 맞는 것을 쓴다.
// ① max_overtaken번 이상 밀린 주문 중 가장 오래된 주문
// ② 4번이 아니면 delivery_late_ok_sec보다 더 늦는 배달 중 여유가 가장 적은 주문
// ③ 가장 오래 기다린 주문
export function rulePickNext(cands: string[], orders: Map<string, Order>, facts: Map<string, Fact>, limits: OwnerLimits): string {
  const oldest = (ids: string[]) => ids.reduce((a, b) => (facts.get(a)!.receivedAt <= facts.get(b)!.receivedAt ? a : b));
  const starving = cands.filter((id) => (orders.get(id)!.overtaken ?? 0) >= limits.max_overtaken);
  if (starving.length) return oldest(starving);
  const late = cands.filter((id) => (facts.get(id)!.latePushedSec ?? -Infinity) > limits.delivery_late_ok_sec);
  if (late.length) return late.reduce((a, b) => (facts.get(a)!.slackSec <= facts.get(b)!.slackSec ? a : b));
  return oldest(cands);
}

// scenarios.md: 현재 시각부터 해당 주문 완료까지 남은 작업 시간을 앞 주문부터 합산한다. 동시 작업은 계산하지 않는다.
export function remainingSeconds(order: Order, now: number): number {
  if (order.status === 'done') return 0;
  if (order.status === 'in_progress' && order.started_at) {
    return Math.max(0, order.remaining_work_seconds - (now - Date.parse(order.started_at)) / 1000);
  }
  return order.remaining_work_seconds;
}

// 미리 만들어 둔 주문은 포장만 남는다.
export const packSeconds = 15;

export function workLeftSeconds(order: Order, now: number): number {
  if (order.status === 'done') return 0;
  return order.made ? Math.min(packSeconds, remainingSeconds(order, now)) : remainingSeconds(order, now);
}

export function boardEtas(board: string[], orders: Map<string, Order>, now: number): Map<string, number> {
  const etas = new Map<string, number>();
  let total = 0;
  for (const id of board) {
    const order = orders.get(id);
    if (!order) continue;
    total += workLeftSeconds(order, now);
    etas.set(id, Math.round(total));
  }
  return etas;
}
