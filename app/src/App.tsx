import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ask, getSellers, getState, selectSeller, getSellerStatus, startSeller, stopSeller,
  type Peer, type State, type SellerStatus,
} from './api';
import type { ChatMsg } from './types';
import Rail from './components/Rail';
import Thread from './components/Thread';
import Composer from './components/Composer';
import WalletGate from './components/WalletGate';
import WalletMenu from './components/WalletMenu';
import TopBar, { type Role } from './components/TopBar';
import MarketplaceScreen from './components/MarketplaceScreen';
import SellerScreen from './components/SellerScreen';
import ModelBanner from './components/ModelBanner';
import { Mark, Back } from './components/icons';
import { modelName } from './format';

const ROLE_KEY = 'conduit:role';

export default function App() {
  const [state, setState] = useState<State | null>(null);
  const [sellers, setSellers] = useState<Peer[]>([]);
  const [sellerStatus, setSellerStatus] = useState<SellerStatus | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const [sellerBusy, setSellerBusy] = useState(false);
  const [flash, setFlash] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const [role, setRole] = useState<Role>(() => (localStorage.getItem(ROLE_KEY) as Role) || 'buyer');
  const [view, setView] = useState<'marketplace' | 'chat'>('marketplace');

  const idRef = useRef(0);
  const prevUsdt = useRef<number | null>(null);
  const nextId = () => ++idRef.current;

  const changeRole = useCallback((r: Role) => {
    setRole(r);
    localStorage.setItem(ROLE_KEY, r);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await getState();
      if (s.buyer) {
        const usdt = Number(s.buyer.usdt);
        if (prevUsdt.current !== null && usdt < prevUsdt.current - 1e-9) {
          setFlash(true);
          setTimeout(() => setFlash(false), 900);
        }
        prevUsdt.current = usdt;
      }
      setState(s);
    } catch {
      /* engine still booting — keep last good state */
    }
    try {
      const sl = await getSellers();
      setSellers(sl.sellers);
    } catch {
      /* keep last seller list */
    }
    try {
      setSellerStatus(await getSellerStatus());
    } catch {
      /* keep last seller status */
    }
  }, []);

  const onSelect = useCallback(
    async (id: string) => {
      try { await selectSeller(id); } catch { /* ignore */ }
      void refresh();
    },
    [refresh],
  );

  // Marketplace landing → pick a seller (or Auto) AND enter chat.
  const onPick = useCallback(
    (id: string) => {
      void onSelect(id);
      setView('chat');
    },
    [onSelect],
  );

  const onSellerStart = useCallback(async (model?: string) => {
    setSellerBusy(true);
    try { setSellerStatus(await startSeller(model)); } catch { /* surfaced via status */ }
    finally { setSellerBusy(false); void refresh(); }
  }, [refresh]);

  const onSellerStop = useCallback(async () => {
    setSellerBusy(true);
    try { await stopSeller(); } catch { /* ignore */ }
    finally { setSellerBusy(false); void refresh(); }
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 3500);
    return () => clearInterval(t);
  }, [refresh]);

  const send = useCallback(
    async (prompt: string) => {
      if (busy) return;
      setBusy(true);
      const meId = nextId();
      const aiId = nextId();
      setMessages((m) => [
        ...m,
        { id: meId, role: 'me', text: prompt },
        { id: aiId, role: 'ai', text: '', pending: true },
      ]);

      try {
        const r = await ask(prompt);
        setMessages((m) =>
          m.map((msg) =>
            msg.id === aiId
              ? r.error
                ? { ...msg, pending: false, error: r.error }
                : { ...msg, pending: false, text: r.answer, result: r }
              : msg,
          ),
        );
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        setMessages((m) => m.map((msg) => (msg.id === aiId ? { ...msg, pending: false, error } : msg)));
      } finally {
        setBusy(false);
        void refresh();
      }
    },
    [busy, refresh],
  );

  // ---- render ----
  if (!state) {
    return (
      <div className="boot">
        <Mark size={40} />
        <span>starting MedConsult…</span>
      </div>
    );
  }
  if (!state.wallet.unlocked) {
    return <WalletGate status={state.wallet} onUnlocked={refresh} />;
  }

  const active = state.peer ?? null;

  return (
    <div className="shell">
      <TopBar role={role} onRole={changeRole} state={state} flash={flash} onManage={() => setMenuOpen(true)} />
      <ModelBanner progress={state.modelProgress} />

      <div className="shell-body">
        {role === 'seller' ? (
          <SellerScreen status={sellerStatus} busy={sellerBusy} onStart={onSellerStart} onStop={onSellerStop} />
        ) : view === 'marketplace' ? (
          <MarketplaceScreen state={state} sellers={sellers} onPick={onPick} />
        ) : (
          <div className="app">
            <Rail state={state} sellers={sellers} flash={flash} onSelect={onSelect} onManage={() => setMenuOpen(true)} />
            <main className="main">
              <div className="chat-head">
                <button className="back-btn" onClick={() => setView('marketplace')}>
                  <Back /> Marketplace
                </button>
                <span className="chat-peer">
                  {active ? `paying: ${modelName(active.model)} · ${active.price} USD₮` : 'free · on-device until escalation'}
                </span>
              </div>
              <Thread messages={messages} onExample={send} />
              <Composer onSend={send} busy={busy} ready={!!state.ready} setupErr={state.setupErr} />
            </main>
          </div>
        )}
      </div>

      {menuOpen && state.wallet.address && (
        <WalletMenu
          address={state.wallet.address}
          onClose={() => setMenuOpen(false)}
          onLocked={() => { setMenuOpen(false); setMessages([]); void refresh(); }}
        />
      )}
    </div>
  );
}
