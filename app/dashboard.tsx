'use client';

import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { callApi, createRequestId, orderPath } from './client/api.ts';
import { formatClock, formatElapsed, useBoardSnapshot, useNow, type Connection } from './client/use-board.ts';
import type { MenuItemInput } from './domain/types.ts';
import type { BoardSnapshot, OrderItemView, OrderView } from './domain/views.ts';

// 예시 주문은 MVP 3종(아아·라떼·딸기스무디, recipe.json mvp_menus)으로 만든다.
const demoOrders: { channel: 'dine-in' | 'takeout' | 'delivery'; menu_items: MenuItemInput[]; request_note?: string }[] = [
  { channel: 'takeout', menu_items: [{ menu: 'iced_americano', qty: 1 }] },
  { channel: 'dine-in', menu_items: [{ menu: 'latte', qty: 2, options: ['milk_oat'] }] },
  { channel: 'delivery', menu_items: [{ menu: 'strawberry_smoothie', qty: 1 }, { menu: 'iced_americano', qty: 2, options: ['ice_less'] }], request_note: '얼음 적게 부탁드려요' },
  { channel: 'dine-in', menu_items: [{ menu: 'iced_americano', qty: 2, options: ['shot_add'] }] },
  { channel: 'takeout', menu_items: [{ menu: 'latte', qty: 1 }, { menu: 'strawberry_smoothie', qty: 1 }] },
];

const connectionLabels: Record<Connection, string> = { connecting: '연결 중', live: '실시간 연결됨', reconnecting: '재연결 중' };

function decisionLabel(decision: BoardSnapshot['decision']): string {
  if (decision.ai_status === 'disabled') return '규칙 판단 · AI 서버 미설정';
  if (decision.ai_status === 'unavailable') return '규칙 판단 · AI 서버 미응답';
  return decision.source === 'zoro' ? 'AI 서버 · Zoro 판단' : 'AI 서버 · 규칙 판단';
}

function waitLabel(seconds: number | undefined): string {
  return seconds === undefined ? '-' : `약 ${Math.max(1, Math.ceil(seconds / 60))}분`;
}

function OrderItems({ items }: { items: OrderItemView[] }) {
  return (
    <ul className="order-items" aria-label="제조할 음료">
      {items.map(({ name, qty, options }, index) => (
        <li key={index}>
          <div className="order-item-main"><strong>{name}</strong><span>{qty}잔</span></div>
          {options.length > 0 && <p className="order-item-note">{options.join(', ')}</p>}
        </li>
      ))}
    </ul>
  );
}

function OrderFlags({ order }: { order: OrderView }) {
  return (
    <>
      {order.blocked_reason && <p className="ticket-flag flag-blocked">{order.blocked_reason}</p>}
      {order.needs_confirmation && <p className="ticket-flag flag-confirm">{order.order_id} 픽업 시간을 확인해 주세요</p>}
      {order.eta_confirmed && order.pickup_eta_seconds != null && <p className="ticket-flag">픽업 {Math.round(order.pickup_eta_seconds / 60)}분 뒤 확정</p>}
      {order.rider_status === 'arrived' && <p className="ticket-flag flag-event">라이더 도착</p>}
      {order.request_note && <p className="ticket-note">요청사항 {order.request_note}</p>}
    </>
  );
}

