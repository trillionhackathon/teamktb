'use client';

import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { callApi, orderPath } from './client/api.ts';
import { formatClock, formatElapsed, useBoardSnapshot, useNow, type Connection } from './client/use-board.ts';
import type { BoardReview, Decision, Note, QuickLane, Slot4Info } from './domain/types.ts';
import type { BoardSnapshot, OrderView } from './domain/views.ts';
import type { AgentResponse } from './api/agent/route.ts';
import type { AgentMessage as AgentMessageData } from './server/agent.ts';
import type { DemoFeedStatus } from './server/demo-feed.ts';
import WizardAvatar from './wizard-avatar.tsx';

const connectionLabels: Record<Connection, string> = { connecting: '연결 중', live: '실시간 연결됨', reconnecting: '재연결 중' };
const aiStatusLabels: Record<Decision['ai_status'], string> = { connected: 'AI 서버 연결됨', disabled: 'AI 서버 미설정', unavailable: 'AI 서버 미응답' };
const FIXED_COUNT = 4;
const WAITING_COUNT = 4;

// 위 4칸 설명. Zoro는 1번(기준)과 비슷한 2~4번만 본다.
function reviewHint(review: BoardReview, grouped: boolean): string {
  if (review.status === 'off') return '들어온 순서대로예요. AI 서버가 없어서 묶지 않아요';
  if (!review.anchor) return '들어온 순서대로예요';
  if (review.status === 'checking') return `들어온 순서대로예요. Zoro가 ${review.anchor} 주문과 비슷한 주문을 찾고 있어요`;
  if (review.status === 'unavailable') return '들어온 순서대로예요. Zoro가 답하지 못해서 묶지 못했어요';
  return grouped ? `들어온 순서대로예요. 같은 색끼리 같이 만들면 좋은 주문이에요` : `들어온 순서대로예요. ${review.anchor} 주문과 같이 만들 주문은 없어요`;
}

// 카드에 붙이는 묶음 이름표.
function groupTagText(group: BoardReview['groups'][string]): string {
  return group.role === 'anchor' ? '먼저 만들기' : '같이 만들기';
}

// 재고, 보드 순서, 최근 처리량으로 만든 마법사 메시지(/api/agent). 보드가 바뀔 때, 그리고 30초마다 다시 읽는다.
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
// 응답에서 빠진 알림은 해결된 것으로 흐리게 남긴다. 일하는 사람이 "채웠어요"로 처리를 확인한 재고 알림은 지운다.
// 이 브라우저 메모리에만 있다.
type AgentLogEntry = AgentMessageData & { key: string; seen_at: string; resolved: boolean };
const maxLogEntries = 50;

function useAgentLog(agent: AgentResponse | null): { summary: AgentMessageData | undefined; log: AgentLogEntry[]; dismissItem: (itemId: string) => void } {
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
  // 같은 재고의 지난 알림(해결됨으로 남은 것 포함)도 함께 지운다.
  const dismissItem = (itemId: string) => setLog((previous) => previous.filter((entry) => entry.action?.item_id !== itemId));
  return { summary: agent?.messages.find(({ id }) => id === 'summary'), log, dismissItem };
}

