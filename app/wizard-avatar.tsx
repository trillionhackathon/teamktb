'use client';

import { useEffect, useRef } from 'react';
import { mountAvatar, type MountedAvatar } from 'open-bot-avatar/dom';
import type { AvatarDefinition } from 'open-bot-avatar';
import wizard from './avatars/wizard.json';

const definition: AvatarDefinition = { ...wizard, version: 1 };

// cheer: 바뀔 때마다 잠깐 웃는다. 재고 "채웠어요"나 주문 완료처럼 일이 끝났을 때 화면이 숫자를 올린다.
export default function WizardAvatar({ cheer = 0 }: { cheer?: number }) {
  const host = useRef<HTMLSpanElement>(null);
  const mounted = useRef<MountedAvatar | null>(null);
  const resetMood = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!host.current) return;
    const avatar = mountAvatar(host.current, {
      definition,
      color: '#ffffff',
      eyeColor: '#333438',
      followPointer: true,
      label: '',
    });
    mounted.current = avatar;
    return () => {
      window.clearTimeout(resetMood.current);
      mounted.current = null;
      avatar.destroy();
    };
  }, []);

  function greet() {
    mounted.current?.update({ mood: 'happy' });
    window.clearTimeout(resetMood.current);
    resetMood.current = window.setTimeout(() => mounted.current?.update({ mood: 'idle' }), 1400);
  }

  useEffect(() => {
    if (cheer > 0) greet();
  }, [cheer]);

  return (
    <button type="button" className="wizard-avatar" aria-label="일머리 마법사에게 인사하기" onClick={greet}>
      <span ref={host} aria-hidden="true" />
    </button>
  );
}
