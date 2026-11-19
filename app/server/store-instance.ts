import { boardConfig, menuCatalog } from '../domain/catalog-data.ts';
import { aiClientFromEnv } from './aiserver.ts';
import { startDemoFeed } from './demo-feed.ts';
import { attachInventory } from './inventory-instance.ts';
import { OrderStore } from './order-store.ts';

// Next.js 서버 프로세스 하나에 저장소 하나. 개발 서버의 모듈 재실행에도 주문이 유지되도록 globalThis에 둔다.
const holder = globalThis as typeof globalThis & { __ilmoriOrderStore?: OrderStore };

export function getOrderStore(): OrderStore {
  if (!holder.__ilmoriOrderStore) {
    holder.__ilmoriOrderStore = new OrderStore({ catalog: menuCatalog, config: boardConfig, ai: aiClientFromEnv() });
    // DEMO_FEED=1이면 서버가 뜰 때부터 시연용 자동 주문을 넣는다.
    if (process.env.DEMO_FEED === '1') startDemoFeed(holder.__ilmoriOrderStore);
  }
  // 이미 떠 있는 개발 서버에서도 재고 구독이 붙도록 매번 호출한다(한 번만 붙는다).
  attachInventory(holder.__ilmoriOrderStore);
  return holder.__ilmoriOrderStore;
}
