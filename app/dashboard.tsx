'use client';

import Link from 'next/link';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { callApi, orderPath } from './client/api.ts';
import type { QuestResponse } from './api/quest/route.ts';
import {
  applyAiRanking, candidateOrders, emptyQuestState, itemKey, preparedKey, rankCandidates, reconcile, FIXED_COUNT, CANDIDATE_COUNT,
  type AiQuestHint, type DecisionOrigin, type QuestState, type TipLine,
} from './client/quest-board.ts';
import { formatClock, formatElapsed, useBoardSnapshot, useNow, type Connection } from './client/use-board.ts';
import type { BoardSnapshot, OrderView } from './domain/views.ts';
import type { AgentResponse } from './api/agent/route.ts';
import type { AgentMessage as AgentMessageData } from './server/agent.ts';
import type { DemoFeedStatus } from './server/demo-feed.ts';
import WizardAvatar from './wizard-avatar.tsx';

const connectionLabels: Record<Connection, string> = { connecting: '연결 중', live: '실시간 연결됨', reconnecting: '재연결 중' };
const storageKey = 'ilmori-quest-board-v3';

type AiStatus = 'pending' | 'connected' | 'disabled' | 'unavailable';
const aiStatusLabels: Record<AiStatus, string> = { pending: 'AI 서버 확인 중', connected: 'AI 서버 연결됨', disabled: 'AI 서버 미설정', unavailable: 'AI 서버 미응답' };
const originLabels: Record<DecisionOrigin, string> = { zoro: 'Zoro 판단', rule: '규칙 판단', local: '화면 규칙' };

function isQuestState(value: unknown): value is QuestState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<QuestState>;
  return Array.isArray(state.fixed) && typeof state.prepared === 'object' && typeof state.overtakes === 'object' && typeof state.promoted === 'object';
}

// 고정칸, 미리 만든 메뉴, 앞지르기 횟수는 이 브라우저에만 저장한다(목업). 새로고침해도 퀘스트가 이어진다.
function useQuestBoard(board: OrderView[], ai: AiQuestHint | null): QuestState {
  const [state, setState] = useState<QuestState>(emptyQuestState);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? 'null');
      if (isQuestState(saved)) setState(saved);
    } catch {
      // 저장소를 못 읽으면 빈 상태에서 시작한다.
    }
    setLoaded(true);
  }, []);

  const next = useMemo(() => reconcile(state, board, ai), [state, board, ai]);

  useEffect(() => {
    if (!loaded) return;
    const text = JSON.stringify(next);
    if (text !== JSON.stringify(state)) setState(next);
    try {
      window.localStorage.setItem(storageKey, text);
    } catch {
      // 저장하지 못해도 화면은 그대로 동작한다.
    }
  }, [next, state, loaded]);

  return next;
}

