'use client';

import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { callApi, orderPath } from './client/api.ts';
import { formatClock, formatElapsed, useBoardSnapshot, useNow, type Connection } from './client/use-board.ts';
import type { Decision, Slot4Info, WorkStep } from './domain/types.ts';
import type { BoardSnapshot, OrderView } from './domain/views.ts';
import type { AgentResponse } from './api/agent/route.ts';
import type { AgentMessage as AgentMessageData } from './server/agent.ts';
import type { DemoFeedStatus } from './server/demo-feed.ts';
import WizardAvatar from './wizard-avatar.tsx';

const connectionLabels: Record<Connection, string> = { connecting: '연결 중', live: '실시간 연결됨', reconnecting: '재연결 중' };
const aiStatusLabels: Record<Decision['ai_status'], string> = { connected: 'AI 서버 연결됨', disabled: 'AI 서버 미설정', unavailable: 'AI 서버 미응답' };
const FIXED_COUNT = 4;
const WAITING_COUNT = 4;

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

function OrderLines({ order }: { order: OrderView }) {
  return (
    <ul className="card-items">
      {order.items.map((item, index) => (
        <li key={index}>
          <span className="item-name">{item.name}</span>
          <span className="item-qty">{item.qty}잔</span>
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

// 4번 칸 표시: "확인 중"(룰 선택을 먼저 넣고 Zoro 답을 기다림), "Zoro 0.78", "룰".
function slot4Label(slot4: Slot4Info): string {
  if (slot4.status === 'checking') return '확인 중';
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
      {differs && <p>{slot4.rule_pick} · {slot4.facts[slot4.rule_pick]}</p>}
      {full && <p>{slot4.order_id} · {slot4.facts[slot4.order_id]}</p>}
      {full && scores.length > 0 && <p className="slot4-scores">Zoro 점수 {scores.map(([id, score]) => `${id} ${score.toFixed(2)}`).join(' · ')}</p>}
    </div>
  );
}

const orderStatusLabels: Record<OrderView['status'], string> = { waiting: '대기 중', in_progress: '제조 중', done: '완료' };

function OrderDetail({ order, slot4, now }: { order: OrderView; slot4?: Slot4Info; now: number }) {
  return (
    <>
      <p className="order-detail-meta">
        <span className="order-channel" data-channel={order.channel_label}>{order.channel_label}</span>
        <span>{order.source_label} · {orderStatusLabels[order.status]}{order.slot ? ` · ${order.slot}번 칸` : ''}</span>
      </p>
      <dl className="order-detail-facts">
        <div><dt>접수</dt><dd><time dateTime={order.received_at}>{formatClock(order.received_at)}</time>{order.status === 'waiting' && ` · ${formatElapsed(order.received_at, now)}`}</dd></div>
        <div><dt>주문 금액</dt><dd>{order.price_krw.toLocaleString('ko-KR')}원</dd></div>
        {order.status !== 'done' && <div><dt>남은 제조 시간</dt><dd>{order.made ? '포장만 남음' : `${order.remaining_work_seconds}초`}</dd></div>}
        {order.rider_label && <div><dt>라이더</dt><dd>{order.rider_label}</dd></div>}
        {order.rider_eta_at && <div><dt>라이더 도착 예정</dt><dd><time dateTime={order.rider_eta_at}>{formatClock(order.rider_eta_at)}</time>{order.eta_confirmed ? ' · 확인됨' : ''}</dd></div>}
      </dl>
      <h3>주문 메뉴</h3>
      <OrderLines order={order} />
      <OrderFlags order={order} />
      {slot4 && slot4.order_id === order.order_id && <Slot4Reason slot4={slot4} full />}
    </>
  );
}

function WorkWindow({ steps, head, busy, onComplete }: { steps: WorkStep[]; head?: OrderView; busy: boolean; onComplete: (order: OrderView) => void }) {
  if (!head || steps.length === 0) return <p className="tip-empty">들어온 주문이 없어요. 키오스크나 배달 목업에서 주문을 넣어 보세요.</p>;
  return (
    <ol className="tip-list work-list">
      {steps.map((step, index) => (
        <li key={`${index}:${step.text}`} className={`tip-line work-${step.kind}${step.kind === 'done' ? ' tip-complete' : ''}`}>
          <span className="tip-step">{index + 1}</span>
          <div className="work-step-body">
            <p className="tip-text">{step.text}</p>
            {step.kind === 'done' && (
              <button type="button" className="card-button complete work-complete" disabled={busy} onClick={() => onComplete(head)}>{head.order_id} 완료</button>
            )}
          </div>
        </li>
      ))}
    </ol>
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

  async function toggleFeed() {
    const result = await callApi<DemoFeedStatus>('/api/demo-feed', { body: { running: !feed?.running } });
    if (result.ok) setFeed(result.data);
    else setError(result.error);
  }

  // 보드 칸은 서버가 정한다. 1~4번 고정, 5~8번 대기(들어온 순서), 그 뒤는 화면 밖 대기열.
  const fixedOrders = snapshot.board.filter(({ zone }) => zone === 'locked');
  const waitingOrders = snapshot.board.filter(({ zone }) => zone === 'flexible');
  const queueCount = snapshot.board.filter(({ zone }) => zone === 'queue').length;
  const head = fixedOrders[0];
  const { slot4 } = snapshot;
  const aiStatus = snapshot.decision.ai_status;
  const { agent, refresh: refreshAgent } = useAgent(snapshot.board.slice(0, FIXED_COUNT + WAITING_COUNT).map(({ order_id: id }) => id), snapshot.state_version);
  const { summary: agentSummary, log: agentLog } = useAgentLog(agent);
  const agentList = useRef<HTMLOListElement>(null);
  const stickToBottom = useRef(true);
  // 맨 아래를 보고 있을 때만 새 메시지를 따라 내려간다. 위로 올려 이전 대화를 읽는 중이면 그대로 둔다.
  useLayoutEffect(() => {
    const list = agentList.current;
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight;
  }, [agentLog]);
  const detail = selectedOrder && (snapshot.board.find(({ order_id: id }) => id === selectedOrder.order_id)
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
            <span className={`ai-status ai-${aiStatus}`} title={aiStatus === 'connected' ? undefined : '4번 칸은 룰로 골라요'}>{aiStatusLabels[aiStatus]}</span>
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

            <p className="row-label">지금 만들 주문 <span>1번 완료까지 작업창 순서대로</span></p>
            <div className="quest-row" role="list" aria-label="고정 주문 4칸">
              {Array.from({ length: FIXED_COUNT }, (_, index) => {
                const order = fixedOrders[index];
                const slot = index + 1;
                if (!order) return <div key={slot} role="listitem" className="quest-card empty"><span className="slot-number">{slot}</span><p className="card-empty">빈 칸</p></div>;
                const picked = slot === FIXED_COUNT && slot4?.order_id === order.order_id ? slot4 : undefined;
                return (
                  <article key={slot} role="listitem" className={`quest-card fixed${index === 0 ? ' head' : ''}${picked ? ' picked' : ''}`} aria-label={`${slot}번 칸 ${order.order_id} 주문`}>
                    <div className="card-body" key={order.order_id}>
                      <button type="button" className="card-detail-trigger" aria-label={`${order.order_id} 주문 상세 보기`} aria-haspopup="dialog" onClick={() => setSelectedOrder(order)} />
                      <div className="card-head">
                        <span className="slot-number">{slot}</span>
                        <strong className="card-order">{order.order_id}</strong>
                        {picked && <span className={`slot4-badge is-${picked.status === 'checking' ? 'checking' : picked.source}`}>{slot4Label(picked)}</span>}
                        <span className="order-channel" data-channel={order.channel_label}>{order.channel_label}</span>
                        <span className="card-detail-arrow" aria-hidden="true" />
                      </div>
                      <p className="card-wait">{formatElapsed(order.received_at, now)}</p>
                      <OrderLines order={order} />
                      <OrderFlags order={order} />
                      {picked && <Slot4Reason slot4={picked} />}
                      <div className="card-foot">
                        <button type="button" className="card-button complete" disabled={busy} onClick={() => completeOrder(order)}>{index === 0 ? '완료' : '먼저 완료'}</button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>

            <p className="row-label">대기 주문 <span>들어온 순서 · 1번 완료 때 이 중 하나를 골라 4번에 넣어요</span></p>
            <div className="quest-row" role="list" aria-label="대기 주문 4칸">
              {Array.from({ length: WAITING_COUNT }, (_, index) => {
                const order = waitingOrders[index];
                const slot = FIXED_COUNT + index + 1;
                if (!order) return <div key={slot} role="listitem" className="quest-card empty candidate"><span className="slot-number">{slot}</span><p className="card-empty">빈 칸</p></div>;
                return (
                  <article key={slot} role="listitem" className="quest-card candidate" aria-label={`${slot}번 칸 ${order.order_id} 대기 주문`}>
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
            </div>
          </section>

          <section className="tip-section" aria-labelledby="tip-title" aria-live="polite">
            <div className="section-heading">
              <h2 id="tip-title">작업창</h2>
              {head && <span className="tip-status is-working">1~4번을 같이 보고 · 1번 {head.order_id} 완료까지</span>}
            </div>
            <WorkWindow steps={snapshot.work_window} head={head} busy={busy} onComplete={completeOrder} />
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
