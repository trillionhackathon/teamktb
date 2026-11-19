'use client';

import { useEffect, useRef, useState } from 'react';
import type { Order } from '../demo-data';
import { parseDecideResult, toStoreState, type DecideResult } from './contract';

export type AiDecision =
  | { status: 'pending' }
  | { status: 'ready'; result: DecideResult }
  | { status: 'unavailable'; error: string };

const debounceMs = 300;

// 대기 주문이 바뀔 때마다 /api/ai/decide를 호출한다. 이전 요청은 취소하고 마지막 상태의 응답만 반영한다.
export function useAiDecision(waiting: Order[], clock: number, riderArrivedIds: number[]): AiDecision {
  const [decision, setDecision] = useState<AiDecision>({ status: 'pending' });
  const latest = useRef({ waiting, clock, riderArrivedIds });
  latest.current = { waiting, clock, riderArrivedIds };
  const key = `${clock}|${waiting.map(({ id }) => id).join(',')}|${riderArrivedIds.join(',')}`;

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const { waiting: orders, clock: currentClock, riderArrivedIds: riders } = latest.current;
      try {
        const response = await fetch('/api/ai/decide', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(toStoreState(orders, { clock: currentClock, now: new Date(), riderArrivedIds: riders })),
          signal: controller.signal,
        });
        const body: unknown = await response.json().catch(() => undefined);
        if (controller.signal.aborted) return;
        const result = response.ok ? parseDecideResult(body) : undefined;
        if (result) {
          setDecision({ status: 'ready', result });
        } else {
          const error = typeof body === 'object' && body && 'error' in body && typeof body.error === 'string' ? body.error : `응답 ${response.status}`;
          setDecision({ status: 'unavailable', error });
        }
      } catch (error) {
        if (!controller.signal.aborted) setDecision({ status: 'unavailable', error: error instanceof Error ? error.message : '요청 실패' });
      }
    }, debounceMs);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [key]);

  return decision;
}

// AI 순서를 대시보드 순위에 적용한다. AI 응답에 없는 주문(보이는 10건 밖)은 기존 순위 뒤에 둔다.
export function applyAiOrder<T extends { id: number; reason: string }>(ranked: T[], result: DecideResult, toId: (id: string) => number | undefined): T[] {
  const position = new Map<number, number>();
  result.orders.forEach((aiId, index) => {
    const id = toId(aiId);
    if (id !== undefined) position.set(id, index);
  });
  const reasons = new Map<number, string>();
  for (const move of result.moves) {
    const id = toId(move.order_id);
    if (id !== undefined) reasons.set(id, move.reason);
  }
  return ranked
    .map((order, index) => ({ order, index }))
    .sort((a, b) => (position.get(a.order.id) ?? Infinity) - (position.get(b.order.id) ?? Infinity) || a.index - b.index)
    .map(({ order }) => (reasons.has(order.id) ? { ...order, reason: reasons.get(order.id)! } : order));
}