// 고정칸, 후보, 미리 만든 잔 수가 바뀔 때마다 /api/quest(aiserver /ai/quest)에 묻는다. 늦게 온 응답은 버린다.
function useAiQuest(quest: QuestState, board: OrderView[], onResult: (hint: AiQuestHint | null, status: AiStatus) => void) {
  const fixed = quest.fixed;
  const candidates = candidateOrders(board, fixed).map(({ order_id: id }) => id);
  const ids = [...fixed, ...candidates];
  const prepared = Object.fromEntries(ids.flatMap((id) => (quest.prepared[id] ? [[id, quest.prepared[id]]] : [])));
  const overtakes = Object.fromEntries(candidates.flatMap((id) => (quest.overtakes[id] ? [[id, quest.overtakes[id]]] : [])));
  const request = JSON.stringify({ fixed, candidates, prepared, overtakes });

  useEffect(() => {
    const body = JSON.parse(request) as { fixed: string[]; candidates: string[]; prepared: QuestState['prepared']; overtakes: Record<string, number> };
    if (body.fixed.length === 0) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const response = await callApi<QuestResponse>('/api/quest', { body });
      if (cancelled) return;
      if (!response.ok) return onResult(null, 'unavailable');
      if (response.data.status !== 'connected') return onResult(null, response.data.status);
      const { candidates: picks, plan } = response.data.result;
      onResult({
        fixed: body.fixed,
        candidates: body.candidates,
        preparedKey: preparedKey(body.prepared, body.fixed),
        ranking: picks.map(({ order_id: id, reason, source }) => ({ order_id: id, reason, source })),
        plan: plan && {
          head: plan.head,
          source: plan.source,
          lines: plan.lines.map((line): TipLine => (line.kind === 'make' ? line : { kind: 'complete', order_id: line.order_id, preparedQty: line.prepared_qty })),
        },
      }, 'connected');
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [request]); // eslint-disable-line react-hooks/exhaustive-deps
}

// 재고, 보드 순서, 최근 처리량으로 만든 마법사 메시지(/api/agent). 보드나 보이는 순서가 바뀔 때, 그리고 30초마다 다시 읽는다.
function useAgent(order: string[], version: number): { agent: AgentResponse | null; refresh: () => void } {
  const [agent, setAgent] = useState<AgentResponse | null>(null);
  const [tick, setTick] = useState(0);
  const key = order.join(',');
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    let cancelled = false;
    void callApi<AgentResponse>('/api/agent', { body: { order: key ? key.split(',') : [] } }).then((result) => {
      if (!cancelled && result.ok) setAgent(result.data);
    });
    return () => { cancelled = true; };
  }, [key, version, tick]);
  return { agent, refresh: () => setTick((value) => value + 1) };
}

// 마법사 대화 기록. 새 알림은 맨 아래에 붙고, 같은 알림(같은 id와 단계)은 새로 쌓지 않고 그 자리에서 문장만 고친다.
// 응답에서 빠진 알림은 해결된 것으로 흐리게 남긴다. 이 브라우저 메모리에만 있다.
type AgentLogEntry = AgentMessageData & { key: string; seen_at: string; resolved: boolean };
const maxLogEntries = 50;

function useAgentLog(agent: AgentResponse | null): { summary: AgentMessageData | undefined; log: AgentLogEntry[] } {
  const [log, setLog] = useState<AgentLogEntry[]>([]);
  useEffect(() => {
    if (!agent) return;
    setLog((previous) => {
      const next = previous.map((entry) => ({ ...entry }));
      const active = new Set<string>();
      for (const message of agent.messages) {
        if (message.id === 'summary') continue;
        const key = `${message.id}:${message.level}`;
        active.add(key);
        const index = next.findLastIndex((entry) => entry.key === key && !entry.resolved);
        if (index >= 0) next[index] = { ...next[index], ...message };
        else next.push({ ...message, key, seen_at: new Date().toISOString(), resolved: false });
      }
      for (const entry of next) if (!active.has(entry.key)) entry.resolved = true;
      return next.slice(-maxLogEntries);
    });
  }, [agent]);
  return { summary: agent?.messages.find(({ id }) => id === 'summary'), log };
}

function AgentMessage({ message, onRestock, busy }: { message: AgentLogEntry; onRestock: (itemId: string) => void; busy: boolean }) {
  return (
    <li className={`agent-message level-${message.level}${message.resolved ? ' resolved' : ''}`}>
      <p>{message.text}</p>
      <div className="agent-message-meta">
        <strong>{message.resolved ? `${message.topic} 해결됨` : message.topic}</strong>
        <time dateTime={message.at ?? message.seen_at}>{formatClock(message.at ?? message.seen_at)}</time>
        {message.action && !message.resolved && <button type="button" className="agent-action" disabled={busy} onClick={() => onRestock(message.action!.item_id)}>{message.action.label}</button>}
      </div>
    </li>
  );
}

