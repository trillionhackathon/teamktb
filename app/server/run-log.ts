// 에이전트 실행 로그. 에이전트가 본 것(observe) → 판단(decide) → 행동(act)을 시간 순서대로 남긴다.
// 제출물 "시나리오 3가지의 에이전트 실행 로그"와 시연 중 확인에 쓴다(GET /api/run-log, scripts/run-scenarios.ts).
// 서버 메모리에만 두고 최근 limit줄만 남긴다. 서버를 다시 띄우면 비워진다.
//
// 누가(by): customer 손님 입력, staff 알바 버튼, zoro Zoro 판단(확률), code 코드 규칙 판단, agent 에이전트가 한 행동.
// Zoro는 뜻과 확신만 답하고, 카드를 고치는 행동은 그 확신에 기준선을 댄 코드가 한다. 그래서 행동은 agent로 적는다.

export type RunStep = 'observe' | 'decide' | 'act';
export type RunActor = 'customer' | 'staff' | 'zoro' | 'code' | 'agent';

export type RunLogEntry = {
  seq: number;
  run: number;         // 시나리오를 불러올 때마다 1씩 오른다
  scenario: string;
  at: string;          // 가게 시계(저장소 now) 기준 ISO 시각
  step: RunStep;
  by: RunActor;
  text: string;        // 한 줄 설명
  order_id?: string;
  ms?: number;         // aiserver 호출에 걸린 실제 시간
  data?: Record<string, unknown>;
};

export type RunLogInput = Omit<RunLogEntry, 'seq' | 'run' | 'scenario' | 'at'>;

export class RunLog {
  private entries: RunLogEntry[] = [];
  private seq = 0;
  private runNumber = 0;
  private scenarioId = '';
  private readonly now: () => number;
  private readonly limit: number;

  // 파라미터 속성(private readonly now)은 node 타입 지우기에서 안 돌아서 따로 적는다.
  constructor(now: () => number, limit = 3000) {
    this.now = now;
    this.limit = limit;
  }

  // 새 실행(시나리오 불러오기)을 연다. 앞 실행의 줄은 limit 안에서 남는다.
  start(scenario: string): number {
    this.runNumber += 1;
    this.scenarioId = scenario;
    return this.runNumber;
  }

  get run(): number {
    return this.runNumber;
  }

  add(entry: RunLogInput): void {
    this.seq += 1;
    this.entries.push({ seq: this.seq, run: this.runNumber, scenario: this.scenarioId, at: new Date(this.now()).toISOString(), ...entry });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }

  // run을 주면 그 실행, scenario만 주면 그 시나리오의 마지막 실행, 둘 다 없으면 지금 실행.
  list(filter: { run?: number; scenario?: string } = {}): RunLogEntry[] {
    const run = filter.run ?? (filter.scenario ? this.entries.findLast(({ scenario }) => scenario === filter.scenario)?.run : this.runNumber);
    return run === undefined ? [] : this.entries.filter((entry) => entry.run === run).map((entry) => structuredClone(entry));
  }
}

const stepLabels: Record<RunStep, string> = { observe: '본 것', decide: '판단', act: '행동' };
const actorLabels: Record<RunActor, string> = { customer: '손님', staff: '알바', zoro: 'Zoro', code: '코드', agent: '에이전트' };

// 로그 문장의 조사. 주문 번호(#101 → 백일)와 한글 단어의 받침을 본다. 괄호·따옴표·공백은 건너뛰고, 알 수 없으면 "을(를)"로 적는다.
const digitFinals = [21, 8, 0, 16, 0, 0, 1, 8, 8, 0];   // 영 일 이 삼 사 오 육 칠 팔 구의 받침(0은 받침 없음, 8은 ㄹ)
const RIEUL = 8;

function finalOf(word: string): number | undefined {
  for (let i = word.length - 1; i >= 0; i -= 1) {
    const ch = word[i];
    const code = ch.charCodeAt(0) - 0xac00;
    if (code >= 0 && code <= 11171) return code % 28;
    if (/[0-9]/.test(ch)) {
      const digits = word.slice(0, i + 1).match(/[0-9]+$/)![0];
      const zeros = digits.length - digits.replace(/0+$/, '').length;
      if (zeros === digits.length) return digitFinals[0];   // 0 → 영
      return [digitFinals[Number(digits[digits.length - 1])], 17, 1, 4, 4][Math.min(zeros, 4)];   // 십 백 천 만
    }
    if (/[A-Za-z]/.test(ch)) return undefined;
  }
  return undefined;
}

export function josa(word: string, withFinal: string, withoutFinal: string): string {
  const final = finalOf(word);
  if (final === undefined) return `${word}${withFinal}(${withoutFinal})`;
  return `${word}${final ? withFinal : withoutFinal}`;
}

// "~로/~으로": 받침이 없거나 ㄹ이면 로
export function withRo(word: string): string {
  const final = finalOf(word);
  if (final === undefined) return `${word}(으)로`;
  return `${word}${final === 0 || final === RIEUL ? '로' : '으로'}`;
}

export function clockText(iso: string): string {
  // ko-KR은 "12시 30분 5초"로 나와서 en-GB(12:30:05)를 쓴다. 가게 시각이라 서울 시간으로 적는다.
  return new Date(iso).toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Seoul' });
}

// 사람이 읽는 한 줄 형식. 예: [12:30:05] 판단(Zoro) #102 "한 잔은 디카페인으로요" → … (412ms)
export function formatRunLog(entries: RunLogEntry[]): string {
  return entries
    .map((entry) => {
      const ms = entry.ms === undefined ? '' : ` (${Math.round(entry.ms)}ms)`;
      return `[${clockText(entry.at)}] ${stepLabels[entry.step]}(${actorLabels[entry.by]}) ${entry.text}${ms}`;
    })
    .join('\n');
}
