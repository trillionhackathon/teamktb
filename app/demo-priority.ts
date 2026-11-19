import type { Order } from './demo-data';

export type PriorityAdjustment = Pick<Order, 'id' | 'score' | 'reason'>;

const situationSignals = [
  { hint: /라이더|배달|기사님/, channel: '배달', reason: '라이더 도착이나 대기 상황을 반영했어요' },
  { hint: /픽업대|포장/, channel: '포장', reason: '픽업 손님이 기다리고 있어 먼저 준비해요' },
  { hint: /매장|카운터/, channel: '매장', reason: '매장 손님의 대기 상황을 반영했어요' },
] as const;

export function decideDemoPriority(text: string, waiting: Order[]):
  | { adjustment: PriorityAdjustment; status: '반영됨' }
  | { adjustment?: undefined; status: string } {
  const ids = new Set([...text.matchAll(/#\s*(\d+)|(\d+)\s*번/g)].map((match) => Number(match[1] ?? match[2])));
  if (ids.size > 1) return { status: '주문 번호를 하나 입력해 주세요' };

  if (!/급해|급한|재촉|임박|우선|먼저|기다|대기|(?:곧|금방|안에).*도착|도착했|도착 예정|왔어요|왔습니다/.test(text)) {
    return { status: '데모 범위 밖' };
  }

  const signals = situationSignals.filter(({ hint }) => hint.test(text));
  const signal = signals.length === 1 ? signals[0] : undefined;
  const [id] = ids;
  const order = id === undefined
    ? waiting.find(({ channel }) => channel === signal?.channel)
    : waiting.find((candidate) => candidate.id === id);

  if (!order) {
    return { status: id !== undefined || signal ? '대기 중인 주문 없음' : '대상 주문을 지정해 주세요' };
  }

  return {
    adjustment: { id: order.id, score: 99, reason: signal?.reason ?? '입력된 매장 상황에 따라 먼저 준비해요' },
    status: '반영됨',
  };
}

export function rankWaitingOrders(waiting: Order[], adjustment: PriorityAdjustment | undefined) {
  return waiting.map((order, index) => ({
    ...order,
    score: adjustment?.id === order.id ? adjustment.score : order.score,
    reason: adjustment?.id === order.id ? adjustment.reason : order.reason,
    arrivalRank: index + 1,
  })).sort((a, b) => b.score - a.score);
}
