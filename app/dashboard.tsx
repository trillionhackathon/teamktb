'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { callApi, orderPath } from './client/api.ts';
import {
  agentAlerts, candidateOrders, emptyQuestState, itemKey, rankCandidates, reconcile, FIXED_COUNT, CANDIDATE_COUNT,
  type AgentAlert, type QuestState, type TipLine,
} from './client/quest-board.ts';
import { formatClock, formatElapsed, useBoardSnapshot, useNow, type Connection } from './client/use-board.ts';
import type { BoardSnapshot, OrderView } from './domain/views.ts';
import type { DemoFeedStatus } from './server/demo-feed.ts';

const connectionLabels: Record<Connection, string> = { connecting: '연결 중', live: '실시간 연결됨', reconnecting: '재연결 중' };
const storageKey = 'ilmori-quest-board-v2';

function isQuestState(value: unknown): value is QuestState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<QuestState>;
  return Array.isArray(state.fixed) && typeof state.prepared === 'object' && typeof state.overtakes === 'object' && typeof state.promoted === 'object';
}

// 고정칸, 미리 만든 메뉴, 앞지르기 횟수는 이 브라우저에만 저장한다(목업). 새로고침해도 퀘스트가 이어진다.
function useQuestBoard(board: OrderView[]): QuestState {
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

  const next = useMemo(() => reconcile(state, board), [state, board]);

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

function AlertCard({ alert }: { alert: AgentAlert }) {
  return (
    <li className={`agent-alert level-${alert.level}`}>
      <div className="agent-alert-head">
        <strong>{alert.title}</strong>
        {alert.sample ? <span className="sample-badge">예시</span> : alert.at ? <span className="agent-alert-time">{formatClock(alert.at)}</span> : null}
      </div>
      <p>{alert.detail}</p>
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
  const now = useNow(clockOffset);
  const quest = useQuestBoard(snapshot.board);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feed, setFeed] = useState<DemoFeedStatus | null>(null);

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
  const candidates = rankCandidates(candidateOrders(snapshot.board, quest.fixed), fixedOrders, quest.prepared, quest.overtakes);
  const queueCount = Math.max(0, snapshot.board.length - fixedOrders.length - candidates.length);
  const slotOf = (id: string) => quest.fixed.indexOf(id) + 1;
  const head = fixedOrders[0];
  const alerts = agentAlerts(snapshot, now);

  // 시작 단계 없이 바로 완료한다. 서버는 대기 중인 주문의 완료도 받는다.
  async function completeOrder(order: OrderView) {
    setBusy(true);
    const result = await callApi(orderPath(order.order_id), { method: 'PATCH', body: { action: 'complete' } });
    setBusy(false);
    setError(result.ok ? null : result.error);
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <span className="brand">일머리</span>
          <span className="topbar-meta">
            <span className={`connection connection-${connection}`} role="status">{connectionLabels[connection]}</span>
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
          <div className="section-heading">
            <h2 id="agent-title">매장 알림</h2>
            <span className="section-meta">{alerts.length}건</span>
          </div>
          <p className="section-sub">에이전트가 재고와 매장 상황을 살펴보고 알려 줘요.</p>
          <ul className="agent-list" aria-live="polite">
            {alerts.map((alert) => <AlertCard key={alert.id} alert={alert} />)}
          </ul>
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
                      <div className="card-head">
                        <span className="slot-number">{slot}</span>
                        <strong className="card-order">{order.order_id}</strong>
                        <span className="order-channel" data-channel={order.channel_label}>{order.channel_label}</span>
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
                const { order, reason } = candidate;
                return (
                  <article key={slot} role="listitem" className={`quest-card candidate${index === 0 ? ' up-next' : ''}`} aria-label={`${slot}번 칸 ${order.order_id} 후보 주문`}>
                    <div className="card-body" key={order.order_id}>
                      <div className="card-head">
                        <span className="slot-number">{slot}</span>
                        <strong className="card-order">{order.order_id}</strong>
                        <span className="order-channel" data-channel={order.channel_label}>{order.channel_label}</span>
                      </div>
                      <OrderLines order={order} prepared={quest.prepared[order.order_id] ?? {}} />
                      <p className="card-reason"><strong>{index === 0 ? '다음 차례' : 'Zoro 판단'}</strong>{reason}</p>
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
                      <p className="tip-reason"><strong>Zoro 판단</strong>{tipReason(line, head, slotOf, fixedOrders.length > 1)}</p>
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
    </>
  );
}
