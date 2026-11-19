'use client';

import { useEffect, useState } from 'react';
import type { BoardSnapshot } from '../domain/views.ts';

export type Connection = 'connecting' | 'live' | 'reconnecting';

// /api/orders/stream(SSE)을 구독해 서버의 최신 보드 스냅샷을 유지한다. 연결이 끊기면 브라우저가 2초 뒤 다시 연결한다.
export function useBoardSnapshot(initial: BoardSnapshot | null): { snapshot: BoardSnapshot | null; connection: Connection; clockOffset: number } {
  const [snapshot, setSnapshot] = useState(initial);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [clockOffset, setClockOffset] = useState(0);

  useEffect(() => {
    const source = new EventSource('/api/orders/stream');
    source.addEventListener('snapshot', (event) => {
      const next = JSON.parse((event as MessageEvent<string>).data) as BoardSnapshot;
      setSnapshot(next);
      setClockOffset(Date.parse(next.server_time) - Date.now());
      setConnection('live');
    });
    source.onerror = () => setConnection('reconnecting');
    return () => source.close();
  }, []);

  return { snapshot, connection, clockOffset };
}

// 경과 시간 표시용 시계. 서버 시각과의 차이를 보정한다.
export function useNow(clockOffset: number, intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now + clockOffset;
}

export function formatClock(iso: string): string {
  const date = new Date(iso);
  return [date.getHours(), date.getMinutes()].map((part) => String(part).padStart(2, '0')).join(':');
}

export function formatElapsed(fromIso: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 1000));
  if (seconds < 60) return `${seconds}초 대기`;
  return `${Math.floor(seconds / 60)}분 대기`;
}
