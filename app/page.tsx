'use client';

import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { appendDemoOrder, appendOrder, formatTime, initialOrders, initialTime, situationExamples, type OrderItem } from './demo-data';
import { decideDemoPriority, rankWaitingOrders, type PriorityAdjustment } from './demo-priority';
import { isOrderDetails, openOrderChannel } from './order-channel';

const initialEventOrder = initialOrders[2];

function OrderItems({ items }: { items: OrderItem[] }) {
  return (
    <ul className="order-items" aria-label="제조할 음료">
      {items.map(({ name, quantity, note }, index) => (
        <li key={index}>
          <div className="order-item-main"><strong>{name}</strong><span>{quantity}잔</span></div>
          {note && <p className="order-item-note">{note}</p>}
        </li>
      ))}
    </ul>
  );
}

export default function Dashboard() {
  const [orders, setOrders] = useState(initialOrders);
  const [autoReceive, setAutoReceive] = useState(false);
  const [entry, setEntry] = useState('');
  const [event, setEvent] = useState({ text: `${initialEventOrder.id}번 포장 손님이 픽업대에서 기다리고 있어요.`, status: '반영됨', applied: true });
  const [adjustment, setAdjustment] = useState<PriorityAdjustment>(initialEventOrder);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [completed, setCompleted] = useState<number[]>([]);
  const orderChannelRef = useRef<ReturnType<typeof openOrderChannel>>(null);
  const orderAcksRef = useRef(new Map<string, number>());
  const ordersGridRef = useRef<HTMLDivElement>(null);
  const previousPositions = useRef(new Map<string, number>());

  // 키오스크와 배달 목업의 주문을 주문 목록에 추가한다. 같은 요청이 다시 오면 기존 주문 번호로 응답한다.
  useEffect(() => {
    const channel = openOrderChannel((message) => {
      if (message.type !== 'order-submitted') return;
      if (typeof message.requestId !== 'string' || !isOrderDetails(message.details)) {
        console.warn('[orders] 잘못된 주문 요청을 무시했어요.', message);
        return;
      }
      const acceptedId = orderAcksRef.current.get(message.requestId);
      if (acceptedId !== undefined) {
        channel?.post({ type: 'order-accepted', requestId: message.requestId, orderId: acceptedId });
        return;
      }
      const { requestId, details } = message;
      setOrders((previous) => (previous.some((order) => order.requestId === requestId) ? previous : appendOrder(previous, details, requestId)));
    });
    orderChannelRef.current = channel;
    return () => {
      channel?.close();
      orderChannelRef.current = null;
    };
  }, []);

  useEffect(() => {
    for (const order of orders) {
      if (!order.requestId || orderAcksRef.current.has(order.requestId)) continue;
      orderAcksRef.current.set(order.requestId, order.id);
      orderChannelRef.current?.post({ type: 'order-accepted', requestId: order.requestId, orderId: order.id });
    }
  }, [orders]);

  useEffect(() => {
    if (!autoReceive) return;
    const interval = window.setInterval(() => setOrders(appendDemoOrder), 8000);
    return () => window.clearInterval(interval);
  }, [autoReceive]);

  useLayoutEffect(() => {
    const cards = ordersGridRef.current?.querySelectorAll<HTMLElement>('[data-order-id]');
    if (!cards) return;

    const positions = new Map(Array.from(cards, (card) => [card.dataset.orderId!, card.offsetLeft]));
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const card of cards) {
        const id = card.dataset.orderId!;
        const previous = previousPositions.current.get(id);
        const current = positions.get(id)!;
        if (previous === undefined || previous === current) continue;
        card.getAnimations().find((animation) => animation.id === 'order-reorder')?.cancel();
        card.animate([{ transform: `translateX(${previous - current}px)` }, { transform: 'translateX(0)' }], {
          duration: 230,
          easing: 'ease-out',
        }).id = 'order-reorder';
      }
    }
    previousPositions.current = positions;
  });

  const waiting = orders.filter((order) => order.id !== activeId && !completed.includes(order.id));
  const ranked = rankWaitingOrders(waiting, adjustment);
  const active = orders.find((order) => order.id === activeId);
  const next = active ?? ranked[0];
  const singleItem = next?.items.length === 1 ? next.items[0] : undefined;
  const clock = initialTime + orders.length - initialOrders.length;
  const tickets = [
    ...(active ? [{ order: active, status: '제조 중', recommended: false }] : []),
    ...ranked.map((order, index) => ({ order, status: `${index + 1}순위`, recommended: index === 0 })),
    ...orders.filter(({ id }) => completed.includes(id)).map((order) => ({ order, status: '완료', recommended: false })),
  ];

  function applyEvent(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = entry.trim();
    if (!text) return;

    const decision = decideDemoPriority(text, waiting);
    if (decision.adjustment) {
      setAdjustment(decision.adjustment);
      ordersGridRef.current?.scrollTo({ left: 0 });
    }
    setEvent({
      text,
      status: decision.adjustment ? `#${decision.adjustment.id} 우선순위 반영` : decision.status,
      applied: Boolean(decision.adjustment),
    });
    setEntry('');
  }

  function updateTask() {
    if (active) {
      setCompleted((previous) => [...previous, active.id]);
      setActiveId(null);
    } else if (next) {
      setActiveId(next.id);
    }
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <span className="brand">일머리</span>
          <span className="topbar-meta">데모 모드 <Link className="topbar-link" href="/kiosk" target="_blank">키오스크 열기</Link><Link className="topbar-link" href="/delivery" target="_blank">배달 목업 열기</Link></span>
        </div>
      </header>

      <main className="dashboard">
        <div className="board-heading">
          <h1>주방 운영 보드</h1>
          <dl className="totals" aria-label="주문 상태 요약">
            <div><dt>대기</dt><dd>{waiting.length}</dd></div>
            <div><dt>제조 중</dt><dd>{active ? 1 : 0}</dd></div>
            <div><dt>완료</dt><dd>{completed.length}</dd></div>
          </dl>
        </div>

        <section className="orders-panel" aria-labelledby="orders-title">
          <div className="panel-heading">
            <h2 id="orders-title">주문 목록</h2>
            <span className="panel-meta">제조 우선순위순</span>
          </div>
          <div className="orders-grid" ref={ordersGridRef} tabIndex={0} role="region" aria-label="제조 우선순위순 주문">
            {tickets.map(({ order, status, recommended }) => {
              const wait = clock - order.receivedAt;
              const hasEvent = order.id === adjustment.id && status !== '완료';
              return (
                <article key={order.id} data-order-id={order.id} className={`order-ticket ${recommended ? 'recommended' : ''}`} aria-label={`${order.id}번 주문`}>
                  <div className="ticket-top">
                    <strong className="order-number">#{order.id}</strong>
                    <div className="ticket-channel"><span className="order-channel" data-channel={order.channel}>{order.channel}</span>{order.requestId && order.channel !== '배달' && <span>키오스크</span>}</div>
                  </div>
                  <div className="ticket-meta">
                    <span>{formatTime(order.receivedAt)} 접수</span>
                    <div className="ticket-flags"><span className="ticket-status">{status}</span>{hasEvent && <span className="ticket-event">상황 반영</span>}</div>
                  </div>
                  <OrderItems items={order.items} />
                  {order.note && <p className="ticket-note">주문 요청사항 {order.note}</p>}
                  <div className="ticket-bottom">
                    <span>예상 {order.duration}</span>
                    {status !== '완료' && status !== '제조 중' && <span>{wait ? `${wait}분 대기` : '방금 접수'}</span>}
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <div className="dashboard-grid">
          <section className="panel ranking-panel" aria-labelledby="ranking-title">
            <div className="panel-heading">
              <h2 id="ranking-title">Zoro 우선순위 판단</h2>
              <span className="panel-meta">예시 판단</span>
            </div>
            <div className="ranking-labels" aria-hidden="true"><span>순위</span><span>추천 주문</span><span>점수 / 100</span></div>
            <ol className="ranking-list" aria-label="접수 순서 대비 추천 순위" tabIndex={0}>
              {ranked.map((order, index) => {
                const rank = index + 1;
                const movement = order.arrivalRank - rank;
                return (
                  <li className={`rank-row${rank === 1 ? ' rank-first' : ''}${order.id === adjustment.id ? ' rank-event' : ''}`} key={order.id}>
                    <div className="rank-position">
                      <strong>{rank}</strong>
                      {movement !== 0 && (
                        <span
                          className={movement > 0 ? 'rank-movement up' : 'rank-movement down'}
                          role="img"
                          aria-label={`${Math.abs(movement)}단계 ${movement > 0 ? '상승' : '하락'}`}
                        >
                          {movement > 0 ? '↑' : '↓'}{Math.abs(movement)}
                        </span>
                      )}
                    </div>
                    <div className="rank-order"><strong><span>#{order.id}</span> {[...new Set(order.items.map(({ name }) => name))].join(', ')}</strong><p>{order.reason}</p></div>
                    <strong className="rank-score">{order.score}</strong>
                  </li>
                );
              })}
              {ranked.length === 0 && <li className="empty-rank">대기 중인 주문이 없어요.</li>}
            </ol>
          </section>

          <section className="panel event-panel" aria-labelledby="event-title">
            <div className="panel-heading"><h2 id="event-title">매장 상황</h2></div>
            <div className={`event-log${event.applied ? ' event-applied' : ''}`} aria-live="polite">
              <div className="event-meta"><span>최근 입력</span><span>{event.status}</span></div>
              <p className="event-message">{event.text}</p>
            </div>
            <form className="event-form" onSubmit={applyEvent}>
              <label htmlFor="event-entry">상황 입력</label>
              <div className="input-wrap">
                <input id="event-entry" value={entry} onChange={(e) => setEntry(e.target.value)} placeholder="예: 105번 라이더가 곧 도착해요" maxLength={200} />
                <button type="submit" disabled={!entry.trim()}>상황 반영</button>
              </div>
              <div className="event-examples" aria-label="시연용 상황 예시">
                {situationExamples.map((example) => <button type="button" key={example.label} onClick={() => setEntry(example.text)}>{example.label}</button>)}
              </div>
            </form>
          </section>

          <section className="action-panel" aria-labelledby="action-title" aria-live="polite">
            <h2 id="action-title">{active ? '제조 중' : '지금 할 작업'}</h2>
            {next ? <>
              <p className="action-task">{singleItem ? `${singleItem.name} ${singleItem.quantity}잔 만들기` : `주문 #${next.id} 제조하기`}</p>
              <div className="action-detail">
                {singleItem && <span>주문 #{next.id}</span>}<span>예상 {next.duration}</span>
                {singleItem?.note && <span>{singleItem.note}</span>}
                {next.note && <span>주문 요청사항 {next.note}</span>}
              </div>
              {!singleItem && <OrderItems items={next.items} />}
              <button className="action-button" type="button" onClick={updateTask}>{active ? '제조 완료' : '제조 시작'}</button>
            </> : <p className="action-task">모든 주문이 완료됐어요</p>}
          </section>

          <section className="panel incoming-panel" aria-labelledby="incoming-title">
            <div className="panel-heading">
              <h2 id="incoming-title">주문 접수 내역</h2>
              <span className="panel-meta" aria-live="polite">총 {orders.length}건</span>
            </div>
            <ol className="incoming-list" aria-label="최근 접수 주문부터 표시" tabIndex={orders.length > 3 ? 0 : undefined}>
              {[...orders].reverse().map((order) => (
                <li className="incoming-row" key={order.id}>
                  <span className="incoming-id">#{order.id}</span>
                  <div>
                    <OrderItems items={order.items} />
                    {order.note && <p className="incoming-note">{order.note}</p>}
                  </div>
                  <div className="incoming-meta">
                    <span className="order-channel" data-channel={order.channel}>{order.channel}</span>
                    {order.requestId && order.channel !== '배달' && <span>키오스크</span>}
                    <span>{formatTime(order.receivedAt)}</span>
                  </div>
                </li>
              ))}
            </ol>
            <div className="incoming-controls">
              <button className="secondary-button" type="button" onClick={() => setAutoReceive((previous) => !previous)}>{autoReceive ? '자동 접수 중지' : '자동 접수 시작'}</button>
              <button className="secondary-button" type="button" onClick={() => setOrders(appendDemoOrder)}>예시 주문 추가</button>
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
