export type OrderItem = {
  name: string;
  quantity: number;
  note?: string;
};

export type OrderDetails = {
  channel: '매장' | '배달' | '포장';
  items: OrderItem[];
  note?: string;
  duration: string;
  score: number;
  reason: string;
};

export type Order = OrderDetails & {
  id: number;
  receivedAt: number;
  requestId?: string;
};

export const initialTime = 14 * 60 + 32;

export const initialOrders: Order[] = [
  { id: 104, channel: '매장', receivedAt: initialTime - 8, items: [
    { name: '따뜻한 카페라테', quantity: 1 }, { name: '카페라테', quantity: 1, note: '미지근하게' },
  ], duration: '2분 30초', score: 81, reason: '대기 시간이 가장 길어요' },
  { id: 105, channel: '배달', receivedAt: initialTime - 6, items: [
    { name: '아이스 바닐라라테', quantity: 2, note: '시럽 1펌프' }, { name: '아이스 아메리카노', quantity: 1 },
  ], duration: '3분 20초', score: 74, reason: '배달 픽업까지 여유가 있어요' },
  { id: 106, channel: '포장', receivedAt: initialTime - 3, items: [
    { name: '아이스 아메리카노', quantity: 1 }, { name: '아이스 아메리카노', quantity: 1, note: '얼음 반만' },
  ], duration: '45초', score: 96, reason: '픽업 대기 중이라 45초 안에 먼저 제조해요' },
  { id: 107, channel: '매장', receivedAt: initialTime - 1, items: [
    { name: '아이스 아메리카노', quantity: 2 }, { name: '따뜻한 카페라테', quantity: 2 }, { name: '아이스 바닐라라테', quantity: 2 },
  ], duration: '5분', score: 63, reason: '제조 시간이 긴 단체 주문이에요' },
];

const sampleOrders: OrderDetails[] = [
  { channel: '매장', items: [{ name: '아이스 아메리카노', quantity: 1 }], duration: '30초', score: 89, reason: '30초 안에 제조할 수 있어요' },
  { channel: '포장', items: [{ name: '오트라테', quantity: 1 }, { name: '오트라테', quantity: 1, note: '샷 연하게' }], duration: '2분', score: 76, reason: '포장 픽업까지 여유가 있어요' },
  { channel: '배달', items: [{ name: '콜드브루', quantity: 2, note: '얼음 반만' }], duration: '40초', score: 86, reason: '제조 시간이 짧은 배달 주문이에요' },
  { channel: '매장', items: [{ name: '딸기라테', quantity: 1 }], duration: '1분 20초', score: 71, reason: '방금 들어온 매장 주문이에요' },
];

export function appendOrder(orders: Order[], details: OrderDetails, requestId?: string): Order[] {
  const offset = orders.length - initialOrders.length;
  const lastId = orders[orders.length - 1].id;
  return [...orders, { ...details, id: lastId + 1, receivedAt: initialTime + offset + 1, requestId }];
}

export function appendDemoOrder(orders: Order[]): Order[] {
  const offset = orders.length - initialOrders.length;
  return appendOrder(orders, sampleOrders[offset % sampleOrders.length]);
}

export function formatTime(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return [hours, minutes].map((part) => String(part).padStart(2, '0')).join(':');
}

export const situationExamples = [
  { label: '라이더 도착', text: '105번 배달 주문의 라이더가 1분 안에 도착해요.' },
  { label: '매장 손님 재촉', text: '104번 매장 손님이 카운터에서 음료를 기다리고 있어요.' },
  { label: '단체 주문 우선', text: '107번 단체 주문의 픽업 시간이 임박했어요.' },
];
