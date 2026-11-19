// 시연 시나리오 3개(SC-N, SC-Q, SC-W)를 aiserver로 끝까지 돌려 에이전트 실행 로그(본 것 → 판단 → 행동)를 파일로 남긴다.
// 제출물 "시나리오 3가지의 에이전트 실행 로그"용이다. 화면 없이 주문 저장소를 직접 돌리고, 알바 버튼은 아래 순서대로 누른다.
//
//   AISERVER_URL=http://127.0.0.1:8000 RUN_LOG_ZORO="Zoro-1 (팀 서버)" node scripts/run-scenarios.ts [출력 폴더]
//
// 출력(기본 docs/run-logs/): <시나리오>.txt(사람이 읽는 줄)와 <시나리오>.jsonl(한 줄에 한 기록).
// RUN_LOG_ZORO에는 aiserver가 실제로 연결한 모델을 적는다(진짜 Zoro-1인지 개발용 대역인지). 파일 머리에 그대로 들어간다.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { boardConfig, menuCatalog } from '../app/domain/catalog-data.ts';
import { findScenario } from '../app/domain/scenarios.ts';
import { aiClientFromEnv } from '../app/server/aiserver.ts';
import { OrderStore } from '../app/server/order-store.ts';
import { clockText, formatRunLog } from '../app/server/run-log.ts';

type Result = unknown;
type Step = { label: string; run: (store: OrderStore) => Result | Promise<Result> };

const trigger = (scenarioId: string, index: number): Step['run'] => (store) => store.runTrigger(scenarioId, index);

// 시나리오마다 알바가 하는 일. 각 단계 뒤에는 Zoro 판단이 다 끝날 때까지 기다린다.
const plans: { id: string; steps: Step[] }[] = [
  {
    id: 'SC-N',
    steps: [
      { label: '#102 배달 라떼 2잔 접수 (배달 칸에 "한 잔은 디카페인")', run: trigger('SC-N', 0) },
      { label: '#103 배달 아아 2잔 접수 (가게 칸에 "연하게", "빨대 빼", "노크 X")', run: trigger('SC-N', 1) },
      { label: '#104 배달 딸기 스무디 접수 (담배 심부름, 안 되면 취소)', run: trigger('SC-N', 2) },
      { label: '알바가 #104 메모 두 문장을 확인', run: (store) => [store.resolveNote('#104', 's1', 'confirm'), store.resolveNote('#104', 's2', 'confirm')] },
      { label: '알바가 1번 #101 완료', run: (store) => store.updateOrderStatus('#101', 'complete') },
    ],
  },
  {
    id: 'SC-Q',
    steps: [
      { label: '알바가 8번 빠른 주문을 먼저 내보냄', run: (store) => {
        const id = store.snapshot().quick_lane.order_id;
        return id ? store.handleNote(`quick:${id}`) : { error: '8번 빠른 주문 칸이 비어 있어요.' };
      } },
      { label: '포장 초코 아이스크림 1개 접수', run: trigger('SC-Q', 0) },
      { label: '알바가 1번 #101 완료', run: (store) => store.updateOrderStatus('#101', 'complete') },
    ],
  },
  {
    id: 'SC-W',
    steps: [
      { label: '알바가 라떼 작업 제조 완료', run: (store) => {
        const task = store.snapshot().notes.find((note) => note.kind === 'task' && note.text.includes('라떼'));
        return task ? store.handleNote(task.id) : { error: '라떼 작업이 없어요.' };
      } },
      { label: '알바가 1번 #126 완료', run: (store) => store.updateOrderStatus('#126', 'complete') },
    ],
  },
];

function errorsOf(result: Result): string[] {
  const results = Array.isArray(result) ? result : [result];
  return results.flatMap((item) => (item && typeof item === 'object' && 'error' in item ? [String((item as { error: unknown }).error)] : []));
}

async function main(): Promise<void> {
  const baseUrl = process.env.AISERVER_URL?.trim();
  const ai = aiClientFromEnv();
  if (!baseUrl || !ai) {
    console.error('AISERVER_URL이 필요해요. 예: AISERVER_URL=http://127.0.0.1:8000 node scripts/run-scenarios.ts');
    process.exit(1);
  }
  const health = await fetch(new URL('/health', baseUrl)).then((response) => response.json()).catch(() => undefined);
  if (!health?.ok) {
    console.error(`aiserver(${new URL(baseUrl).origin})가 응답하지 않아요.`);
    process.exit(1);
  }
  const zoro = process.env.RUN_LOG_ZORO?.trim() || '적지 않음(RUN_LOG_ZORO)';
  const outDir = path.resolve(process.argv[2] ?? 'docs/run-logs');
  mkdirSync(outDir, { recursive: true });

  for (const plan of plans) {
    const scenario = findScenario(plan.id)!;
    const store = new OrderStore({ catalog: menuCatalog, config: boardConfig, ai });
    store.loadScenario(plan.id);
    await store.settle();
    const problems: string[] = [];
    for (const step of plan.steps) {
      const errors = errorsOf(await step.run(store));
      problems.push(...errors.map((error) => `${step.label}: ${error}`));
      await store.settle();
    }
    const entries = store.runLogEntries({ scenario: plan.id });
    const startedAt = entries[0]?.at ?? new Date().toISOString();
    const zoroCalls = entries.filter(({ by, ms }) => by === 'zoro' && ms !== undefined);
    const header = [
      `# ${scenario.id} ${scenario.title}`,
      `# 실행 ${new Date(startedAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })} ${clockText(startedAt)} KST · aiserver ${new URL(baseUrl).origin} · 모델 ${zoro} · AI 호출 ${zoroCalls.length}번`,
      `# 장면: ${scenario.description}`,
      `# 알바가 한 일: ${plan.steps.map(({ label }, index) => `${index + 1}) ${label}`).join(' ')}`,
      '# 줄 형식: [시각] 본 것/판단/행동(누가) 내용 (aiserver 응답 시간)',
      '',
    ];
    writeFileSync(path.join(outDir, `${plan.id}.txt`), `${header.join('\n')}${formatRunLog(entries)}\n`);
    writeFileSync(path.join(outDir, `${plan.id}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    const failed = entries.filter(({ by, text }) => by === 'zoro' && text.includes('답하지 못함')).length;
    console.log(`${plan.id}: ${entries.length}줄, AI 호출 ${zoroCalls.length}번${failed ? `, 답하지 못함 ${failed}번` : ''} → ${path.join(outDir, `${plan.id}.txt`)}`);
    for (const problem of problems) console.warn(`  ! ${problem}`);
  }
}

await main();