function OrderLines({ order, prepared }: { order: OrderView; prepared: Record<string, number> }) {
  const left = { ...prepared };
  return (
    <ul className="card-items">
      {order.items.map((item, index) => {
        const key = itemKey(item);
        const done = Math.min(item.qty, left[key] ?? 0);
        left[key] = (left[key] ?? 0) - done;
        return (
          <li key={index} className={done === item.qty ? 'item-done' : undefined}>
            <span className="item-name">{item.name}</span>
            <span className="item-qty">{item.qty}잔</span>
            {item.options.length > 0 && <span className="item-options">{item.options.join(', ')}</span>}
            {done > 0 && <span className="item-prepared">{done}잔 미리 만듦</span>}
          </li>
        );
      })}
    </ul>
  );
}

function OrderFlags({ order }: { order: OrderView }) {
  const flags = [
    order.blocked_reason && { text: order.blocked_reason, tone: 'muted' },
    order.rider_status === 'arrived' && { text: '라이더 도착', tone: 'danger' },
    order.needs_confirmation && { text: '픽업 시간 확인 필요', tone: 'warn' },
    order.request_note && { text: `요청사항: ${order.request_note}`, tone: 'muted' },
  ].filter((flag): flag is { text: string; tone: string } => Boolean(flag));
  if (flags.length === 0) return null;
  return <div className="card-flags">{flags.map(({ text, tone }) => <p key={text} className={`card-flag tone-${tone}`}>{text}</p>)}</div>;
}

const orderStatusLabels: Record<OrderView['status'], string> = { waiting: '대기 중', in_progress: '제조 중', done: '완료' };

function OrderDetail({ order, prepared, reason, now }: {
  order: OrderView;
  prepared: Record<string, number>;
  reason?: string;
  now: number;
}) {
  return (
    <>
      <p className="order-detail-meta">
        <span className="order-channel" data-channel={order.channel_label}>{order.channel_label}</span>
        <span>{order.source_label} · {orderStatusLabels[order.status]}</span>
      </p>
      <dl className="order-detail-facts">
        <div><dt>접수</dt><dd><time dateTime={order.received_at}>{formatClock(order.received_at)}</time>{order.status === 'waiting' && ` · ${formatElapsed(order.received_at, now)}`}</dd></div>
        <div><dt>주문 금액</dt><dd>{order.price_krw.toLocaleString('ko-KR')}원</dd></div>
        {order.status !== 'done' && <div><dt>남은 제조 시간</dt><dd>{order.remaining_work_seconds}초</dd></div>}
        {order.rider_label && <div><dt>라이더</dt><dd>{order.rider_label}</dd></div>}
        {order.pickup_eta_seconds != null && <div><dt>픽업 예정</dt><dd>{order.pickup_eta_seconds}초 후{order.eta_confirmed ? ' · 확인됨' : ''}</dd></div>}
      </dl>
      <h3>주문 메뉴</h3>
      <OrderLines order={order} prepared={prepared} />
      <OrderFlags order={order} />
      {reason && <p className="card-reason"><strong>추천 이유</strong>{reason}</p>}
    </>
  );
}

function tipText(line: TipLine, slotOf: (id: string) => number): string {
  if (line.kind === 'make') return `${line.label} ${line.qty}잔 만들기`;
  return `${slotOf(line.order_id)}번 주문 완료 누르기`;
}

function tipReason(line: TipLine, head: OrderView, slotOf: (id: string) => number, hasNext: boolean): string {
  const slotName = (id: string) => (slotOf(id) > 0 ? `${slotOf(id)}번` : id);
  if (line.kind === 'make') {
    if (line.parts.length === 1) return `${slotName(head.order_id)} 주문에만 있는 메뉴예요.`;
    return `${line.parts.map(({ order_id: id, qty }) => `${slotName(id)} ${qty}잔`).join(' + ')}을 한 번에 만들어요.`;
  }
  const sentences: string[] = [];
  if (line.preparedQty > 0) sentences.push(`${line.preparedQty}잔은 앞 주문을 만들 때 같이 만들어 두었어요.`);
  sentences.push(hasNext ? '다 만들면 위 1번 칸에서 완료를 눌러요. 다음 주문 퀘스트로 넘어가요.' : '다 만들면 위 1번 칸에서 완료를 눌러요.');
  return sentences.join(' ');
}

