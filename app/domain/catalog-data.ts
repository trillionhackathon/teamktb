import cafeDb from '../../data/cafe_db.json' with { type: 'json' };
import ownerRulesData from '../../data/owner_rules.json' with { type: 'json' };
import menuGroupsData from '../../data/menu_groups.json' with { type: 'json' };
import recipe from '../../data/recipe.json' with { type: 'json' };
import type { MenuCatalog, MenuDrink, MenuOption } from './menu.ts';
import type { MenuGroup, OwnerRules, SizeId } from './types.ts';

// 비슷한 계열 표(data/menu_groups.json). Zoro가 레시피를 읽고 만든 초안을 사람이 확인해서 쓴다.
const groupOf = menuGroupsData.menu_group as Record<string, string>;
const groupInfo = menuGroupsData.groups as Record<string, { name_kr: string; color: string }>;
function menuGroup(menuId: string): MenuGroup | undefined {
  const id = groupOf[menuId];
  const info = id ? groupInfo[id] : undefined;
  return info ? { id, name_kr: info.name_kr, color: info.color } : undefined;
}

// data/ 원본에서 메뉴 카탈로그를 만든다. 서버와 테스트에서만 import하고, 화면에는 결과 객체를 props로 넘긴다.
type TimedMenu = { first_cup_sec: number; additional_cup_sec: number; complexity: number; basis?: string };
const timedMenus = cafeDb.menus as Record<string, TimedMenu>;

// cafe_db.json에는 MVP 3종의 제조 시간만 있다. 나머지 음료는 같은 complexity_tier의 MVP 메뉴 값을 추정치로 쓴다.
const tierReference: Record<number, string> = { 1: 'iced_americano', 2: 'latte', 3: 'strawberry_smoothie' };
const strawberryGramsPerServing = 180;

type StepSecond = { text?: string; sec: number; attended: boolean };
type RecipeDrink = (typeof recipe.drinks)[number] & { consumes_stock?: Record<string, number>; step_seconds?: StepSecond[] };

// 손이 비는 단계 이름. 레시피 문장을 짧은 말로 바꾼다(예: "에스프레소 2샷을 추출한다(자동 정지)" → "샷 추출").
function idleLabel(text: string): string {
  if (text.includes('추출')) return '샷 추출';
  if (text.includes('프로그램') || text.includes('블렌')) return '블렌더';
  if (text.includes('우린') || text.includes('우려')) return '티 우리기';
  if (text.includes('프레스') || text.includes('그릴')) return '그릴';
  return '기계 대기';
}

function stepTimes(drink: RecipeDrink): Pick<MenuDrink, 'hands_sec' | 'idle'> {
  const timed = drink.step_seconds ?? [];
  if (!timed.length) return {};
  const hands = timed.filter(({ attended }) => attended).reduce((sum, { sec }) => sum + sec, 0);
  let idle: MenuDrink['idle'];
  timed.forEach((step, index) => {
    if (step.attended || (idle && idle.sec >= step.sec)) return;
    idle = { sec: step.sec, label: idleLabel(step.text ?? drink.steps[index] ?? '') };
  });
  return { hands_sec: hands, ...(idle ? { idle } : {}) };
}

function toDrink(drink: RecipeDrink): MenuDrink {
  const measured = timedMenus[drink.id];
  const reference = measured ?? timedMenus[tierReference[drink.complexity_tier] ?? 'latte'];
  const consumes = drink.consumes_stock ?? {};
  return {
    id: drink.id,
    name_kr: drink.name_kr,
    category: drink.category,
    temperature: drink.temperature as MenuDrink['temperature'],
    price_krw: drink.price_krw,
    sizes: drink.available_sizes as SizeId[],
    options: drink.available_options,
    complexity_tier: drink.complexity_tier,
    equipment: drink.equipment_required,
    steps: drink.steps,
    allergens: drink.allergens,
    first_cup_sec: reference.first_cup_sec,
    additional_cup_sec: reference.additional_cup_sec,
    timing_basis: measured && measured.basis !== 'estimate' ? 'measured' : 'tier_estimate',
    is_mvp: recipe.mvp_menus.ids.includes(drink.id),
    espresso_shots: consumes.espresso_shot ?? 0,
    strawberry_servings: (consumes.strawberry_pulp ?? 0) / strawberryGramsPerServing,
    group: menuGroup(drink.id),
    ...stepTimes(drink),
  };
}

function buildCatalog(): MenuCatalog {
  const drinks = (recipe.drinks as RecipeDrink[]).map(toDrink);
  const usedCategories = new Set(drinks.map(({ category }) => category));
  const categories = Object.entries(recipe.categories as Record<string, string>)
    .filter(([id]) => usedCategories.has(id))
    .map(([id, name_kr]) => ({ id, name_kr }));
  const options = Object.fromEntries(Object.entries(recipe.options as Record<string, unknown>)
    .filter(([id, value]) => id !== 'note' && typeof value === 'object' && value !== null)
    .map(([id, value]) => {
      const option = value as Omit<MenuOption, 'id'>;
      return [id, { id, name_kr: option.name_kr, price_krw: option.price_krw, prep_delta_sec: option.prep_delta_sec, label: option.label, batch_blocking: option.batch_blocking }];
    }));
  const sizes = {
    R: { name_kr: recipe.sizes.R.name_kr, price_delta_krw: recipe.sizes.R.price_delta_krw, scale: recipe.sizes.R.scale },
    L: { name_kr: recipe.sizes.L.name_kr, price_delta_krw: recipe.sizes.L.price_delta_krw, scale: recipe.sizes.L.scale },
  };
  return { categories, drinks, options, sizes };
}

export const menuCatalog: MenuCatalog = buildCatalog();

export const boardConfig = {
  lockedCount: cafeDb.kds_board.locked_count,
  visibleCount: cafeDb.kds_board.rows * cafeDb.kds_board.cols,
  confidenceThreshold: cafeDb.model.confidence_threshold,
  quickMenuSec: (cafeDb.kds_board as { quick_menu_sec?: number }).quick_menu_sec,
  quickSlots: (cafeDb.kds_board as { quick_slots?: number }).quick_slots,
  fifo: (cafeDb.kds_board as { fifo?: boolean }).fifo,
  quickLane: (cafeDb.kds_board as { quick_lane?: boolean }).quick_lane,
};

// 사장님 기준(data/owner_rules.json). sentences는 Zoro에, limits는 사실 계산과 룰에 쓴다.
export const ownerRules: OwnerRules = { sentences: ownerRulesData.sentences, limits: ownerRulesData.limits };
