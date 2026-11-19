'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import type { OrderDetails } from '../demo-data';
import { createOrderRequestId, openOrderChannel } from '../order-channel';
import {
  categories, defaultOptions, displayName, estimateSeconds, formatDuration, formatPrice, lineKey, maxLineQuantity,
  menuItems, optionLabels, optionPrice, toOrderDetails, unitPrice,
  type CartLine, type Category, type Channel, type ItemOptions, type MenuItem,
} from './menu-data';

type Method = 'card' | 'easy-pay' | 'gift';
const methods: { id: Method; label: string; detail: string; instruction: string }[] = [
  { id: 'card', label: '신용·체크카드', detail: 'IC 카드, 삼성페이', instruction: '카드를 단말기에 꽂아주세요' },
  { id: 'easy-pay', label: '간편결제', detail: '카카오페이, 네이버페이, 토스페이', instruction: '휴대폰 결제 바코드를 스캐너에 보여주세요' },
  { id: 'gift', label: '모바일 상품권', detail: '기프티콘, 매장 쿠폰', instruction: '상품권 바코드를 스캐너에 보여주세요' },
];

type Payment = {
  step: 'review' | 'processing' | 'done' | 'failed';
  method: Method;
  requestId: string;
  sending: boolean;
  details: OrderDetails;
  total: number;
  orderId?: number;
};

const approveDelay = 1600;
const ackTimeout = 2500;
const resetSeconds = 15;