export default function Dashboard({ initial }: { initial: BoardSnapshot }) {
  const { snapshot: live, connection, clockOffset } = useBoardSnapshot(initial);
  const snapshot = live ?? initial;
  const now = useNow(clockOffset);
  const [entry, setEntry] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoReceive, setAutoReceive] = useState(false);
  const [scenarioId, setScenarioId] = useState(snapshot.scenario?.id ?? '');
  const demoIndex = useRef(0);
  const boardRef = useRef<HTMLDivElement>(null);
  const previousPositions = useRef(new Map<string, DOMRect>());

  const { board, config, decision } = snapshot;
  const visible = board.filter(({ zone }) => zone !== 'queue');
  const queue = board.filter(({ zone }) => zone === 'queue');
  const flexible = board.filter(({ zone }) => zone === 'flexible');
  const active = board.find(({ status }) => status === 'in_progress');
  const next = active ?? board.find(({ status, blocked_reason: blocked }) => status === 'waiting' && !blocked);
  const latestEvent = snapshot.events[0];

  useEffect(() => {
    if (snapshot.scenario) setScenarioId(snapshot.scenario.id);
  }, [snapshot.scenario?.id]);

  // 순서가 바뀐 카드는 이전 자리에서 새 자리로 미끄러지듯 이동한다.
  useLayoutEffect(() => {
    const cards = boardRef.current?.querySelectorAll<HTMLElement>('[data-order-id]');
    if (!cards) return;
    const positions = new Map(Array.from(cards, (card) => [card.dataset.orderId!, card.getBoundingClientRect()]));
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const card of cards) {
        const previous = previousPositions.current.get(card.dataset.orderId!);
        const current = positions.get(card.dataset.orderId!)!;
        if (!previous || (previous.left === current.left && previous.top === current.top)) continue;
        card.animate([{ transform: `translate(${previous.left - current.left}px, ${previous.top - current.top}px)` }, { transform: 'translate(0, 0)' }], { duration: 260, easing: 'ease-out' });
      }
    }
    previousPositions.current = positions;
  });

  useEffect(() => {
    if (!autoReceive) return;
    const timer = window.setInterval(() => { void addDemoOrder(); }, 8000);
    return () => window.clearInterval(timer);
  }, [autoReceive]);

  async function run<T>(action: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, success?: (data: T) => string) {
    setBusy(true);
    const result = await action();
    setBusy(false);
    if (result.ok) setNotice(success ? { text: success(result.data), error: false } : null);
    else setNotice({ text: result.error, error: true });
    return result;
  }

  function addDemoOrder() {
    const sample = demoOrders[demoIndex.current % demoOrders.length];
    demoIndex.current += 1;
    return run(
      () => callApi<{ order: OrderView }>('/api/orders', { body: { ...sample, source: 'demo', request_id: createRequestId('demo') } }),
      ({ order }) => `${order.order_id} 예시 주문이 접수됐어요.`,
    );
  }

  function changeStatus(order: OrderView, action: 'start' | 'complete') {
    return run(() => callApi(orderPath(order.order_id), { method: 'PATCH', body: { action } }));
  }

  function submitEvent(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = entry.trim();
    if (!text) return;
    void run(() => callApi('/api/events', { body: { event_id: createRequestId('event'), raw_text: text } })).then((result) => {
      if (result.ok) setEntry('');
    });
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <span className="brand">일머리</span>
          <span className="topbar-meta">
            <span className={`connection connection-${connection}`} role="status">{connectionLabels[connection]}</span>
            <Link className="topbar-link" href="/kiosk" target="_blank">키오스크 열기</Link>
            <Link className="topbar-link" href="/delivery" target="_blank">배달 목업 열기</Link>
          </span>
        </div>
      </header>

      <main className="dashboard">
        <div className="board-heading">
          <div>
            <p className="board-context">{snapshot.scenario ? `${snapshot.scenario.id} · ${snapshot.scenario.title}` : '실시간 주문'}</p>
            <h1>주방 운영 보드</h1>
          </div>
          <dl className="totals" aria-label="주문 상태 요약">
            <div><dt>대기</dt><dd>{snapshot.counts.waiting}</dd></div>
            <div><dt>제조 중</dt><dd>{snapshot.counts.in_progress}</dd></div>
            <div><dt>완료</dt><dd>{snapshot.counts.done}</dd></div>
            <div><dt>대기열</dt><dd>{queue.length}</dd></div>
          </dl>
        </div>

        <section className="orders-panel" aria-labelledby="orders-title">
          <div className="panel-heading">
            <h2 id="orders-title">주문 보드</h2>
            <span className="panel-meta">윗줄 1~{config.lockedCount}번 접수순 고정 · 아랫줄 {config.lockedCount + 1}~{config.visibleCount}번 재배치</span>
          </div>
          <div className="board-grid" ref={boardRef} role="region" aria-label="2줄 5칸 주문 보드" tabIndex={0}>
            {visible.map((order) => (
              <article
                key={order.order_id}
                data-order-id={order.order_id}
                className={`order-ticket${order.order_id === next?.order_id ? ' recommended' : ''}${order.move_reason ? ' moved' : ''}${order.blocked_reason ? ' blocked' : ''}`}
                aria-label={`${order.slot}번 칸 ${order.order_id} 주문`}
              >
                <div className="ticket-slot">
                  <span>{order.slot}번 칸 · {order.zone === 'locked' ? '고정' : '재배치'}</span>
                  <span className="ticket-status">{order.status === 'in_progress' ? '제조 중' : order.order_id === next?.order_id ? '다음 작업' : ''}</span>
                </div>
                <div className="ticket-top">
                  <strong className="order-number">{order.order_id}</strong>
                  <div className="ticket-channel"><span className="order-channel" data-channel={order.channel_label}>{order.channel_label}</span><span>{order.source_label}</span></div>
                </div>
                <div className="ticket-meta"><span>{formatClock(order.received_at)} 접수</span><span>{formatElapsed(order.received_at, now)}</span></div>
                <OrderItems items={order.items} />
                {order.move_reason && <p className="ticket-flag flag-event">{order.move_reason}</p>}
                <OrderFlags order={order} />
                <div className="ticket-bottom">
                  <span>완료 {waitLabel(order.eta_seconds)}</span>
                  {order.status === 'in_progress'
                    ? <button type="button" className="ticket-button" disabled={busy} onClick={() => changeStatus(order, 'complete')}>완료</button>
                    : <button type="button" className="ticket-button" disabled={busy || Boolean(order.blocked_reason)} onClick={() => changeStatus(order, 'start')}>시작</button>}
                </div>
              </article>
            ))}
            {visible.length === 0 && <p className="board-empty">대기 중인 주문이 없어요. 키오스크나 배달 목업에서 주문을 넣어 보세요.</p>}
          </div>
          {queue.length > 0 && (
            <div className="queue-strip" aria-label="화면 밖 대기열">
              <span className="queue-label">대기열 {queue.length}건</span>
              <ol>
                {queue.map((order) => (
                  <li key={order.order_id}>
                    <strong>{order.order_id}</strong> {order.items.map(({ name, qty }) => `${name} ${qty}잔`).join(', ')}
                    <span>{order.channel_label} · {order.source_label} · 완료 {waitLabel(order.eta_seconds)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>

        <div className="dashboard-grid">
          <section className="panel ranking-panel" aria-labelledby="ranking-title">
            <div className="panel-heading">
              <h2 id="ranking-title">Zoro 우선순위 판단</h2>
              <span className="panel-meta" title={decision.ai_error}>{decisionLabel(decision)}</span>
            </div>
            <div className="ranking-labels" aria-hidden="true"><span>칸</span><span>재배치 대상</span><span>완료</span></div>
            <ol className="ranking-list" aria-label="재배치칸 판단 결과" tabIndex={0}>
              {flexible.map((order) => {
                const move = decision.moves.find(({ order_id: id }) => id === order.order_id);
                return (
                  <li className={`rank-row${move ? ' rank-event' : ''}`} key={order.order_id}>
                    <div className="rank-position">
                      <strong>{order.slot}</strong>
                      {move && <span className="rank-movement up" role="img" aria-label={`${move.from}번에서 ${move.to}번으로 이동`}>↑{move.from - move.to}</span>}
                    </div>
                    <div className="rank-order">
                      <strong><span>{order.order_id}</span> {[...new Set(order.items.map(({ name }) => name))].join(', ')}</strong>
                      <p>{order.blocked_reason ?? order.move_reason ?? (order.status === 'in_progress' ? '제조 중' : '접수순 유지')}</p>
                    </div>
                    <strong className="rank-score">{waitLabel(order.eta_seconds)}</strong>
                  </li>
                );
              })}
              {flexible.length === 0 && <li className="empty-rank">재배치할 6~10번 칸 주문이 없어요.</li>}
            </ol>
            {snapshot.tips.length > 0 && (
              <ul className="ai-tips" aria-label="일머리 팁">
                {snapshot.tips.map((tip) => (
                  <li key={tip.id}>
                    <span>일머리 팁 · {tip.source}</span>{tip.text}
                    <button type="button" className="tip-dismiss" disabled={busy} onClick={() => run(() => callApi(`/api/tips/${encodeURIComponent(tip.id)}`, { method: 'DELETE' }))}>해제</button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel event-panel" aria-labelledby="event-title">
            <div className="panel-heading"><h2 id="event-title">매장 상황</h2><span className="panel-meta">원두 {snapshot.signals.inventory.coffee_beans_shots_left}샷 · 딸기 {snapshot.signals.inventory.strawberry_servings_left}인분</span></div>
            <div className="scenario-picker">
              <label htmlFor="scenario-select">시나리오</label>
              <div className="input-wrap">
                <select id="scenario-select" value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
                  {snapshot.scenarios.map(({ id, title }) => <option key={id} value={id}>{id} · {title}</option>)}
                </select>
                <button type="button" disabled={busy || !scenarioId} onClick={() => run(() => callApi('/api/scenarios', { body: { scenario_id: scenarioId } }), () => '시나리오 시작 상태로 바꿨어요.')}>불러오기</button>
              </div>
              {snapshot.scenario && snapshot.scenario.triggers.length > 0 && (
                <div className="event-examples" aria-label="시나리오 입력 재생">
                  {snapshot.scenario.triggers.map((label, index) => (
                    <button type="button" key={label} disabled={busy} onClick={() => run(() => callApi('/api/scenarios', { body: { scenario_id: snapshot.scenario!.id, trigger: index } }))}>{index + 1}. {label}</button>
                  ))}
                </div>
              )}
              {snapshot.scenario && <p className="scenario-expected">기대 결과 {snapshot.scenario.expected}</p>}
            </div>
            <div className={`event-log${latestEvent && !latestEvent.needs_confirmation ? ' event-applied' : ''}`} aria-live="polite">
              <div className="event-meta">
                <span>{latestEvent ? `최근 입력 · ${formatClock(latestEvent.received_at)}` : '최근 입력'}</span>
                <span>{latestEvent ? (latestEvent.needs_confirmation ? '확인 필요' : latestEvent.category) : '-'}</span>
              </div>
              <p className="event-message">{latestEvent ? latestEvent.raw_text : '아직 입력된 상황이 없어요.'}</p>
              {latestEvent && <p className="event-summary">{latestEvent.summary}{latestEvent.intent ? ` · AI 분류 ${latestEvent.intent.intent} (${latestEvent.intent.source})` : ''}</p>}
            </div>
            <form className="event-form" onSubmit={submitEvent}>
              <label htmlFor="event-entry">상황 입력</label>
              <div className="input-wrap">
                <input id="event-entry" value={entry} onChange={(e) => setEntry(e.target.value)} placeholder="예: 108번 라이더 도착했어요" maxLength={300} />
                <button type="submit" disabled={busy || !entry.trim()}>상황 반영</button>
              </div>
            </form>
            {notice && <p className={`dashboard-notice${notice.error ? ' error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
          </section>

          <section className="action-panel" aria-labelledby="action-title" aria-live="polite">
            <h2 id="action-title">{active ? '제조 중' : '지금 할 작업'}</h2>
            {next ? <>
              <p className="action-task">{next.items.length === 1 ? `${next.items[0].name} ${next.items[0].qty}잔 만들기` : `주문 ${next.order_id} 제조하기`}</p>
              <div className="action-detail">
                <span>주문 {next.order_id} · {next.slot}번 칸</span>
                <span>남은 작업 {Math.ceil(next.remaining_work_seconds / 60)}분 이내</span>
                {next.request_note && <span>요청사항 {next.request_note}</span>}
              </div>
              {next.items.length > 1 && <OrderItems items={next.items} />}
              <button className="action-button" type="button" disabled={busy} onClick={() => changeStatus(next, active ? 'complete' : 'start')}>{active ? '제조 완료' : '제조 시작'}</button>
            </> : <p className="action-task">모든 주문이 완료됐어요</p>}
          </section>

          <section className="panel incoming-panel" aria-labelledby="incoming-title">
            <div className="panel-heading">
              <h2 id="incoming-title">주문 접수 내역</h2>
              <span className="panel-meta" aria-live="polite">총 {snapshot.counts.waiting + snapshot.counts.in_progress + snapshot.counts.done}건</span>
            </div>
            <ol className="incoming-list" aria-label="최근 접수 주문부터 표시" tabIndex={0}>
              {snapshot.history.map((order) => (
                <li className={`incoming-row${order.status === 'done' ? ' done' : ''}`} key={order.order_id}>
                  <span className="incoming-id">{order.order_id}</span>
                  <div>
                    <OrderItems items={order.items} />
                    {order.request_note && <p className="incoming-note">{order.request_note}</p>}
                  </div>
                  <div className="incoming-meta">
                    <span className="order-channel" data-channel={order.channel_label}>{order.channel_label}</span>
                    <span>{order.source_label}</span>
                    <span>{order.status === 'done' ? '완료' : order.status === 'in_progress' ? '제조 중' : formatClock(order.received_at)}</span>
                  </div>
                </li>
              ))}
            </ol>
            <div className="incoming-controls">
              <button className="secondary-button" type="button" onClick={() => setAutoReceive((previous) => !previous)}>{autoReceive ? '자동 접수 중지' : '자동 접수 시작'}</button>
              <button className="secondary-button" type="button" disabled={busy} onClick={() => { void addDemoOrder(); }}>예시 주문 추가</button>
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
