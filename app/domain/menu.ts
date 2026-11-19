import type { MenuGroup, MenuItemInput, OrderLine, SizeId } from './types.ts';

// recipe.json + cafe_db.json에서 화면과 서버가 쓰는 값만 골라 만든 메뉴 카탈로그 형식이다.
export type MenuOption = { id: string; name_kr: string; price_krw: number; prep_delta_sec: number; label: string; batch_blocking: boolean };

export type MenuDrink = {
  id: string;
  name_kr: string;
  category: string;
  temperature: 'ICE' | 'HOT' | 'BLENDED';
  price_krw: number;
  sizes: SizeId[];
  options: string[];
  complexity_tier: number;
  equipment: string[];
  first_cup_sec: number;
  additional_cup_sec: number;
  timing_basis: 'measured' | 'tier_estimate';
  is_mvp: boolean;
  espresso_shots: number;
  strawberry_servings: number;
  steps?: string[];       // 만드는 순서(recipe.json). Zoro가 비슷한 메뉴를 알아볼 때 읽는다
  // recipe.json step_seconds에서 계산. hands_sec: 1잔에 손이 드는 시간(attended 합).
  // idle: 손이 비는 단계 중 가장 긴 것(attended=false, 예: 샷 추출 30초). 이 시간에 디저트를 먼저 내보낼 수 있다.
  hands_sec?: number;
  idle?: { sec: number; label: string };
  group?: MenuGroup;      // 비슷한 계열(data/menu_groups.json). 같은 계열은 연달아 만들면 준비를 나눠 쓴다
};

export type MenuCatalog = {
  categories: { id: string; name_kr: string }[];
  drinks: MenuDrink[];
  options: Record<string, MenuOption>;
  sizes: Record<SizeId, { name_kr: string; price_delta_krw: number; scale: number }>;
};

export const maxLineQuantity = 10;
export const maxOrderCups = 30;

// 같은 묶음 안에서는 하나만 고를 수 있다(샷 추가/연하게, 얼음 적게/많이 등).
export const exclusiveOptionGroups = [
  ['shot_add', 'shot_light'],
  ['ice_less', 'ice_extra'],
  ['syrup_less', 'syrup_extra'],
  ['whipped_add', 'whipped_none'],
  ['milk_oat', 'milk_low_fat'],
];
export const exclusiveGroupLabels = ['샷', '얼음', '시럽', '휘핑', '우유'];

export function findDrink(catalog: MenuCatalog, id: string): MenuDrink | undefined {
  return catalog.drinks.find((drink) => drink.id === id);
}

export function toggleOption(selected: string[], id: string): string[] {
  if (selected.includes(id)) return selected.filter((option) => option !== id);
  const group = exclusiveOptionGroups.find((ids) => ids.includes(id)) ?? [];
  return [...selected.filter((option) => !group.includes(option)), id];
}

export function normalizeLine(catalog: MenuCatalog, input: MenuItemInput): { line: OrderLine } | { error: string } {
  const drink = findDrink(catalog, input.menu);
  if (!drink) return { error: `알 수 없는 메뉴예요: ${input.menu}` };
  if (!Number.isSafeInteger(input.qty) || input.qty < 1 || input.qty > maxLineQuantity) return { error: `${drink.name_kr} 수량은 1~${maxLineQuantity}잔이어야 해요.` };
  const size = input.size ?? 'R';
  if (!drink.sizes.includes(size)) return { error: `${drink.name_kr}은(는) ${size} 사이즈가 없어요.` };
  const options = [...new Set(input.options ?? [])];
  const invalid = options.find((option) => !drink.options.includes(option));
  if (invalid) return { error: `${drink.name_kr}에 쓸 수 없는 옵션이에요: ${invalid}` };
  if (exclusiveOptionGroups.some((group) => options.filter((option) => group.includes(option)).length > 1)) return { error: `${drink.name_kr}에 함께 고를 수 없는 옵션이 있어요.` };
  return { line: { menu: drink.id, qty: input.qty, size, options: options.sort() } };
}

export function unitPrice(catalog: MenuCatalog, line: Pick<OrderLine, 'menu' | 'size' | 'options'>): number {
  const drink = findDrink(catalog, line.menu);
  if (!drink) return 0;
  return drink.price_krw + catalog.sizes[line.size].price_delta_krw + line.options.reduce((sum, id) => sum + (catalog.options[id]?.price_krw ?? 0), 0);
}

export function linePrice(catalog: MenuCatalog, line: OrderLine): number {
  return unitPrice(catalog, line) * line.qty;
}

// cafe_db.json remaining_work_formula: first_cup_sec + (qty - 1) * additional_cup_sec. 옵션의 prep_delta_sec은 잔마다 더한다.
export function lineWorkSeconds(catalog: MenuCatalog, line: OrderLine): number {
  const drink = findDrink(catalog, line.menu);
  if (!drink) return 0;
  const optionDelta = line.options.reduce((sum, id) => sum + (catalog.options[id]?.prep_delta_sec ?? 0), 0);
  return Math.max(0, drink.first_cup_sec + (line.qty - 1) * drink.additional_cup_sec + optionDelta * line.qty);
}

export function orderWorkSeconds(catalog: MenuCatalog, lines: OrderLine[]): number {
  return lines.reduce((sum, line) => sum + lineWorkSeconds(catalog, line), 0);
}

export function orderPrice(catalog: MenuCatalog, lines: OrderLine[]): number {
  return lines.reduce((sum, line) => sum + linePrice(catalog, line), 0);
}

export function lineName(catalog: MenuCatalog, line: Pick<OrderLine, 'menu' | 'size'>): string {
  const drink = findDrink(catalog, line.menu);
  const name = drink?.name_kr ?? line.menu;
  return line.size === 'L' ? `${name} 라지` : name;
}

export function optionNames(catalog: MenuCatalog, options: string[]): string[] {
  return options.map((id) => catalog.options[id]?.name_kr ?? id);
}

export function lineUsesEquipment(catalog: MenuCatalog, line: OrderLine, equipment: string): boolean {
  return findDrink(catalog, line.menu)?.equipment.includes(equipment) ?? false;
}

export function stockNeeded(catalog: MenuCatalog, lines: OrderLine[]): { espresso_shot: number; strawberry_servings: number } {
  let espresso = 0;
  let strawberry = 0;
  for (const line of lines) {
    const drink = findDrink(catalog, line.menu);
    if (!drink) continue;
    const shotDelta = drink.espresso_shots > 0 ? (line.options.includes('shot_add') ? 1 : 0) - (line.options.includes('shot_light') ? 1 : 0) : 0;
    espresso += Math.max(0, drink.espresso_shots + shotDelta) * line.qty;
    strawberry += drink.strawberry_servings * catalog.sizes[line.size].scale * line.qty;
  }
  return { espresso_shot: espresso, strawberry_servings: Math.round(strawberry * 100) / 100 };
}

export function formatPrice(won: number): string {
  return `${won.toLocaleString('ko-KR')}원`;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (!minutes) return `${rest}초`;
  return rest ? `${minutes}분 ${rest}초` : `${minutes}분`;
}

// scenarios.md: 남은 작업 시간을 분 단위로 올려 '약 N분'으로 보여준다.
export function formatWaitMinutes(seconds: number): string {
  return `약 ${Math.max(1, Math.ceil(seconds / 60))}분`;
}
