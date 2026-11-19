import { boardConfig, menuCatalog } from '../domain/catalog-data.ts';
import { aiClientFromEnv } from './aiserver.ts';
import { OrderStore } from './order-store.ts';

// Next.js 서버 프로세스 하나에 저장소 하나. 개발 서버의 모듈 재실행에도 주문이 유지되도록 globalThis에 둔다.
const holder = globalThis as typeof globalThis & { __ilmoriOrderStore?: OrderStore };

export function getOrderStore(): OrderStore {
  holder.__ilmoriOrderStore ??= new OrderStore({ catalog: menuCatalog, config: boardConfig, ai: aiClientFromEnv() });
  return holder.__ilmoriOrderStore;
}
