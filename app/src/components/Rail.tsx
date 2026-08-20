import { useState } from 'react';
import type { State, Peer } from '../api';
import { Mark, Lock } from './icons';
import Marketplace from './Marketplace';

function fmt(n: string | number | undefined, dp = 2): string {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(dp) : '—';
}
function short(addr: string): string {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '—';
}

export default function Rail({
  state,
  sellers,
  flash,
  onSelect,
  onManage,
}: {
  state: State | null;
  sellers: Peer[];
  flash: boolean;
  onSelect: (id: string) => void;
  onManage: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const spent = Number(state?.spent ?? 0);
  const budget = Number(state?.budget ?? 1) || 1;
  const pct = Math.min(100, (spent / budget) * 100);

  function copy() {
    const addr = state?.buyer?.address;
    if (!addr) return;
    void navigator.clipboard?.writeText(addr);
    setCopied(true);
    setTimeout(() => setCopied(false), 1100);
  }

  return (
    <aside className="rail">
      <div className="rail-inner">
        <div className="brand rise" style={{ animationDelay: '40ms' }}>
          <Mark size={30} />
          <div>
            <div className="wordmark">MedConsult</div>
            <div className="tag">Peer-to-peer consults · USD₮</div>
          </div>
        </div>

        <section className="card rise" style={{ animationDelay: '110ms' }}>
          <div className="card-label">
            <span>Your wallet</span>
            <button className="manage-btn" onClick={onManage}>manage</button>
          </div>
          <div className="balance">
            <span className={`num${flash ? ' flash' : ''}`}>{fmt(state?.buyer?.usdt)}</span>
            <span className="unit">USD₮</span>
          </div>
          <div className="addr" onClick={copy} title="Copy address">
            {short(state?.buyer?.address ?? '')}
            <span className={copied ? 'copied' : ''}>{copied ? 'copied' : '⧉'}</span>
          </div>
          <div className="gas">
            <span>gas</span>
            <b>{fmt(state?.buyer?.eth, 4)} ETH</b>
          </div>
          {state?.sessions && state.sessions.length > 0 && (
            <div className="channel-chip" title="Open payment channel — paid answers are instant (off-chain vouchers)">
              ⚡ channel · {fmt(state.sessions[0]!.remaining)} USD₮ left
            </div>
          )}
        </section>

        <section className="card rise" style={{ animationDelay: '180ms' }}>
          <div className="card-label">
            <span>Session spend</span>
            <span>{Math.round(pct)}%</span>
          </div>
          <div className="spend-row">
            <span className="big">{fmt(spent)} USD₮</span>
            <span className="of">of {fmt(budget)} budget</span>
          </div>
          <div className="meter">
            <span style={{ width: `${pct}%` }} />
          </div>
        </section>

        <Marketplace state={state} sellers={sellers} onSelect={onSelect} />

        <div className="spacer" />

        <section className="seal rise" style={{ animationDelay: '320ms' }}>
          <div className="ring">
            <Lock />
          </div>
          <div>
            <div className="t1">0 BYTES TO CLOUD</div>
            <div className="t2">End-to-end encrypted, peer to peer</div>
          </div>
        </section>
      </div>
    </aside>
  );
}