// 글 속 주문 번호(#118)를 약한 회색 칸으로 감싼다. 글 내용은 바꾸지 않는다.
function withOrderIds(text: string): ReactNode {
  return text.split(/(#\d+)/g).map((part, index) => (/^#\d+$/.test(part) ? <span key={index} className="order-id-chip">{part}</span> : part));
}

function AgentMessage({ message, onRestock, busy }: { message: AgentLogEntry; onRestock: (itemId: string) => void; busy: boolean }) {
  return (
    <li className={`agent-message level-${message.level}${message.resolved ? ' resolved' : ''}`}>
      <p>{withOrderIds(message.text)}</p>
      <div className="agent-message-meta">
        <strong>{message.resolved ? `${message.topic} 해결됨` : message.topic}</strong>
        <time dateTime={message.at ?? message.seen_at}>{formatClock(message.at ?? message.seen_at)}</time>
        {message.action && !message.resolved && <button type="button" className="agent-action" disabled={busy} onClick={() => onRestock(message.action!.item_id)}>{message.action.label}</button>}
      </div>
    </li>
  );
}

// 긴 주문은 잘리지 않게 칸을 넓히고 안에서 열을 나눈다. 메뉴 줄 수 기준: 1~3줄은 1칸 1열, 4~6줄은 1.7칸 2열, 7줄 이상은 2.4칸 3열.
// 주문 칸 수(4칸)와 순서는 그대로고, 한 줄 안에서 칸 너비만 나눠 가진다.
const columnsFor = (lines: number): 1 | 2 | 3 => (lines >= 7 ? 3 : lines >= 4 ? 2 : 1);
const weightFor = (lines: number): number => ({ 1: 1, 2: 1.7, 3: 2.4 })[columnsFor(lines)];
function rowColumns(orders: (OrderView | undefined)[]): CSSProperties {
  return { '--cols': orders.map((order) => `minmax(0, ${order ? weightFor(order.items.length) : 1}fr)`).join(' ') } as CSSProperties;
}

function OrderLines({ order }: { order: OrderView }) {
  return (
    <ul className={`card-items cols-${columnsFor(order.items.length)}`}>
      {order.items.map((item, index) => (
        <li key={index} className={item.made ? 'item-made' : undefined}>
          <span className="item-name">{item.name}</span>
          <span className="item-qty">{item.qty}{item.unit}</span>
          {item.options.length > 0 && <span className="item-options">{item.options.join(', ')}</span>}
        </li>
      ))}
    </ul>
  );
}

function OrderFlags({ order }: { order: OrderView }) {
  const flags = [
    order.made && { text: '✔ 만듦', tone: 'ok' },
    !order.made && order.prepped && { text: '재료 준비됨', tone: 'ok' },
    order.blocked_reason && { text: order.blocked_reason, tone: 'muted' },
    order.rider_status === 'arrived' && { text: '라이더 도착', tone: 'danger' },
    order.needs_confirmation && { text: '⚠ 확인 필요', tone: 'warn' },
    (order.overtaken ?? 0) > 0 && { text: `${order.overtaken}번 밀림`, tone: 'warn' },
    order.request_note && { text: `메모 ${order.request_note}`, tone: 'muted' },
  ].filter((flag): flag is { text: string; tone: string } => Boolean(flag));
  if (flags.length === 0) return null;
  return <div className="card-flags">{flags.map(({ text, tone }) => <p key={text} className={`card-flag tone-${tone}`}>{text}</p>)}</div>;
}

// 4번 칸 표시: "Zoro 고르는 중"(4번 칸이 빈 채로 Zoro 답을 기다림), "Zoro 0.78", "룰"(Zoro가 답하지 못함).
function slot4Label(slot4: Slot4Info): string {
  if (slot4.status === 'checking') return 'Zoro 고르는 중';
  if (slot4.source === 'zoro') return `Zoro ${(slot4.confidence ?? 0).toFixed(2)}`;
  return '룰';
}

// Zoro가 룰과 다르게 골랐으면 "룰은 #110 · 이유" 한 줄. 이유는 두 후보의 사실 문장이다(Zoro는 이유를 말하지 않는다).
function Slot4Reason({ slot4, full = false }: { slot4: Slot4Info; full?: boolean }) {
  const differs = slot4.source === 'zoro' && slot4.order_id !== slot4.rule_pick;
  if (!differs && !full) return null;
  const scores = Object.entries(slot4.scores ?? {}).sort(([, a], [, b]) => b - a);
  return (
    <div className={`card-reason slot4-reason${full ? ' full' : ''}`}>
      <strong><span className={`slot4-badge is-${slot4.status === 'checking' ? 'checking' : slot4.source}`}>{slot4Label(slot4)}</span>{differs ? `룰은 ${slot4.rule_pick}` : '4번 고른 근거'}</strong>
      {differs && <p>{slot4.rule_pick}: {slot4.facts[slot4.rule_pick]}</p>}
      {full && <p>{slot4.order_id}: {slot4.facts[slot4.order_id]}</p>}
      {full && scores.length > 0 && <p className="slot4-scores">Zoro 점수 {scores.map(([id, score]) => `${id} ${score.toFixed(2)}`).join(', ')}</p>}
    </div>
  );
}

const orderStatusLabels: Record<OrderView['status'], string> = { waiting: '대기 중', in_progress: '제조 중', done: '완료' };

function OrderDetail({ order, slot4, now }: { order: OrderView; slot4?: Slot4Info; now: number }) {
  return (
    <>
      <p className="order-detail-meta">
        <span className="order-channel" data-channel={order.channel_label}>{order.channel_label}</span>
        <span>{order.source_label}, {orderStatusLabels[order.status]}{order.slot ? `, ${order.slot}번 칸` : ''}</span>
      </p>
      <dl className="order-detail-facts">
        <div><dt>접수</dt><dd><time dateTime={order.received_at}>{formatClock(order.received_at)}</time>{order.status === 'waiting' && ` (${formatElapsed(order.received_at, now)})`}</dd></div>
        <div><dt>주문 금액</dt><dd>{order.price_krw.toLocaleString('ko-KR')}원</dd></div>
        {order.status !== 'done' && <div><dt>남은 제조 시간</dt><dd>{order.made ? '포장만 남음' : `${order.remaining_work_seconds}초`}</dd></div>}
        {order.rider_label && <div><dt>라이더</dt><dd>{order.rider_label}</dd></div>}
        {order.rider_eta_at && <div><dt>라이더 도착 예정</dt><dd><time dateTime={order.rider_eta_at}>{formatClock(order.rider_eta_at)}</time>{order.eta_confirmed ? ' (확인됨)' : ''}</dd></div>}
      </dl>
      <h3>주문 메뉴</h3>
      <OrderLines order={order} />
      <OrderFlags order={order} />
      {slot4 && slot4.order_id === order.order_id && <Slot4Reason slot4={slot4} full />}
    </>
  );
}

// 아래 제조 작업과 빠른 주문 카드.
function NoteCard({ note, busy, next, onComplete }: { note: Note; busy: boolean; next?: boolean; onComplete?: () => void }) {
  return (
    <li className={`note-card${note.kind === 'task' ? ' task-card' : ''}${note.done ? ' is-done' : ''}${next ? ' is-next' : ''}`}
      style={note.kind === 'task' && note.color ? ({ '--task-color': note.color } as CSSProperties) : undefined}>
      <div className="note-body">
        {next && <span className="task-next">다음 작업</span>}
        <p className="note-text">{withOrderIds(note.text)}</p>
        {note.parts && <p className="task-parts">{note.parts.map((part) => `${part.order_id} ${part.qty}${note.unit ?? '잔'}`).join(' · ')}</p>}
        {note.detail && <p className="note-detail">{withOrderIds(note.detail)}</p>}
        {note.reason && <p className="note-detail">{withOrderIds(note.reason)}</p>}
        {note.zoro && <p className="note-zoro">{withOrderIds(note.zoro)}</p>}
      </div>
      {note.done ? <span className="task-done">제조 완료됨</span> : onComplete && <button type="button" className="note-button" disabled={busy || note.ready === false} onClick={onComplete}>{note.kind === 'task' ? '제조 완료' : '내줬어요'}</button>}
    </li>
  );
}

// 8번 빠른 주문 칸. 1~4번 밖(화면 밖 포함)의 첫 디저트 전용 주문이 들어오고, 1번 레시피에 손이 비는 단계가 있으면 "지금 내보내기"가 된다.
function QuickLaneCard({ lane, order, slot, now, busy, onServe, onOpen }: {
  lane: QuickLane; order?: OrderView; slot: number; now: number; busy: boolean; onServe: (orderId: string) => void; onOpen: (order: OrderView) => void;
}) {
  const served = lane.served[0];
  if (!order) {
    return (
      <div role="listitem" className="quest-card quick-lane empty">
        <span className="slot-number">{slot}</span>
        <p className="quick-lane-title">빠른 주문 칸</p>
        <p className="card-empty">아이스크림이나 티라미수 주문이 오면 여기 떠요. 손이 빌 때 먼저 내주세요</p>
        {served && <p className="quick-lane-served">방금 {served.text}{served.text.endsWith('개') ? '를' : '을'} 먼저 냈어요</p>}
      </div>
    );
  }
  return (
    <article role="listitem" className={`quest-card quick-lane${lane.ready ? ' is-ready' : ''}`} aria-label={`${slot}번 빠른 주문 칸 ${order.order_id}`}>
      <div className="card-body" key={order.order_id}>
        <button type="button" className="card-detail-trigger" aria-label={`${order.order_id} 주문 상세 보기`} aria-haspopup="dialog" onClick={() => onOpen(order)} />
        <div className="card-head">
          <span className="slot-number">{slot}</span>
          <strong className="card-order">{order.order_id}</strong>
          <span className="order-channel" data-channel={order.channel_label}>{order.channel_label}</span>
          <span className="card-detail-arrow" aria-hidden="true" />
        </div>
        <p className="card-wait">{formatElapsed(order.received_at, now)}<span className="quick-tag">원래 {lane.fifo_position}번째</span></p>
        <OrderLines order={order} />
        <p className={`quick-lane-status${lane.ready ? ' ready' : ''}`}>
          {lane.ready && lane.idle ? `지금 내주세요 (${lane.hands_sec}초)` : `손이 빌 때 내주세요 (${lane.hands_sec}초)`}
        </p>
        <div className="card-foot">
          <button type="button" className="card-button complete" disabled={busy} onClick={() => onServe(order.order_id)}>내줬어요</button>
        </div>
      </div>
    </article>
  );
}

export default function Dashboard({ initial }: { initial: BoardSnapshot }) {
  const { snapshot: live, connection, clockOffset } = useBoardSnapshot(initial);
  const snapshot = live ?? initial;
  const now = useNow(clockOffset, 5000, Date.parse(initial.server_time));
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

  // 시연 장면 불러오기(보드를 그 장면의 시작 상태로 바꾼다)와 장면 입력 재생.
  async function loadScenario(scenarioId: string, trigger?: number) {
    setBusy(true);
    const result = await callApi('/api/scenarios', { body: trigger === undefined ? { scenario_id: scenarioId } : { scenario_id: scenarioId, trigger } });
    setBusy(false);
    setError(result.ok ? null : result.error);
  }

  async function toggleFeed() {
    const result = await callApi<DemoFeedStatus>('/api/demo-feed', { body: { running: !feed?.running } });
    if (result.ok) setFeed(result.data);
    else setError(result.error);
  }

  // 보드는 들어온 순서(FIFO)다. 위 4칸에서 Zoro가 1번과 비슷한 주문을 같은 색으로 묶는다.
  // 빠른 주문 칸을 쓰면 아래 줄은 5~7번(FIFO) + 8번(빠른 주문) 이다.
  const { review, quick_lane: lane } = snapshot;
  const fixedOrders = snapshot.board.filter(({ zone }) => zone === 'locked');
  const waitingOrders = snapshot.board.filter(({ zone }) => zone === 'flexible');
  const laneOrder = snapshot.board.find(({ zone }) => zone === 'quick');
  const fifoWaitingCount = WAITING_COUNT - (lane.enabled ? 1 : 0);
  const grouped = fixedOrders.some(({ order_id: id }) => review.groups[id]);
  const queueCount = snapshot.board.filter(({ zone }) => zone === 'queue').length;
  const { slot4 } = snapshot;
  const aiStatus = snapshot.decision.ai_status;
  const visibleNotes = snapshot.notes.filter((note) => note.kind !== 'head');
  const taskNotes = visibleNotes.filter((note) => note.kind === 'task');
  // 위 4칸 카드 색: 그 주문이 낀 작업(아래 팁 칸)과 같은 색을 쓴다. 한 주문이 작업 여러 개에 걸치면 마지막 작업 색을 쓴다(드묾).
  const orderTaskColor = Object.fromEntries(taskNotes.flatMap((note) => note.parts?.map(({ order_id }) => [order_id, note.color!]) ?? []));
  const nextTaskId = visibleNotes.find((note) => note.kind === 'task' && !note.done)?.id;
  const { agent, refresh: refreshAgent } = useAgent(snapshot.board.slice(0, FIXED_COUNT + WAITING_COUNT).map(({ order_id: id }) => id), snapshot.state_version);
  const { summary: agentSummary, log: agentLog, dismissItem } = useAgentLog(agent);
  const agentList = useRef<HTMLOListElement>(null);
  const stickToBottom = useRef(true);
  // 맨 아래를 보고 있을 때만 새 메시지를 따라 내려간다. 위로 올려 이전 대화를 읽는 중이면 그대로 둔다.
  useLayoutEffect(() => {
    const list = agentList.current;
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight;
  }, [agentLog]);
  const detail = selectedOrder && (snapshot.board.find(({ order_id: id }) => id === selectedOrder.order_id)
    ?? snapshot.history.find((order) => order.order_id === selectedOrder.order_id) ?? selectedOrder);

  // 일하는 사람이 실제로 채운 뒤 누른다. 재고를 주문 단위만큼 늘리고, 처리된 알림은 대화에서 지운다.
  async function restock(itemId: string) {
    setBusy(true);
    const result = await callApi('/api/inventory/restock', { body: { item_id: itemId } });
    setBusy(false);
    if (result.ok) {
      dismissItem(itemId);
      refreshAgent();
    }
    else setError(result.error);
  }

  // 시작 단계 없이 바로 완료한다. 서버는 대기 중인 주문의 완료도 받는다.
  async function completeOrder(order: OrderView) {
    setBusy(true);
    const result = await callApi(orderPath(order.order_id), { method: 'PATCH', body: { action: 'complete' } });
    setBusy(false);
    setError(result.ok ? null : result.error);
  }

  async function completeTask(noteId: string) {
    setBusy(true);
    const result = await callApi('/api/notes', { body: { note_id: noteId } });
    setBusy(false);
    setError(result.ok ? null : result.error);
  }

  // 빠른 주문 카드(8번 칸, 아래 팁 칸)의 버튼: 그 주문이 완료된다.
  async function serveQuick(orderId: string) {
    setBusy(true);
    const result = await callApi('/api/notes', { body: { note_id: `quick:${orderId}` } });
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
            <span className={`ai-status ai-${aiStatus}`} title={aiStatus === 'connected' ? undefined : '4번 칸은 룰로 골라요'}>{aiStatusLabels[aiStatus]}</span>
            {feed && (
              <button type="button" className={`feed-toggle${feed.running ? ' on' : ''}`} onClick={toggleFeed} title={feed.last_error}>
                {feed.running ? `자동 주문 켜짐 ${feed.created}건` : '자동 주문 켜기'}
              </button>
            )}
            <span className="scenario-control">
              <select aria-label="시연 장면" value={snapshot.scenario?.id ?? ''} disabled={busy} onChange={(event) => void loadScenario(event.target.value)}>
                {snapshot.scenarios.map(({ id, title }) => <option key={id} value={id}>{id} {title}</option>)}
              </select>
              {snapshot.scenario?.triggers.map((label, index) => (
                <button key={label} type="button" className="secondary-button" disabled={busy} onClick={() => void loadScenario(snapshot.scenario!.id, index)}>{label}</button>
              ))}
            </span>
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
                    {item.note && <span className="stock-note">{withOrderIds(item.note)}</span>}
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

            <p className="row-label">지금 만들 주문 <span>{reviewHint(review, grouped)}</span></p>
            <div className="quest-row" role="list" aria-label="고정 주문 4칸" style={rowColumns(Array.from({ length: FIXED_COUNT }, (_, index) => fixedOrders[index]))}>
              {Array.from({ length: FIXED_COUNT }, (_, index) => {
                const order = fixedOrders[index];
                const slot = index + 1;
                if (!order) return <div key={slot} role="listitem" className="quest-card empty"><span className="slot-number">{slot}</span><p className="card-empty">빈 칸</p></div>;
                const group = review.groups[order.order_id];
                const color = group && (orderTaskColor[order.order_id] ?? group.color);
                return (
                  <article key={slot} role="listitem" className={`quest-card fixed${group ? ' grouped' : ''}${order.made ? ' is-made' : ''}`}
                    style={color ? ({ '--group': color } as CSSProperties) : undefined}
                    aria-label={`${slot}번 칸 ${order.order_id} 주문${group ? `, ${groupTagText(group)}` : ''}`}>
                    <div className="card-body" key={order.order_id}>
                      <button type="button" className="card-detail-trigger" aria-label={`${order.order_id} 주문 상세 보기`} aria-haspopup="dialog" onClick={() => setSelectedOrder(order)} />
                      <div className="card-head">
                        <span className="slot-number">{slot}</span>
                        <strong className="card-order">{order.order_id}</strong>
                        <span className="order-channel" data-channel={order.channel_label}>{order.channel_label}</span>
                        <span className="card-detail-arrow" aria-hidden="true" />
                      </div>
                      <p className="card-wait">{formatElapsed(order.received_at, now)}{group && <span className="group-tag" style={{ background: color }}>{groupTagText(group)}</span>}</p>
                      <OrderLines order={order} />
                      <OrderFlags order={order} />
                      <div className="card-foot">
                        <button type="button" className="card-button complete" disabled={busy} onClick={() => completeOrder(order)}>{index === 0 ? '완료' : '먼저 완료'}</button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>

            <p className="row-label">대기 주문 <span>위 주문이 끝나면 들어온 순서대로 올라가요{lane.enabled ? '. 8번은 빨리 끝나는 디저트 칸이에요' : ''}</span></p>
            <div className="quest-row" role="list" aria-label={lane.enabled ? '대기 주문 3칸과 빠른 주문 칸' : '대기 주문 4칸'}
              style={rowColumns([...Array.from({ length: fifoWaitingCount }, (_, index) => waitingOrders[index]), ...(lane.enabled ? [laneOrder] : [])])}>
              {Array.from({ length: fifoWaitingCount }, (_, index) => {
                const order = waitingOrders[index];
                const slot = FIXED_COUNT + index + 1;
                if (!order) return <div key={slot} role="listitem" className="quest-card empty candidate"><span className="slot-number">{slot}</span><p className="card-empty">빈 칸</p></div>;
                return (
                  <article key={slot} role="listitem" className={`quest-card candidate${order.made ? ' is-made' : ''}`} aria-label={`${slot}번 칸 ${order.order_id} 대기 주문`}>
                    <div className="card-body" key={order.order_id}>
                      <button type="button" className="card-detail-trigger" aria-label={`${order.order_id} 주문 상세 보기`} aria-haspopup="dialog" onClick={() => setSelectedOrder(order)} />
                      <div className="card-head">
                        <span className="slot-number">{slot}</span>
                        <strong className="card-order">{order.order_id}</strong>
                        <span className="order-channel" data-channel={order.channel_label}>{order.channel_label}</span>
                        <span className="card-detail-arrow" aria-hidden="true" />
                      </div>
                      <p className="card-wait">{formatElapsed(order.received_at, now)}</p>
                      <OrderLines order={order} />
                      <OrderFlags order={order} />
                    </div>
                  </article>
                );
              })}
              {lane.enabled && (
                <QuickLaneCard lane={lane} order={laneOrder} slot={FIXED_COUNT + WAITING_COUNT} now={now} busy={busy} onServe={serveQuick} onOpen={setSelectedOrder} />
              )}
            </div>
          </section>

          <section className="notice-section" aria-labelledby="notice-title" aria-live="polite">
            <div className="section-heading">
              <h2 id="notice-title">지금 만들 작업</h2>
              <span className="section-meta">{visibleNotes.filter((note) => note.kind === 'task' && !note.done).length}건 남음</span>
            </div>
            {taskNotes.length > 0 && (
              <ul className="group-legend" aria-label="제조 작업 색상">
                {taskNotes.map((note) => <li key={note.id} style={{ color: note.color, borderColor: note.color }}>
                  <i style={{ background: note.color }} aria-hidden="true" />{note.text}
                </li>)}
              </ul>
            )}
            {review.status === 'checking' && <p className="note-status">먼저 1번 주문을 만드세요. 함께 만들 메뉴를 확인 중이에요.</p>}
            {review.status === 'unavailable' && <p className="note-status">함께 만들 메뉴를 확인하지 못했어요. 먼저 1번 주문을 만드세요.</p>}
            {visibleNotes.length > 0 ? (
              <ul className="note-list">
                {visibleNotes.map((note) => (
                  <NoteCard key={note.id} note={note} busy={busy} next={note.id === nextTaskId}
                    onComplete={note.kind === 'task' ? () => completeTask(note.id) : note.kind === 'quick' ? () => serveQuick(note.order_ids[0]) : undefined} />
                ))}
              </ul>
            ) : <p className="tip-empty">지금 만들 주문이 없어요.</p>}
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
            <OrderDetail order={detail} slot4={slot4} now={now} />
          </>
        )}
      </dialog>
    </>
  );
}
