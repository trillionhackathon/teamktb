import type { Channel, Decision, OrderSource, OrderStatus, RiderStatus, Signals, StoreEvent, Tip } from './types.ts';

// 서버가 화면으로 보내는 스냅샷. 화면은 메뉴 원본(recipe.json) 없이 이 값만으로 그린다.
export type OrderItemView = { name: string; qty: number; options: string[] };

export type OrderView = {
  order_id: string;
  channel: Channel;
  channel_label: string;
  source: OrderSource;
  source_label: string;
  status: OrderStatus;
  items: OrderItemView[];
  request_note?: string;
  rider_status?: RiderStatus;
  rider_label?: string;
  pickup_eta_seconds?: number | null;
  eta_confirmed?: boolean;
  needs_confirmation?: boolean;
  received_at: string;
  started_at?: string;
  completed_at?: string;
  remaining_work_seconds: number;
  price_krw: number;
  slot?: number;
  zone?: 'locked' | 'flexible' | 'queue';
  blocked_reason?: string;
  move_reason?: string;
  eta_seconds?: number;
};

export type ScenarioView = { id: string; title: string; source: string; description: string; expected: string; triggers: string[] };

export type BoardSnapshot = {
  state_version: number;
  server_time: string;
  board: OrderView[];
  history: OrderView[];
  counts: { waiting: number; in_progress: number; done: number };
  decision: Decision;
  tips: Tip[];
  events: StoreEvent[];
  signals: Signals;
  scenario: ScenarioView | null;
  scenarios: { id: string; title: string }[];
  availability: Record<string, string>;
  config: { lockedCount: number; visibleCount: number };
};

export const channelLabels: Record<Channel, string> = { 'dine-in': '매장', takeout: '포장', delivery: '배달' };
export const sourceLabels: Record<OrderSource, string> = { kiosk: '키오스크', delivery_app: '배달앱', scenario: '시나리오', demo: '예시' };
export const riderLabels: Record<RiderStatus, string> = { not_dispatched: '라이더 배차 전', dispatched: '라이더 이동 중', arrived: '라이더 도착' };
