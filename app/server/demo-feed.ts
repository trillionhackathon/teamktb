import type { Channel, MenuItemInput } from '../domain/types.ts';
import type { OrderStore } from './order-store.ts';

// 시연용 자동 주문. 서버에서 5~12초마다 예시 주문을 넣는다. 대시보드를 여러 개 열어도 주문은 한 번씩만 들어간다.
// 묶어 만들기가 잘 보이도록 아이스 아메리카노와 라떼 계열 비중을 높였고, 옵션은 가끔만 붙인다.

const menuWeights: [string, number][] = [
  ['iced_americano', 30], ['iced_latte', 12], ['vanilla_latte_ice', 12], ['latte', 8], ['cold_brew', 8],
  ['caramel_macchiato_ice', 7], ['strawberry_smoothie', 8], ['lemon_ade', 6], ['peach_iced_tea', 6],
];
const channelWeights: [Channel, number][] = [['dine-in', 40], ['takeout', 35], ['delivery', 25]];
const qtyWeights: [number, number][] = [[1, 60], [2, 30], [3, 10]];
const iceLessMenus = new Set(['iced_americano', 'cold_brew', 'iced_latte']);
const notes = ['캐리어에 담아 주세요', '빨대는 빼 주세요', '얼음 적게 부탁드려요'];

const minDelayMs = 5000;
const maxDelayMs = 12000;
// 보드에 이만큼 쌓이면 새 주문을 잠시 멈춘다. 완료가 따라오지 못할 때 대기열이 끝없이 길어지지 않게 한다.
const maxBoardOrders = 16;

export type DemoFeedStatus = { running: boolean; created: number; last_error?: string };

type FeedState = DemoFeedStatus & { timer?: ReturnType<typeof setTimeout> };

// 개발 서버가 모듈을 다시 실행해도 타이머가 겹치지 않도록 globalThis에 둔다.
const holder = globalThis as typeof globalThis & { __ilmoriDemoFeed?: FeedState };
const feed = (holder.__ilmoriDemoFeed ??= { running: false, created: 0 });

function pick<T>(weights: [T, number][], random: () => number): T {
  let left = random() * weights.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [value, weight] of weights) {
    left -= weight;
    if (left < 0) return value;
  }
  return weights[weights.length - 1][0];
}

export function demoOrder(random: () => number = Math.random): { channel: Channel; menu_items: MenuItemInput[]; request_note?: string } {
  const lineCount = random() < 0.7 ? 1 : 2;
  const menus = new Set<string>();
  while (menus.size < lineCount) menus.add(pick(menuWeights, random));
  const menu_items = [...menus].map((menu): MenuItemInput => ({
    menu,
    qty: pick(qtyWeights, random),
    ...(iceLessMenus.has(menu) && random() < 0.1 ? { options: ['ice_less'] } : {}),
  }));
  const channel = pick(channelWeights, random);
  return { channel, menu_items, ...(random() < 0.15 ? { request_note: notes[Math.floor(random() * notes.length)] } : {}) };
}

function tick(store: OrderStore): void {
  if (!feed.running) return;
  if (store.snapshot().board.length < maxBoardOrders) {
    const result = store.createOrder({ ...demoOrder(), source: 'demo', request_id: `demo-feed-${Date.now()}-${feed.created}` });
    if ('error' in result) feed.last_error = result.error;
    else {
      feed.created += 1;
      delete feed.last_error;
    }
  }
  feed.timer = setTimeout(() => tick(store), minDelayMs + Math.random() * (maxDelayMs - minDelayMs));
}

export function demoFeedStatus(): DemoFeedStatus {
  return { running: feed.running, created: feed.created, ...(feed.last_error ? { last_error: feed.last_error } : {}) };
}

export function startDemoFeed(store: OrderStore): DemoFeedStatus {
  if (!feed.running) {
    feed.running = true;
    tick(store);
  }
  return demoFeedStatus();
}

export function stopDemoFeed(): DemoFeedStatus {
  feed.running = false;
  if (feed.timer) clearTimeout(feed.timer);
  feed.timer = undefined;
  return demoFeedStatus();
}
