// 주문·보드·이벤트 데이터 형식. 필드 이름은 data/cafe_db.json의 signals_schema와 kds_board를 따른다.

export type Channel = 'dine-in' | 'takeout' | 'delivery';
export type OrderSource = 'kiosk' | 'delivery_app' | 'scenario' | 'demo';
export type OrderStatus = 'waiting' | 'in_progress' | 'done';
export type RiderStatus = 'not_dispatched' | 'dispatched' | 'arrived';
export type SizeId = 'R' | 'L';
export type DecisionSource = 'zoro' | 'llm' | 'rule';

export type MenuItemInput = { menu: string; qty: number; size?: SizeId; options?: string[] };

export type OrderLine = { menu: string; qty: number; size: SizeId; options: string[] };

export type Order = {
  order_id: string;
  channel: Channel;
  source: OrderSource;
  menu_items: OrderLine[];
  received_at: string;
  status: OrderStatus;
  started_at?: string;
  completed_at?: string;
  request_note?: string;
  rider_status?: RiderStatus;
  pickup_eta_seconds?: number | null;
  eta_confirmed?: boolean;
  needs_confirmation?: boolean;
  remaining_work_seconds: number;
  price_krw: number;
  request_id?: string;
  // 4번 고르기에서 건너뛴 횟수(뒤에 접수된 주문이 먼저 4번에 들어간 횟수).
  overtaken?: number;
  // 작업창에서 미리 만들어 둔 주문(앞 주문 완료 때 같이 만든 잔). 남은 일은 포장뿐이다.
  made?: boolean;
  // 스무디 재료만 준비해 둔 주문. 갈기는 1~2번이 됐을 때 한다.
  prepped?: boolean;
  // 라이더·픽업 도착 시각. pickup_eta_seconds("지금부터 몇 초 뒤")를 받는 순간 now + 초로 바꿔 저장한다.
  rider_eta_at?: string;
};

// 사장님 기준의 숫자(data/owner_rules.json limits).
export type OwnerLimits = { max_wait_sec: number; delivery_late_ok_sec: number; max_overtaken: number };
export type OwnerRules = { sentences: string[]; limits: OwnerLimits };

// 4번 칸을 누가 골랐는지. checking은 룰 선택을 먼저 넣고 Zoro 답을 기다리는 중이다.
export type Slot4Info = {
  order_id: string;
  source: 'zoro' | 'rule';
  status: 'checking' | 'final';
  rule_pick: string;
  confidence?: number;
  // 고를 때의 후보별 사실 문장과 Zoro 점수. 화면에서 "룰은 #110 · 이유"를 만들 때 쓴다.
  facts: Record<string, string>;
  scores?: Record<string, number>;
};

// 작업창 한 줄. 마지막 줄은 kind 'done'("주문 #101 완료")이다.
export type WorkStep = { text: string; orders: string[]; kind: 'make' | 'prep' | 'pack' | 'done' };

export type Tip = { id: string; text: string; source: DecisionSource; confidence?: number };

export type EventCategory =
  | 'spill_cleanup' | 'stock_shortage' | 'customer_message' | 'rider_message' | 'equipment_failure' | 'equipment_recovered'
  | 'rider_arrived' | 'pickup_eta_update' | 'quality_request' | 'unknown';

export type StoreEvent = {
  event_id: string;
  raw_text: string;
  order_id?: string;
  category: EventCategory;
  needs_confirmation: boolean;
  summary: string;
  received_at: string;
  intent?: { intent: string; confidence: number; source: DecisionSource };
};

export type Signals = {
  inventory: { coffee_beans_shots_left: number; strawberry_servings_left: number };
  store: { equipment_status: Record<string, 'ok' | 'broken'>; staff_count: number };
  delivery: { weather: string };
};

// aiserver 연결 상태. 보드 순서는 바꾸지 않는다(4번 고르기는 Slot4Info, 팁은 /ai/decide).
export type Decision = {
  state_version: number;
  source: DecisionSource;
  fallback: boolean;
  ai_status: 'connected' | 'unavailable' | 'disabled';
  ai_error?: string;
  decided_at: string;
};