export default function Kiosk() {
  const [channel, setChannel] = useState<Channel | null>(null);
  const [category, setCategory] = useState<Category>(categories[0]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [selected, setSelected] = useState<MenuItem | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [countdown, setCountdown] = useState(resetSeconds);

  const channelRef = useRef<ReturnType<typeof openOrderChannel>>(null);
  const pendingRequestRef = useRef<string | null>(null);

  const cups = cart.reduce((sum, line) => sum + line.quantity, 0);
  const total = cart.reduce((sum, line) => sum + unitPrice(line.item, line.options) * line.quantity, 0);
  const visibleItems = menuItems.filter((item) => item.category === category);

  useEffect(() => {
    const orderChannel = openOrderChannel((message) => {
      if (message.type !== 'order-accepted' || message.requestId !== pendingRequestRef.current) return;
      pendingRequestRef.current = null;
      setPayment((previous) => (previous?.requestId === message.requestId ? { ...previous, step: 'done', orderId: message.orderId } : previous));
      setCountdown(resetSeconds);
    });
    channelRef.current = orderChannel;
    return () => {
      orderChannel?.close();
      channelRef.current = null;
    };
  }, []);

  const step = payment?.step;
  const requestId = payment?.requestId;
  const details = payment?.details;

  // 목업 결제 승인 후 주방 보드로 주문을 보내고, 보드가 매긴 주문 번호를 기다린다.
  useEffect(() => {
    if (step !== 'processing' || !requestId || !details) return;
    const timers: number[] = [];
    timers.push(window.setTimeout(() => {
      setPayment((previous) => (previous ? { ...previous, sending: true } : previous));
      pendingRequestRef.current = requestId;
      channelRef.current?.post({ type: 'order-submitted', requestId, details });
      timers.push(window.setTimeout(() => {
        if (pendingRequestRef.current !== requestId) return;
        pendingRequestRef.current = null;
        setPayment((previous) => (previous?.requestId === requestId && previous.step === 'processing' ? { ...previous, step: 'failed' } : previous));
      }, ackTimeout));
    }, approveDelay));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [step, requestId, details]);

  useEffect(() => {
    if (step !== 'done') return;
    const interval = window.setInterval(() => setCountdown((previous) => previous - 1), 1000);
    return () => window.clearInterval(interval);
  }, [step]);

  useEffect(() => {
    if (step === 'done' && countdown <= 0) resetKiosk();
  }, [step, countdown]);

  function resetKiosk() {
    setPayment(null);
    setCart([]);
    setChannel(null);
    setCategory(categories[0]);
  }

  function addToCart(item: MenuItem, options: ItemOptions, quantity: number) {
    const key = lineKey(item, options);
    setCart((previous) => {
      const existing = previous.find((line) => line.key === key);
      if (!existing) return [...previous, { key, item, options, quantity }];
      return previous.map((line) => (line.key === key ? { ...line, quantity: Math.min(maxLineQuantity, line.quantity + quantity) } : line));
    });
    setSelected(null);
  }

  function changeQuantity(key: string, delta: number) {
    setCart((previous) => previous
      .map((line) => (line.key === key ? { ...line, quantity: Math.min(maxLineQuantity, line.quantity + delta) } : line))
      .filter((line) => line.quantity > 0));
  }

  function openPayment() {
    if (!channel || !cart.length) return;
    setPayment({ step: 'review', method: 'card', requestId: createOrderRequestId(), sending: false, details: toOrderDetails(cart, channel), total });
  }

  if (!channel) {
    return (
      <>
        <KioskTopbar />
        <main className="kiosk kiosk-welcome">
          <div className="welcome-heading">
            <p className="board-context">성수점 셀프 주문</p>
            <h1>어디에서 드시나요?</h1>
            <p className="welcome-sub">주문하신 음료는 바로 주방 운영 보드로 전달돼요.</p>
          </div>
          <div className="welcome-choices">
            <button type="button" className="welcome-choice" onClick={() => setChannel('매장')}>
              <span className="welcome-choice-label">매장에서 먹어요</span>
              <span className="welcome-choice-detail">머그잔과 유리잔에 담아드려요</span>
            </button>
            <button type="button" className="welcome-choice" onClick={() => setChannel('포장')}>
              <span className="welcome-choice-label">포장해 가요</span>
              <span className="welcome-choice-detail">일회용 컵과 캐리어에 담아드려요</span>
            </button>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <KioskTopbar />
      <main className="kiosk">
        <div className="kiosk-layout">
          <section className="kiosk-menu" aria-labelledby="menu-title">
            <div className="board-heading">
              <div>
                <p className="board-context">성수점 셀프 주문 · {channel}</p>
                <h1 id="menu-title">메뉴를 골라주세요</h1>
              </div>
              <button type="button" className="secondary-button kiosk-home" onClick={resetKiosk}>처음으로</button>
            </div>

            <div className="category-tabs" role="tablist" aria-label="메뉴 분류">
              {categories.map((name) => (
                <button key={name} type="button" role="tab" aria-selected={category === name} aria-controls="menu-grid" className={category === name ? 'active' : ''} onClick={() => setCategory(name)}>
                  {name}
                </button>
              ))}
            </div>

            <div className="menu-grid" id="menu-grid" role="tabpanel" aria-label={`${category} 메뉴`}>
              {visibleItems.map((item) => {
                const inCart = cart.filter((line) => line.item.id === item.id).reduce((sum, line) => sum + line.quantity, 0);
                return (
                  <button key={item.id} type="button" className={`menu-card ${inCart ? 'in-cart' : ''}`} disabled={item.soldOut} onClick={() => setSelected(item)}>
                    <span className="menu-card-top">
                      <span>{item.temperatures.map((temperature) => (temperature === 'ice' ? 'ICE' : 'HOT')).join(' · ')}</span>
                      {item.soldOut ? <span className="menu-badge sold-out">품절</span> : item.badge && <span className="menu-badge">{item.badge}</span>}
                    </span>
                    <span className="menu-name">{item.name}</span>
                    <span className="menu-description">{item.description}</span>
                    <span className="menu-card-bottom">
                      <strong>{formatPrice(item.price)}</strong>
                      {inCart > 0 && <span className="menu-in-cart">{inCart}잔 담김</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <aside className="kiosk-cart" aria-labelledby="cart-title">
            <div className="panel cart-panel">
              <div className="panel-heading">
                <h2 id="cart-title">주문 내역</h2>
                <span className="panel-meta" aria-live="polite">{cups}잔</span>
              </div>
              <div className="channel-toggle" role="radiogroup" aria-label="식사 방법">
                {(['매장', '포장'] as Channel[]).map((option) => (
                  <button key={option} type="button" role="radio" aria-checked={channel === option} className={channel === option ? 'active' : ''} onClick={() => setChannel(option)}>
                    {option === '매장' ? '매장 식사' : '포장'}
                  </button>
                ))}
              </div>
              {cart.length ? (
                <ol className="cart-list" aria-label="담은 음료" tabIndex={cart.length > 4 ? 0 : undefined}>
                  {cart.map((line) => {
                    const labels = optionLabels(line.item, line.options);
                    const name = displayName(line.item, line.options);
                    return (
                      <li key={line.key} className="cart-line">
                        <div className="cart-line-info">
                          <p className="cart-line-name">{name}</p>
                          {labels.length > 0 && <p className="cart-line-options">{labels.join(', ')}</p>}
                          <p className="cart-line-price">{formatPrice(unitPrice(line.item, line.options) * line.quantity)}</p>
                        </div>
                        <Stepper
                          label={name}
                          value={line.quantity}
                          onDecrease={() => changeQuantity(line.key, -1)}
                          onIncrease={() => changeQuantity(line.key, 1)}
                          decreaseLabel={line.quantity === 1 ? '삭제' : '빼기'}
                        />
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="cart-empty">메뉴를 누르면 여기에 담겨요.</p>
              )}
              {cart.length > 0 && (
                <div className="cart-controls">
                  <button type="button" className="secondary-button" onClick={() => setCart([])}>전체 삭제</button>
                </div>
              )}
            </div>

            <section className="action-panel checkout-panel" aria-label="결제">
              <h2>총 결제 금액</h2>
              <p className="checkout-total">{formatPrice(total)}</p>
              <p className="action-detail">
                <span>{cups}잔</span>
                {cart.length > 0 && <span>예상 제조 {formatDuration(estimateSeconds(cart))}</span>}
              </p>
              <button type="button" className="action-button checkout-button" disabled={!cart.length} onClick={openPayment}>
                {cart.length ? `${formatPrice(total)} 결제하기` : '메뉴를 담아주세요'}
              </button>
            </section>
          </aside>
        </div>
      </main>

      {selected && <OptionDialog item={selected} onClose={() => setSelected(null)} onAdd={addToCart} />}
      {payment && (
        <PaymentDialog
          payment={payment}
          cart={cart}
          channel={channel}
          countdown={countdown}
          onMethodChange={(method) => setPayment({ ...payment, method })}
          onPay={() => setPayment({ ...payment, step: 'processing', sending: false })}
          onClose={() => (payment.step === 'done' ? resetKiosk() : setPayment(null))}
        />
      )}
    </>
  );
}

function KioskTopbar() {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <span className="brand">일머리</span>
        <span className="topbar-meta">키오스크 · 데모 모드 <Link className="topbar-link" href="/" target="_blank">주방 운영 보드 열기</Link></span>
      </div>
    </header>
  );
}

function Stepper({ label, value, onDecrease, onIncrease, decreaseLabel = '빼기', min = 0 }: {
  label: string; value: number; onDecrease: () => void; onIncrease: () => void; decreaseLabel?: string; min?: number;
}) {
  return (
    <div className="stepper" role="group" aria-label={`${label} 수량`}>
      <button type="button" onClick={onDecrease} disabled={value <= min} aria-label={`${label} ${decreaseLabel}`}>−</button>
      <output aria-live="polite">{value}</output>
      <button type="button" onClick={onIncrease} disabled={value >= maxLineQuantity} aria-label={`${label} 한 잔 더`}>+</button>
    </div>
  );
}

function useModal(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return { ref, onCancel: (e: SyntheticEvent) => { e.preventDefault(); onClose(); } };
}

function OptionDialog({ item, onClose, onAdd }: { item: MenuItem; onClose: () => void; onAdd: (item: MenuItem, options: ItemOptions, quantity: number) => void }) {
  const { ref, onCancel } = useModal(onClose);
  const [options, setOptions] = useState(() => defaultOptions(item));
  const [quantity, setQuantity] = useState(1);
  const price = unitPrice(item, options) * quantity;
  const set = <K extends keyof ItemOptions>(key: K) => (value: ItemOptions[K]) => setOptions((previous) => ({ ...previous, [key]: value }));

  return (
    <dialog ref={ref} className="kiosk-dialog" aria-labelledby="option-title" onCancel={onCancel}>
      <div className="dialog-heading">
        <p className="board-context">{item.category}</p>
        <h2 id="option-title">{item.name}</h2>
        <p className="dialog-sub">{item.description} · {formatPrice(item.price)}</p>
      </div>
      <div className="dialog-body">
        <OptionGroup
          legend="온도"
          name="temperature"
          value={options.temperature}
          onChange={set('temperature')}
          choices={item.temperatures.map((temperature) => ({ value: temperature, label: temperature === 'ice' ? '아이스' : '따뜻하게' }))}
          note={item.temperatures.length === 1 ? `${item.temperatures[0] === 'ice' ? '아이스' : '따뜻한'} 음료로만 제공돼요` : undefined}
        />
        <OptionGroup
          legend="사이즈"
          name="size"
          value={options.size}
          onChange={set('size')}
          choices={[{ value: 'regular', label: '레귤러' }, { value: 'large', label: '라지', extra: optionPrice.large }]}
        />
        {item.hasShot && (
          <OptionGroup
            legend="샷"
            name="shot"
            value={options.shot}
            onChange={set('shot')}
            choices={[{ value: 'light', label: '연하게' }, { value: 'default', label: '기본' }, { value: 'extra', label: '샷 추가', extra: optionPrice.extraShot }]}
          />
        )}
        {options.temperature === 'ice' && (
          <OptionGroup
            legend="얼음"
            name="ice"
            value={options.ice}
            onChange={set('ice')}
            choices={[{ value: 'less', label: '적게' }, { value: 'normal', label: '보통' }, { value: 'more', label: '많이' }]}
          />
        )}
        <div className="option-quantity">
          <span className="option-legend">수량</span>
          <Stepper label={item.name} value={quantity} min={1} onDecrease={() => setQuantity((q) => Math.max(1, q - 1))} onIncrease={() => setQuantity((q) => Math.min(maxLineQuantity, q + 1))} />
        </div>
      </div>
      <div className="dialog-actions">
        <button type="button" className="dialog-secondary" onClick={onClose}>취소</button>
        <button type="button" className="action-button" onClick={() => onAdd(item, options, quantity)}>{quantity}잔 담기 · {formatPrice(price)}</button>
      </div>
    </dialog>
  );
}

function OptionGroup<T extends string>({ legend, name, value, onChange, choices, note }: {
  legend: string; name: string; value: T; onChange: (value: T) => void; choices: { value: T; label: string; extra?: number }[]; note?: string;
}) {
  return (
    <fieldset className="option-group">
      <legend className="option-legend">{legend}</legend>
      <div className="option-choices">
        {choices.map((choice) => (
          <label key={choice.value} className={`option-choice ${value === choice.value ? 'selected' : ''}`}>
            <input type="radio" name={name} value={choice.value} checked={value === choice.value} onChange={() => onChange(choice.value)} />
            <span>{choice.label}{choice.extra ? <small>+{formatPrice(choice.extra)}</small> : null}</span>
          </label>
        ))}
      </div>
      {note && <p className="option-note">{note}</p>}
    </fieldset>
  );
}

function PaymentDialog({ payment, cart, channel, countdown, onMethodChange, onPay, onClose }: {
  payment: Payment; cart: CartLine[]; channel: Channel; countdown: number;
  onMethodChange: (method: Method) => void; onPay: () => void; onClose: () => void;
}) {
  const busy = payment.step === 'processing';
  const { ref, onCancel } = useModal(() => { if (!busy) onClose(); });
  const method = methods.find(({ id }) => id === payment.method) ?? methods[0];

  return (
    <dialog ref={ref} className="kiosk-dialog payment-dialog" aria-labelledby="payment-title" onCancel={onCancel}>
      {payment.step === 'review' && <>
        <div className="dialog-heading">
          <p className="board-context">{channel === '매장' ? '매장 식사' : '포장'} · {cart.reduce((sum, line) => sum + line.quantity, 0)}잔</p>
          <h2 id="payment-title">결제 수단을 골라주세요</h2>
        </div>
        <div className="dialog-body">
          <ul className="payment-summary" aria-label="결제할 음료">
            {cart.map((line) => (
              <li key={line.key}>
                <span>{displayName(line.item, line.options)} <span>{line.quantity}잔</span></span>
                <span>{formatPrice(unitPrice(line.item, line.options) * line.quantity)}</span>
              </li>
            ))}
            <li className="payment-summary-total"><span>합계</span><span>{formatPrice(payment.total)}</span></li>
          </ul>
          <fieldset className="option-group">
            <legend className="option-legend">결제 수단</legend>
            <div className="method-choices">
              {methods.map((option) => (
                <label key={option.id} className={`method-choice ${payment.method === option.id ? 'selected' : ''}`}>
                  <input type="radio" name="method" value={option.id} checked={payment.method === option.id} onChange={() => onMethodChange(option.id)} />
                  <span><strong>{option.label}</strong><small>{option.detail}</small></span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <div className="dialog-actions">
          <button type="button" className="dialog-secondary" onClick={onClose}>이전</button>
          <button type="button" className="action-button" onClick={onPay}>{formatPrice(payment.total)} 결제하기</button>
        </div>
      </>}

      {payment.step === 'processing' && (
        <div className="payment-status" role="status" aria-live="polite">
          <p className="board-context">{method.label}</p>
          <h2 id="payment-title">{payment.sending ? '주방에 주문을 전달하고 있어요' : method.instruction}</h2>
          <p className="dialog-sub">{payment.sending ? '주문 번호를 받는 중이에요.' : `${formatPrice(payment.total)} 결제 승인을 기다리고 있어요.`}</p>
          <div className="payment-progress" aria-hidden="true"><span className={payment.sending ? 'sending' : ''} /></div>
        </div>
      )}

      {payment.step === 'done' && <>
        <div className="payment-status" role="status" aria-live="polite">
          <p className="board-context">결제 완료 · {formatPrice(payment.total)}</p>
          <h2 id="payment-title">주문 번호</h2>
          <p className="payment-order-number">#{payment.orderId}</p>
          <p className="dialog-sub">주방 운영 보드에 주문이 들어갔어요. 번호가 불리면 픽업대에서 받아주세요.</p>
          <dl className="payment-facts">
            <div><dt>음료</dt><dd>{payment.details.items.map(({ name, quantity }) => `${name} ${quantity}잔`).join(', ')}</dd></div>
            <div><dt>식사 방법</dt><dd>{payment.details.channel === '매장' ? '매장 식사' : '포장'}</dd></div>
            <div><dt>예상 제조</dt><dd>{payment.details.duration}</dd></div>
          </dl>
        </div>
        <div className="dialog-actions">
          <button type="button" className="action-button" onClick={onClose}>처음으로 ({Math.max(0, countdown)})</button>
        </div>
      </>}

      {payment.step === 'failed' && <>
        <div className="payment-status" role="alert">
          <p className="board-context">주문 전달 실패</p>
          <h2 id="payment-title">주방 운영 보드에 연결되지 않았어요</h2>
          <p className="dialog-sub">결제는 진행되지 않았어요. 같은 브라우저의 다른 탭에서 주방 운영 보드를 연 뒤 다시 시도해 주세요.</p>
        </div>
        <div className="dialog-actions">
          <button type="button" className="dialog-secondary" onClick={onClose}>닫기</button>
          <button type="button" className="action-button" onClick={onPay}>다시 시도</button>
        </div>
      </>}
    </dialog>
  );
}
