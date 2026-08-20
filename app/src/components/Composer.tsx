import { useRef, useState } from 'react';
import { SendIcon } from './icons';

export default function Composer({
  onSend,
  busy,
  ready,
  setupErr,
}: {
  onSend: (q: string) => void;
  busy: boolean;
  ready: boolean;
  setupErr: string | null;
}) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  function grow() {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  function submit() {
    const q = value.trim();
    if (!q || busy) return;
    onSend(q);
    setValue('');
    requestAnimationFrame(() => {
      if (ref.current) ref.current.style.height = 'auto';
    });
  }

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          placeholder="Describe your symptoms…"
          onChange={(e) => {
            setValue(e.target.value);
            grow();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="send" onClick={submit} disabled={busy || !value.trim()} aria-label="Send">
          <SendIcon />
        </button>
      </div>
      <div className="composer-hint">
        {setupErr ? (
          <span className="warn">engine error: {setupErr}</span>
        ) : busy ? (
          <span>working — paying & delegating only when it's worth it…</span>
        ) : ready ? (
          <span>Enter to send · Shift+Enter for a new line</span>
        ) : (
          <span className="warn">warming up the on-device model — your first question may take a moment</span>
        )}
      </div>
    </div>
  );
}
