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
};

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

export type Move = { order_id: string; from: number; to: number; reason: string; confidence: number; source: DecisionSource };

export type Decision = {
  state_version: number;
  source: DecisionSource;
  fallback: boolean;
  ai_status: 'connected' | 'unavailable' | 'disabled';
  ai_error?: string;
  moves: Move[];
  decided_at: string;
};
