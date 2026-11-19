import type { BoardReview, MenuGroup, Note, NoteRead, NoteSentence, Channel, Decision, OrderSource, OrderStatus, QuickLane, RiderStatus, Signals, Slot4Info, StoreEvent, Tip, WorkStep } from './types.ts';

// 서버가 화면으로 보내는 스냅샷. 화면은 메뉴 원본(recipe.json) 없이 이 값만으로 그린다.
// note_options: options 중 요청사항 메모를 읽고 붙인 것(이름)
export type OrderItemView = { name: string; qty: number; unit: string; options: string[]; note_options?: string[]; group?: MenuGroup; made?: boolean };

// 요청사항 문장마다 Zoro가 읽은 결과와 카드에 한 일. label은 카드 한 줄("메모 반영: 1잔 디카페인", 원문).
export type NoteSentenceView = NoteSentence & { label: string; option_name?: string };
export type NoteView = { status: NoteRead['status']; sentences: NoteSentenceView[] };

export type OrderView = {
  order_id: string;
  channel: Channel;
  channel_label: string;
  source: OrderSource;
  source_label: string;
  status: OrderStatus;
  items: OrderItemView[];
  request_note?: string;
  rider_note?: string;
  note_read?: NoteView;
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
  rider_eta_at?: string;
  // 4번 고르기에서 밀린 횟수, 미리 만든 주문, 스무디 재료만 준비한 주문
  overtaken?: number;
  made?: boolean;
  prepped?: boolean;
  slot?: number;
  // locked: 1~4번 고정, flexible: 5~8번 대기(빠른 주문 칸을 쓰면 5~7번), quick: 8번 빠른 주문 칸, queue: 화면 밖 대기열
  zone?: 'locked' | 'flexible' | 'quick' | 'queue';
  served_early?: boolean;
  blocked_reason?: string;
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
  // 4번을 누가 골랐는지(확인 중, Zoro, 룰). 4번 칸에 있는 주문일 때만 있다.
  slot4?: Slot4Info;
  // 1번 완료까지 할 일. 마지막 줄은 "주문 #101 완료"
  work_window: WorkStep[];
  // Zoro가 맨 앞 4건에서 묶은 주문(하이라이트 색)
  review: BoardReview;
  // 아래 일머리 팁 칸 카드(1번 기준 같이 만들기, 빠른 주문)
  notes: Note[];
  // 8번 빠른 주문 칸
  quick_lane: QuickLane;
};

export const channelLabels: Record<Channel, string> = { 'dine-in': '매장', takeout: '포장', delivery: '배달' };
export const sourceLabels: Record<OrderSource, string> = { kiosk: '키오스크', delivery_app: '배달앱', scenario: '시나리오', demo: '예시' };
export const riderLabels: Record<RiderStatus, string> = { not_dispatched: '라이더 배차 전', dispatched: '라이더 이동 중', arrived: '라이더 도착' };
