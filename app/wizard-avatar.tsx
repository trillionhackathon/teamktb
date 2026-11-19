'use client';

import { useEffect, useRef } from 'react';
import { mountAvatar, type MountedAvatar } from 'open-bot-avatar/dom';
import type { AvatarDefinition } from 'open-bot-avatar';
import wizard from './avatars/wizard.json';

const definition: AvatarDefinition = { ...wizard, version: 1 };

export default function WizardAvatar() {
  const host = useRef<HTMLSpanElement>(null);
  const mounted = useRef<MountedAvatar | null>(null);
  const resetMood = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!host.current) return;
    const avatar = mountAvatar(host.current, {
      definition,
      color: '#333438',
      eyeColor: '#ffffff',
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

  return (
    <button type="button" className="wizard-avatar" aria-label="일머리 마법사에게 인사하기" onClick={greet}>
      <span ref={host} aria-hidden="true" />
    </button>
  );
}
