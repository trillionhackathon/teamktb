import type { OrderDetails } from '../demo-data';

export type Category = '커피' | '라테·논커피' | '티·에이드';
export type Temperature = 'hot' | 'ice';
export type Size = 'regular' | 'large';
export type Shot = 'default' | 'light' | 'extra';
export type Ice = 'less' | 'normal' | 'more';
export type Channel = '매장' | '포장';

export type MenuItem = {
  id: string;
  category: Category;
  name: string;
  description: string;
  price: number;
  prepSeconds: number;
  temperatures: Temperature[];
  hasShot: boolean;
  badge?: string;
  soldOut?: boolean;
};

export type ItemOptions = { temperature: Temperature; size: Size; shot: Shot; ice: Ice };

export type CartLine = { key: string; item: MenuItem; options: ItemOptions; quantity: number };

export const categories: Category[] = ['커피', '라테·논커피', '티·에이드'];

export const menuItems: MenuItem[] = [
  { id: 'americano', category: '커피', name: '아메리카노', description: '고소한 하우스 블렌드', price: 4500, prepSeconds: 30, temperatures: ['ice', 'hot'], hasShot: true, badge: '빠른 제조' },
  { id: 'cafe-latte', category: '커피', name: '카페라테', description: '에스프레소와 스팀 우유', price: 5000, prepSeconds: 75, temperatures: ['ice', 'hot'], hasShot: true },
  { id: 'vanilla-latte', category: '커피', name: '바닐라라테', description: '바닐라 시럽 1펌프', price: 5500, prepSeconds: 90, temperatures: ['ice', 'hot'], hasShot: true, badge: '인기' },
  { id: 'oat-latte', category: '커피', name: '오트라테', description: '귀리 음료로 만든 라테', price: 5800, prepSeconds: 80, temperatures: ['ice', 'hot'], hasShot: true },
  { id: 'cold-brew', category: '커피', name: '콜드브루', description: '12시간 저온 추출', price: 5000, prepSeconds: 20, temperatures: ['ice'], hasShot: false, badge: '빠른 제조' },
  { id: 'einspanner', category: '커피', name: '아인슈페너', description: '크림을 올린 진한 커피', price: 6000, prepSeconds: 110, temperatures: ['ice'], hasShot: true, soldOut: true },
  { id: 'strawberry-latte', category: '라테·논커피', name: '딸기라테', description: '생딸기 청과 우유', price: 6000, prepSeconds: 80, temperatures: ['ice'], hasShot: false, badge: '시즌' },
  { id: 'matcha-latte', category: '라테·논커피', name: '말차라테', description: '제주 말차와 우유', price: 5800, prepSeconds: 75, temperatures: ['ice', 'hot'], hasShot: false },
  { id: 'choco-latte', category: '라테·논커피', name: '초코라테', description: '진한 다크 초콜릿', price: 5500, prepSeconds: 70, temperatures: ['ice', 'hot'], hasShot: false },
  { id: 'earl-grey', category: '티·에이드', name: '얼그레이 티', description: '베르가못 향 홍차', price: 4800, prepSeconds: 45, temperatures: ['hot', 'ice'], hasShot: false },
  { id: 'lemon-ade', category: '티·에이드', name: '레몬에이드', description: '직접 담근 레몬청', price: 5500, prepSeconds: 60, temperatures: ['ice'], hasShot: false },
  { id: 'grapefruit-ade', category: '티·에이드', name: '자몽에이드', description: '자몽청과 탄산수', price: 5500, prepSeconds: 60, temperatures: ['ice'], hasShot: false },
];

export const optionPrice = { large: 500, extraShot: 500 };
export const maxLineQuantity = 10;

export function defaultOptions(item: MenuItem): ItemOptions {
  return { temperature: item.temperatures[0], size: 'regular', shot: 'default', ice: 'normal' };
}

export function unitPrice(item: MenuItem, options: ItemOptions): number {
  return item.price
    + (options.size === 'large' ? optionPrice.large : 0)
    + (item.hasShot && options.shot === 'extra' ? optionPrice.extraShot : 0);
}

export function displayName(item: MenuItem, options: ItemOptions): string {
  if (item.temperatures.length === 1) return item.name;
  return `${options.temperature === 'ice' ? '아이스' : '따뜻한'} ${item.name}`;
}

export function optionLabels(item: MenuItem, options: ItemOptions): string[] {
  const labels: string[] = [];
  if (options.size === 'large') labels.push('라지');
  if (item.hasShot && options.shot === 'light') labels.push('샷 연하게');
  if (item.hasShot && options.shot === 'extra') labels.push('샷 추가');
  if (options.temperature === 'ice' && options.ice === 'less') labels.push('얼음 적게');
  if (options.temperature === 'ice' && options.ice === 'more') labels.push('얼음 많이');
  return labels;
}

export function lineKey(item: MenuItem, options: ItemOptions): string {
  return [item.id, options.temperature, options.size, item.hasShot ? options.shot : '', options.temperature === 'ice' ? options.ice : ''].join(':');
}

export function formatPrice(won: number): string {
  return `${won.toLocaleString('ko-KR')}원`;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (!minutes) return `${rest}초`;
  return rest ? `${minutes}분 ${rest}초` : `${minutes}분`;
}

// 같은 음료를 여러 잔 만들 때는 추가 잔마다 절반의 시간이 든다고 가정한 목업 계산이다.
export function estimateSeconds(lines: CartLine[]): number {
  const total = lines.reduce((sum, { item, quantity }) => sum + item.prepSeconds + (quantity - 1) * Math.ceil(item.prepSeconds / 2), 0);
  return Math.max(10, Math.round(total / 5) * 5);
}

// 주방 보드의 Order 형식으로 변환한다. 점수와 근거는 AI 서버 연결 전까지 쓰는 예시 판단이다.
export function toOrderDetails(lines: CartLine[], channel: OrderDetails['channel']): OrderDetails {
  const seconds = estimateSeconds(lines);
  const items = lines.map(({ item, options, quantity }) => ({
    name: displayName(item, options),
    quantity,
    note: optionLabels(item, options).join(', ') || undefined,
  }));
  const duration = formatDuration(seconds);
  const score = Math.max(55, Math.min(92, Math.round(95 - seconds / 8)));
  const reason = seconds <= 60
    ? `${duration} 안에 제조할 수 있어요`
    : `방금 들어온 ${channel} 주문이에요`;

  return { channel, items, duration, score, reason };
}
