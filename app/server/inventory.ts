import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import inventoryData from '../../data/inventory.json' with { type: 'json' };
import recipe from '../../data/recipe.json' with { type: 'json' };
import type { OrderItemView, OrderView } from '../domain/views.ts';

// 재고 저장소(목업). data/inventory.json을 처음 한 번 SQLite에 넣고, 주문이 완료될 때마다 레시피 사용량만큼 뺀다.
// DB 파일은 INVENTORY_DB(기본 .data/inventory.sqlite)이고, 서버를 다시 띄워도 재고가 이어진다.

export type InventoryItem = {
  id: string;
  name_kr: string;
  unit: string;
  full: number;
  on_hand: number;
  danger_below: number;
  warn_below: number;
  reorder_label: string;
  reorder_qty: number;
};

export type InventoryLevel = 'danger' | 'warn' | 'ok';

type SeedItem = Omit<InventoryItem, 'id'> & { usage_per_cup?: Record<string, number> };

const seedItems = inventoryData.items as Record<string, SeedItem>;
const sizeScale: Record<string, number> = { R: 1, L: (recipe.sizes as Record<string, { scale?: number }>).L?.scale ?? 1 };
const largeSuffix = ` ${(recipe.sizes as Record<string, { name_kr?: string }>).L?.name_kr ?? '라지'}`;
const optionLabels = Object.fromEntries(Object.entries(recipe.options as Record<string, { name_kr?: string }>).flatMap(([id, option]) => (option?.name_kr ? [[option.name_kr, id]] : [])));
const liveItems = inventoryData.items as Record<string, { live?: { unit_amount?: number } }>;
const shotGrams = liveItems.beans?.live?.unit_amount ?? 18;
const strawberryGrams = liveItems.strawberry?.live?.unit_amount ?? 180;

export function inventoryLevel(item: Pick<InventoryItem, 'on_hand' | 'danger_below' | 'warn_below'>, amount = item.on_hand): InventoryLevel {
  if (amount < item.danger_below) return 'danger';
  if (amount < item.warn_below) return 'warn';
  return 'ok';
}

// 주문 한 줄에 드는 재료 양. 화면 이름(메뉴 이름, 라지, 옵션 이름)으로 레시피 사용량을 찾는다.
// 오트밀크, 저지방 우유 옵션은 우유 사용량을 그 재료로 옮기고, 샷 추가와 연하게는 원두를 한 샷만큼 더하거나 뺀다.
export function lineUsage(item: Pick<OrderItemView, 'name' | 'qty' | 'options'>, usage: Map<string, Map<string, number>>): Map<string, number> {
  const large = item.name.endsWith(largeSuffix);
  const menu = large ? item.name.slice(0, -largeSuffix.length) : item.name;
  const scale = sizeScale[large ? 'L' : 'R'] ?? 1;
  const options = new Set(item.options.map((label) => optionLabels[label] ?? label));
  const result = new Map<string, number>();
  for (const [itemId, perMenu] of usage) {
    const amount = perMenu.get(menu);
    if (amount) result.set(itemId, amount * scale * item.qty);
  }
  const milk = result.get('milk');
  const swap = options.has('milk_oat') ? 'oat_milk' : options.has('milk_low_fat') ? 'low_fat_milk' : undefined;
  if (milk && swap) {
    result.delete('milk');
    result.set(swap, (result.get(swap) ?? 0) + milk);
  }
  const beans = result.get('beans');
  if (beans && options.has('shot_add')) result.set('beans', beans + shotGrams * item.qty);
  if (beans && options.has('shot_light')) result.set('beans', Math.max(0, beans - shotGrams * item.qty));
  return result;
}

export function orderUsage(order: Pick<OrderView, 'items'>, usage: Map<string, Map<string, number>>): Map<string, number> {
  const total = new Map<string, number>();
  for (const item of order.items) {
    for (const [itemId, amount] of lineUsage(item, usage)) total.set(itemId, (total.get(itemId) ?? 0) + amount);
  }
  return total;
}

