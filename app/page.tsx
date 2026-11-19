import Dashboard from './dashboard.tsx';
import { getOrderStore } from './server/store-instance.ts';

export const dynamic = 'force-dynamic';

export default function Page() {
  return <Dashboard initial={getOrderStore().snapshot()} />;
}
