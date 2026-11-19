import { menuCatalog } from '../domain/catalog-data.ts';
import { getOrderStore } from '../server/store-instance.ts';
import KioskApp from './kiosk-app.tsx';

export const dynamic = 'force-dynamic';

export default function KioskPage() {
  return <KioskApp catalog={menuCatalog} initialAvailability={getOrderStore().availability()} />;
}