export class InventoryStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  readonly usage = new Map<string, Map<string, number>>();

  constructor(path = process.env.INVENTORY_DB?.trim() || '.data/inventory.sqlite', now: () => number = Date.now) {
    this.now = now;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, name_kr TEXT NOT NULL, unit TEXT NOT NULL, full REAL NOT NULL, on_hand REAL NOT NULL,
        danger_below REAL NOT NULL, warn_below REAL NOT NULL, reorder_label TEXT NOT NULL, reorder_qty REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage (item_id TEXT NOT NULL, menu_name TEXT NOT NULL, amount REAL NOT NULL, PRIMARY KEY (item_id, menu_name));
      CREATE TABLE IF NOT EXISTS movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, delta REAL NOT NULL,
        reason TEXT NOT NULL, ref TEXT, at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS movements_ref ON movements (item_id, reason, ref) WHERE ref IS NOT NULL;
      CREATE INDEX IF NOT EXISTS movements_at ON movements (at);
    `);
    // 예전 DB에는 주문 출처 칸이 없다.
    const columns = this.db.prepare('PRAGMA table_info(movements)').all() as { name: string }[];
    if (!columns.some(({ name }) => name === 'source')) this.db.exec('ALTER TABLE movements ADD COLUMN source TEXT');
    this.seed();
    for (const row of this.db.prepare('SELECT item_id, menu_name, amount FROM usage').all() as { item_id: string; menu_name: string; amount: number }[]) {
      if (!this.usage.has(row.item_id)) this.usage.set(row.item_id, new Map());
      this.usage.get(row.item_id)!.set(row.menu_name, row.amount);
    }
  }

  // 비어 있는 DB에만 inventory.json을 넣는다. 사용량 표는 매번 데이터 파일에 맞춘다.
  private seed(): void {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n;
    const insertItem = this.db.prepare('INSERT OR IGNORE INTO items (id, name_kr, unit, full, on_hand, danger_below, warn_below, reorder_label, reorder_qty) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertUsage = this.db.prepare('INSERT INTO usage (item_id, menu_name, amount) VALUES (?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM usage');
      for (const [id, item] of Object.entries(seedItems)) {
        insertItem.run(id, item.name_kr, item.unit, item.full, item.on_hand, item.danger_below, item.warn_below, item.reorder_label, item.reorder_qty);
        for (const [menu, amount] of Object.entries(item.usage_per_cup ?? {})) insertUsage.run(id, menu, amount);
      }
      if (count === 0) {
        const seedMovement = this.db.prepare("INSERT INTO movements (item_id, delta, reason, ref, at) VALUES (?, ?, 'seed', NULL, ?)");
        for (const [id, item] of Object.entries(seedItems)) seedMovement.run(id, item.on_hand, this.now());
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  items(): InventoryItem[] {
    return this.db.prepare('SELECT * FROM items ORDER BY id').all() as InventoryItem[];
  }

  // 완료된 주문의 재료를 뺀다. 같은 주문(번호 + 접수 시각)은 한 번만 뺀다. 뺀 재료가 있으면 true.
  // source는 주문 출처(kiosk, delivery_app, demo 등)다. 나중에 실제 주문과 시연 주문을 나눠 볼 수 있게 남긴다.
  consumeOrder(order: Pick<OrderView, 'order_id' | 'received_at' | 'items'> & { source?: string }): boolean {
    const ref = `${order.order_id}@${order.received_at}`;
    const source = order.source ?? null;
    const insert = this.db.prepare("INSERT OR IGNORE INTO movements (item_id, delta, reason, ref, at, source) VALUES (?, ?, 'order_complete', ?, ?, ?)");
    const update = this.db.prepare('UPDATE items SET on_hand = MAX(0, on_hand - ?) WHERE id = ?');
    let changed = false;
    this.db.exec('BEGIN');
    try {
      for (const [itemId, amount] of orderUsage(order, this.usage)) {
        if (insert.run(itemId, -amount, ref, this.now(), source).changes > 0) {
          update.run(amount, itemId);
          changed = true;
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return changed;
  }

  // 목업 입고: 주문 단위(reorder_qty)만큼 채운다. 가득 찬 양(full)은 넘지 않는다.
  restock(itemId: string): InventoryItem | undefined {
    const item = this.db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as InventoryItem | undefined;
    if (!item) return undefined;
    const delta = Math.max(0, Math.min(item.reorder_qty, item.full - item.on_hand));
    this.db.prepare('UPDATE items SET on_hand = on_hand + ? WHERE id = ?').run(delta, itemId);
    this.db.prepare("INSERT INTO movements (item_id, delta, reason, ref, at) VALUES (?, ?, 'restock', NULL, ?)").run(itemId, delta, this.now());
    return { ...item, on_hand: item.on_hand + delta };
  }

  // 최근 windowMinutes 동안 주문 완료로 쓴 양(재료별)과 완료한 잔 수(컵 사용량)
  recentUse(windowMinutes = 15): { minutes: number; byItem: Map<string, number>; cups: number } {
    const since = this.now() - windowMinutes * 60_000;
    const rows = this.db.prepare("SELECT item_id, -SUM(delta) AS used FROM movements WHERE reason = 'order_complete' AND at >= ? GROUP BY item_id").all(since) as { item_id: string; used: number }[];
    const byItem = new Map(rows.map(({ item_id: id, used }) => [id, used]));
    return { minutes: windowMinutes, byItem, cups: byItem.get('cup') ?? 0 };
  }

  // 재고 목록에 보여 줄 소모량: 최근 windowMinutes 동안, 오늘(서버 기준 자정부터), 오늘 중 실제 주문(시연 주문 제외)
  usageSummary(windowMinutes = 15): Map<string, { recent: number; today: number; todayReal: number }> {
    const now = this.now();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const rows = this.db.prepare(`
      SELECT item_id,
        -SUM(CASE WHEN at >= ? THEN delta ELSE 0 END) AS recent,
        -SUM(delta) AS today,
        -SUM(CASE WHEN COALESCE(source, '') <> 'demo' THEN delta ELSE 0 END) AS today_real
      FROM movements WHERE reason = 'order_complete' AND at >= ? GROUP BY item_id
    `).all(now - windowMinutes * 60_000, dayStart.getTime()) as { item_id: string; recent: number; today: number; today_real: number }[];
    return new Map(rows.map((row) => [row.item_id, { recent: row.recent, today: row.today, todayReal: row.today_real }]));
  }

  // 주문 저장소가 접수할 때 쓰는 원두 샷과 딸기 인분. inventory.json의 live 항목(원두, 딸기)을 단위로 바꾼다.
  liveStock(): { espresso_shot: number; strawberry_servings: number } {
    const items = new Map(this.items().map((item) => [item.id, item.on_hand]));
    return { espresso_shot: (items.get('beans') ?? 0) / shotGrams, strawberry_servings: (items.get('strawberry') ?? 0) / strawberryGrams };
  }

  close(): void {
    this.db.close();
  }
}
