import { menuCatalog } from '../domain/catalog-data.ts';
import { getOrderStore } from '../server/store-instance.ts';
import DeliveryApp from './delivery-app.tsx';

export const dynamic = 'force-dynamic';

export default function DeliveryPage() {
  return <DeliveryApp catalog={menuCatalog} initial={getOrderStore().snapshot()} />;
}