export default function Dashboard({ initial }: { initial: BoardSnapshot }) {
  const { snapshot: live, connection, clockOffset } = useBoardSnapshot(initial);
  const snapshot = live ?? initial;
  const now = useNow(clockOffset, 5000, Date.parse(initial.server_time));
  const [ai, setAi] = useState<AiQuestHint | null>(null);
  const [aiStatus, setAiStatus] = useState<AiStatus>('pending');
  const quest = useQuestBoard(snapshot.board, ai);
  useAiQuest(quest, snapshot.board, (hint, status) => {
    setAi(hint);
    setAiStatus(status);
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feed, setFeed] = useState<DemoFeedStatus | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<OrderView | null>(null);
  const detailDialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (selectedOrder && !detailDialog.current?.open) detailDialog.current?.showModal();
  }, [selectedOrder]);

  // 시연용 자동 주문 상태. 보드가 바뀔 때마다 다시 읽어 다른 화면에서 켜고 끈 것도 따라간다.
  useEffect(() => {
    void callApi<DemoFeedStatus>('/api/demo-feed').then((result) => { if (result.ok) setFeed(result.data); });
  }, [snapshot.state_version]);

  async function toggleFeed() {
    const result = await callApi<DemoFeedStatus>('/api/demo-feed', { body: { running: !feed?.running } });
    if (result.ok) setFeed(result.data);
    else setError(result.error);
  }

  const byId = new Map(snapshot.board.map((order) => [order.order_id, order]));
  const fixedOrders = quest.fixed.map((id) => byId.get(id)).filter((order): order is OrderView => order !== undefined);
  const candidates = applyAiRanking(rankCandidates(candidateOrders(snapshot.board, quest.fixed), fixedOrders, quest.prepared, quest.overtakes), ai, quest.fixed);
  const queueCount = Math.max(0, snapshot.board.length - fixedOrders.length - candidates.length);
  const slotOf = (id: string) => quest.fixed.indexOf(id) + 1;
  const head = fixedOrders[0];
  const { agent, refresh: refreshAgent } = useAgent([...quest.fixed, ...candidates.map(({ order }) => order.order_id)], snapshot.state_version);
  const { summary: agentSummary, log: agentLog } = useAgentLog(agent);
  const agentList = useRef<HTMLOListElement>(null);
  const stickToBottom = useRef(true);
  // 맨 아래를 보고 있을 때만 새 메시지를 따라 내려간다. 위로 올려 이전 대화를 읽는 중이면 그대로 둔다.
  useLayoutEffect(() => {
    const list = agentList.current;
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight;
  }, [agentLog]);
  const detail = selectedOrder && (byId.get(selectedOrder.order_id)
    ?? snapshot.history.find((order) => order.order_id === selectedOrder.order_id) ?? selectedOrder);

  // 목업 입고. 실제 발주 대신 재고를 주문 단위만큼 채운다.
  async function restock(itemId: string) {
    setBusy(true);
    const result = await callApi('/api/inventory/restock', { body: { item_id: itemId } });
    setBusy(false);
    if (result.ok) refreshAgent();
    else setError(result.error);
  }

  // 시작 단계 없이 바로 완료한다. 서버는 대기 중인 주문의 완료도 받는다.
  async function completeOrder(order: OrderView) {
    setBusy(true);
    const result = await callApi(orderPath(order.order_id), { method: 'PATCH', body: { action: 'complete' } });
    setBusy(false);
    setError(result.ok ? null : result.error);
  }

  return (
    <>
      <header className="topbar quest-topbar">
        <div className="topbar-inner">
          <span className="brand">일머리</span>
          <span className="topbar-meta">
            <span className={`connection connection-${connection}`} role="status">{connectionLabels[connection]}</span>
            <span className={`ai-status ai-${aiStatus}`} title={aiStatus === 'connected' ? undefined : '화면 규칙으로 판단하고 있어요'}>{aiStatusLabels[aiStatus]}</span>
            {feed && (
              <button type="button" className={`feed-toggle${feed.running ? ' on' : ''}`} onClick={toggleFeed} title={feed.last_error}>
                {feed.running ? `자동 주문 켜짐 ${feed.created}건` : '자동 주문 켜기'}
              </button>
            )}
            <Link className="topbar-link" href="/kiosk" target="_blank">키오스크 열기</Link>
            <Link className="topbar-link" href="/delivery" target="_blank">배달 목업 열기</Link>
          </span>
        </div>
      </header>

      <main className="quest-layout">
        <aside className="agent-panel" aria-labelledby="agent-title">
          <div className="agent-identity">
            <WizardAvatar />
            <div>
              <h2 id="agent-title">일머리 마법사</h2>
              <p>재고와 주문 순서를 살펴보고 알려 줘요</p>
            </div>
          </div>
          <p className="agent-summary" role="status">{agentSummary?.text ?? '재고와 주문을 살펴보는 중이에요.'}</p>
          <ol
            className="agent-list"
            ref={agentList}
            aria-label="마법사 대화, 새 메시지가 아래에 붙어요"
            aria-live="polite"
            tabIndex={0}
            onScroll={(event) => {
              const list = event.currentTarget;
              stickToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
            }}
          >
            {agentLog.map((message) => <AgentMessage key={`${message.key}@${message.seen_at}`} message={message} onRestock={restock} busy={busy} />)}
            {agent && agentLog.length === 0 && <li className="agent-message"><p>지금은 알릴 재고나 매장 문제가 없어요.</p></li>}
          </ol>
          {agent && agent.inventory.length > 0 && (
            <section className="stock-list" aria-labelledby="stock-title">
              <h3 id="stock-title">재고 소모량 <span>급한 순서, 최근 {agent.recent_minutes}분과 오늘</span></h3>
              <ul tabIndex={0} aria-label="재고 소모량, 급한 순서">
                {agent.inventory.map((item) => (
                  <li key={item.id} className={`stock-row level-${item.level} status-${item.status}`} title={item.menus.length > 0 ? `쓰는 메뉴: ${item.menus.join(', ')}` : undefined}>
                    <span className="stock-name">{item.name_kr}</span>
                    <span className="stock-status">{item.status_label}</span>
                    <dl className="stock-usage">
                      <div><dt>최근 {agent.recent_minutes}분</dt><dd>{item.used_recent}</dd></div>
                      <div><dt>오늘</dt><dd>{item.used_today}</dd></div>
                      {item.used_today_real !== item.used_today && <div><dt>실제 주문</dt><dd>{item.used_today_real}</dd></div>}
                    </dl>
                    {item.note && <span className="stock-note">{item.note}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>

        <div className="quest-main">
          <section className="board-section" aria-labelledby="board-title">
            <div className="section-heading">
              <h2 id="board-title">일머리 보드</h2>
              <span className="section-meta">{queueCount > 0 ? `보드 밖 대기 ${queueCount}건` : '보드 밖 대기 없음'}</span>
            </div>
            {error && <p className="board-error" role="alert">{error}</p>}

            <p className="row-label">지금 만들 주문</p>
            <div className="quest-row" role="list" aria-label="고정 주문 4칸">
              {Array.from({ length: FIXED_COUNT }, (_, index) => {
                const order = fixedOrders[index];
                const slot = index + 1;
                if (!order) return <div key={slot} role="listitem" className="quest-card empty"><span className="slot-number">{slot}</span><p className="card-empty">빈 칸</p></div>;
                return (
                  <article key={slot} role="listitem" className={`quest-card fixed${index === 0 ? ' head' : ''}`} aria-label={`${slot}번 칸 ${order.order_id} 주문`}>
                    <div className="card-body" key={order.order_id}>
                      <button type="button" className="card-detail-trigger" aria-label={`${order.order_id} 주문 상세 보기`} aria-haspopup="dialog" onClick={() => setSelectedOrder(order)} />
                      <div className="card-head">
                        <span className="slot-number">{slot}</span>
                        <strong className="card-order">{order.order_id}</strong>
                        <span className="order-channel" data-channel={order.channel_label}>{order.channel_label}</span>
                        <span className="card-detail-arrow" aria-hidden="true" />
                      </div>
                      <p className="card-wait">{formatElapsed(order.received_at, now)}</p>
                      <OrderLines order={order} prepared={quest.prepared[order.order_id] ?? {}} />
                      <OrderFlags order={order} />
                      <div className="card-foot">
                        <button type="button" className="card-button complete" disabled={busy} onClick={() => completeOrder(order)}>완료</button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>

            <p className="row-label">Zoro가 고른 다음 주문 <span>위 칸이 비면 왼쪽부터 올라가요</span></p>
            <div className="quest-row" role="list" aria-label="다음 후보 주문 4칸">
              {Array.from({ length: CANDIDATE_COUNT }, (_, index) => {
                const candidate = candidates[index];
                const slot = FIXED_COUNT + index + 1;
                if (!candidate) return <div key={slot} role="listitem" className="quest-card empty candidate"><span className="slot-number">{slot}</span><p className="card-empty">빈 칸</p></div>;
                const { order, reason, source } = candidate;
                return (
                  <article key={slot} role="listitem" className={`quest-card candidate${index === 0 ? ' up-next' : ''}`} aria-label={`${slot}번 칸 ${order.order_id} 후보 주문`}>
                    <div className="card-body" key={order.order_id}>
                      <button type="button" className="card-detail-trigger" aria-label={`${order.order_id} 주문 상세 보기`} aria-haspopup="dialog" onClick={() => setSelectedOrder(order)} />
                      <div className="card-head">
                        <span className="slot-number">{slot}</span>
                        <strong className="card-order">{order.order_id}</strong>
                        <span className="order-channel" data-channel={order.channel_label}>{order.channel_label}</span>
                        <span className="card-detail-arrow" aria-hidden="true" />
                      </div>
                      <OrderLines order={order} prepared={quest.prepared[order.order_id] ?? {}} />
                      <p className="card-reason"><strong>{index === 0 && <span className="next-badge">다음 차례</span>}{originLabels[source]}</strong>{reason}</p>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="tip-section" aria-labelledby="tip-title" aria-live="polite">
            <div className="section-heading">
              <h2 id="tip-title">일머리 TIP</h2>
              {head && <span className="tip-status is-working">지금 1번 주문 {head.order_id}</span>}
            </div>
            {head && quest.plan ? (
              <ol className="tip-list">
                {quest.plan.lines.map((line, index) => (
                  <li key={line.kind === 'make' ? line.key : 'complete'} className={`tip-line${line.kind === 'complete' ? ' tip-complete' : ''}`}>
                    <span className="tip-step">{index + 1}</span>
                    <div>
                      <p className="tip-text">{tipText(line, slotOf)}</p>
                      <p className="tip-reason"><strong>{originLabels[quest.plan!.source ?? 'local']}</strong>{tipReason(line, head, slotOf, fixedOrders.length > 1)}</p>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="tip-empty">들어온 주문이 없어요. 키오스크나 배달 목업에서 주문을 넣어 보세요.</p>
            )}
          </section>
        </div>
      </main>
      <dialog ref={detailDialog} className="order-detail" aria-labelledby="order-detail-title" onClose={() => setSelectedOrder(null)}>
        {detail && (
          <>
            <div className="order-detail-heading">
              <h2 id="order-detail-title">{detail.order_id} 주문 상세</h2>
              <button type="button" className="secondary-button" onClick={() => detailDialog.current?.close()}>닫기</button>
            </div>
            <OrderDetail
              order={detail}
              prepared={quest.prepared[detail.order_id] ?? {}}
              reason={candidates.find(({ order }) => order.order_id === detail.order_id)?.reason}
              now={now}
            />
          </>
        )}
      </dialog>
    </>
  );
}
