import type { OrderStore } from './order-store.ts';
import { InventoryStore, type InventoryItem } from './inventory.ts';

// Next.js 서버 프로세스 하나에 재고 저장소 하나. 개발 서버의 모듈 재실행에도 DB 연결과 구독이 겹치지 않도록 globalThis에 둔다.
const holder = globalThis as typeof globalThis & { __ilmoriInventory?: InventoryStore; __ilmoriInventoryAttached?: WeakSet<OrderStore>; __ilmoriInventoryStore?: OrderStore };

export function getInventory(): InventoryStore {
  holder.__ilmoriInventory ??= new InventoryStore();
  return holder.__ilmoriInventory;
}

// INVENTORY_COUNT_DEMO=0이면 시연용 자동 주문(source: demo)은 재고에서 빼지 않는다. 실제 QR 주문만 셀 때 쓴다.
const countDemo = () => process.env.INVENTORY_COUNT_DEMO !== '0';

// 주문 저장소의 스냅샷을 구독해, 새로 완료된 주문의 재료를 재고에서 뺀다. 같은 주문은 한 번만 뺀다.
// 재고가 바뀌면 주문 저장소의 원두, 딸기 수량(주문 접수 검사에 쓰는 값)을 SQLite 기준으로 다시 맞춘다.
export function attachInventory(store: OrderStore, inventory: InventoryStore = getInventory()): void {
  holder.__ilmoriInventoryAttached ??= new WeakSet();
  if (holder.__ilmoriInventoryAttached.has(store)) return;
  holder.__ilmoriInventoryAttached.add(store);
  holder.__ilmoriInventoryStore = store;
  // 붙이기 전에 이미 끝난 주문은 재고가 생기기 전 일이라 빼지 않는다.
  const seen = new Set(store.snapshot().history.filter(({ status }) => status === 'done').map((order) => `${order.order_id}@${order.received_at}`));
  store.subscribe((snapshot) => {
    for (const order of snapshot.history) {
      const ref = `${order.order_id}@${order.received_at}`;
      if (order.status !== 'done' || seen.has(ref)) continue;
      seen.add(ref);
      if (order.source !== 'demo' || countDemo()) inventory.consumeOrder(order);
    }
    store.syncStock(inventory.liveStock());
  });
  store.syncStock(inventory.liveStock());
}

// 마법사 대화에서 "채웠어요"를 누르면 재고를 채우고 주문 저장소 수량도 바로 맞춘다.
export function restockItem(itemId: string): InventoryItem | undefined {
  const item = getInventory().restock(itemId);
  if (item) holder.__ilmoriInventoryStore?.syncStock(getInventory().liveStock());
  return item;
}
