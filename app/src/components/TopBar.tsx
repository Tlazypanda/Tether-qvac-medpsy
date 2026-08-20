import type { State } from '../api';
import { Mark, Bolt, Gpu } from './icons';
import { fmt, short } from '../format';

export type Role = 'buyer' | 'seller';

// The persistent app header: brand · Buyer⇄Seller role toggle · wallet pill (balance + manage).
// One install does both roles; the toggle is switchable anytime and persisted by App.
export default function TopBar({
  role,
  onRole,
  state,
  flash,
  onManage,
}: {
  role: Role;
  onRole: (r: Role) => void;
  state: State | null;
  flash: boolean;
  onManage: () => void;
}) {
  const addr = state?.buyer?.address ?? state?.wallet.address ?? '';
  return (
    <header className="topbar">
      <div className="tb-brand">
        <Mark size={26} />
        <div>
          <div className="wordmark">MedConsult</div>
          <div className="tag">Peer-to-peer consults · USD₮</div>
        </div>
      </div>

      <div className="role-toggle" role="tablist" aria-label="Role">
        <button
          className={`role-opt${role === 'buyer' ? ' on' : ''}`}
          onClick={() => onRole('buyer')}
          role="tab"
          aria-selected={role === 'buyer'}
        >
          <Bolt />
          <span className="ro-t">Ask &amp; Pay</span>
        </button>
        <button
          className={`role-opt${role === 'seller' ? ' on' : ''}`}
          onClick={() => onRole('seller')}
          role="tab"
          aria-selected={role === 'seller'}
        >
          <Gpu />
          <span className="ro-t">Share GPU &amp; Earn</span>
        </button>
      </div>

      <button className="wallet-pill" onClick={onManage} title="Manage wallet">
        <span className={`wp-bal${flash ? ' flash' : ''}`}>{fmt(state?.buyer?.usdt)}</span>
        <span className="wp-unit">USD₮</span>
        <span className="wp-addr">{short(addr)}</span>
      </button>
    </header>
  );
}
