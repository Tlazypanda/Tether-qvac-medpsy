import type { State, Peer } from '../api';

function fmt(n: string | number, dp = 2): string {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(dp) : '—';
}
function short(a: string): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—';
}
// HEALTHCARE_4B_MEDICAL_Q4_K_M → "MedPsy 4B"; QWEN3_4B_INST_Q4_K_M → "Qwen3 4B"
function modelName(m: string): string {
  const med = /^HEALTHCARE_([\d_]+B)_MEDICAL/i.exec(m);
  if (med) return `MedPsy ${med[1]!.replace(/_/g, '.').toUpperCase()}`;
  const base = m.replace(/_INST.*$/i, '').replace(/_Q\d.*$/i, '').replace(/_/g, ' ').trim();
  if (!base) return m;
  return base
    .toLowerCase()
    .split(' ')
    .map((w) => (/^[\d.]+[a-z]+$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

export default function Marketplace({
  state,
  sellers,
  onSelect,
}: {
  state: State | null;
  sellers: Peer[];
  onSelect: (id: string) => void;
}) {
  const selected = state?.selected ?? 'auto';
  const online = sellers.filter((s) => s.online);
  const active = state?.peer ?? null;
  const err = state?.setupErr;

  const dotClass = err ? 'err' : active ? 'on' : 'warm';
  const status = err
    ? 'engine error'
    : active
      ? `${modelName(active.model)} · ${fmt(active.price)} USD₮`
      : online.length
        ? 'choose a peer'
        : 'searching for peers…';

  return (
    <section className="card market rise" style={{ animationDelay: '250ms' }}>
      <div className="card-label">
        <span>Marketplace</span>
        <span>{online.length} online</span>
      </div>

      <div className="peer-row">
        <i className={`dot ${dotClass}`} />
        <span className="peer-status">{status}</span>
      </div>

      <div className="market-list">
        <button
          className={`market-row${selected === 'auto' ? ' sel' : ''}`}
          onClick={() => onSelect('auto')}
        >
          <span className="mr-top">
            <b>Auto</b>
            <span className="mr-check">{selected === 'auto' ? '✓' : ''}</span>
          </span>
          <span className="mr-sub">cheapest, then fastest</span>
        </button>

        {sellers.map((s) => (
          <button
            key={s.id}
            className={`market-row${selected === s.id ? ' sel' : ''}${s.online ? '' : ' off'}`}
            onClick={() => s.online && onSelect(s.id)}
            disabled={!s.online}
          >
            <span className="mr-top">
              <span className="mr-model">
                <i className={`mdot${s.online ? ' on' : ''}`} />
                {modelName(s.model)}
              </span>
              <span className="mr-check">{selected === s.id ? '✓' : ''}</span>
            </span>
            <span className="mr-sub">
              {fmt(s.price)} USD₮ · {Math.round(s.tps)} tps · {short(s.address)}
            </span>
          </button>
        ))}

        {!sellers.length && (
          <div className="market-empty">
            No sellers yet — run <code>npm run sell</code> on a GPU peer.
          </div>
        )}
      </div>
    </section>
  );
}
