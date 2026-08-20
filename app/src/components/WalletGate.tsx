import { useEffect, useState } from 'react';
import { createWallet, importWallet, unlockWallet, type WalletStatus } from '../api';
import { secretAvailable, rememberPassword, getRememberedPassword, forgetPassword } from '../desktop';
import { Mark } from './icons';

type View = 'choose' | 'create' | 'backup' | 'import' | 'unlock';

const AUTO_FLAG = 'conduit:autounlock-tried'; // once per app session, so a manual lock isn't re-opened

function short(a: string | null): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
}

export default function WalletGate({ status, onUnlocked }: { status: WalletStatus; onUnlocked: () => void }) {
  const [view, setView] = useState<View>(status.exists ? 'unlock' : 'choose');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [phrase, setPhrase] = useState('');
  const [mnemonic, setMnemonic] = useState('');
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [canRemember, setCanRemember] = useState(false); // desktop + OS keychain available
  const [remember, setRemember] = useState(false);

  function reset() { setPw(''); setPw2(''); setPhrase(''); setErr(''); }

  // Persist (or forget) the password in the OS keychain per the "remember on this device" choice.
  async function persistRemember(password: string) {
    if (remember) await rememberPassword(password);
    else await forgetPassword();
  }

  // On mount: detect desktop keychain support and, if a password is remembered, auto-unlock once.
  useEffect(() => {
    let live = true;
    void (async () => {
      const avail = await secretAvailable();
      if (!live) return;
      setCanRemember(avail);
      if (avail && status.exists) {
        const remembered = await getRememberedPassword();
        if (!live || !remembered) return;
        setRemember(true);
        if (!sessionStorage.getItem(AUTO_FLAG)) {
          sessionStorage.setItem(AUTO_FLAG, '1');
          void doUnlock(remembered);
        }
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function doCreate() {
    if (pw.length < 8) return setErr('Password must be at least 8 characters.');
    if (pw !== pw2) return setErr('Passwords don’t match.');
    setBusy(true); setErr('');
    try {
      const { mnemonic } = await createWallet(pw);
      await persistRemember(pw);
      setMnemonic(mnemonic);
      setView('backup');
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function doImport() {
    if (pw.length < 8) return setErr('Password must be at least 8 characters.');
    if (pw !== pw2) return setErr('Passwords don’t match.');
    setBusy(true); setErr('');
    try {
      await importWallet(phrase, pw);
      await persistRemember(pw);
      onUnlocked();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function doUnlock(pwArg?: string) {
    const password = pwArg ?? pw;
    setBusy(true); setErr('');
    try {
      await unlockWallet(password);
      await persistRemember(password);
      onUnlocked();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const rememberRow = canRemember && (
    <label className="gate-check">
      <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
      Remember on this device
    </label>
  );

  return (
    <div className="gate">
      <div className="gate-card rise">
        <div className="gate-brand">
          <Mark size={34} />
          <div className="wordmark">MedConsult</div>
        </div>

        {view === 'choose' && (
          <>
            <h2>Your private AI wallet</h2>
            <p className="gate-sub">Pay peers a fraction of a cent in USD₮ for answers — no account, no cloud. Your keys stay on this device.</p>
            <button className="gate-btn primary" onClick={() => { reset(); setView('create'); }}>Create a new wallet</button>
            <button className="gate-btn ghost" onClick={() => { reset(); setView('import'); }}>I already have a recovery phrase</button>
          </>
        )}

        {view === 'create' && (
          <>
            <h2>Create your wallet</h2>
            <p className="gate-sub">Set a password to lock it on this device. You’ll back up a recovery phrase next.</p>
            <input className="gate-input" type="password" placeholder="Password (min 8 characters)" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
            <input className="gate-input" type="password" placeholder="Confirm password" value={pw2} onChange={(e) => setPw2(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doCreate()} />
            {rememberRow}
            {err && <div className="gate-err">{err}</div>}
            <button className="gate-btn primary" onClick={doCreate} disabled={busy}>{busy ? 'Creating…' : 'Create wallet'}</button>
            <button className="gate-link" onClick={() => { reset(); setView('choose'); }}>← back</button>
          </>
        )}

        {view === 'backup' && (
          <>
            <h2>Back up your recovery phrase</h2>
            <p className="gate-sub warn">These 12 words are the <b>only</b> way to recover your wallet. Write them down, keep them offline, never share them.</p>
            <div className="seed-grid">
              {mnemonic.split(' ').map((w, i) => (
                <div className="seed-word" key={i}><span className="n">{i + 1}</span>{w}</div>
              ))}
            </div>
            <button className="gate-link" onClick={() => navigator.clipboard?.writeText(mnemonic)}>copy phrase</button>
            <label className="gate-check">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              I’ve written down my recovery phrase
            </label>
            <button className="gate-btn primary" onClick={onUnlocked} disabled={!saved}>Continue</button>
          </>
        )}

        {view === 'import' && (
          <>
            <h2>Import your wallet</h2>
            <p className="gate-sub">Paste your 12-word recovery phrase and set a password for this device.</p>
            <textarea className="gate-input seed-input" placeholder="word1 word2 word3 …" value={phrase} onChange={(e) => setPhrase(e.target.value)} rows={3} autoFocus />
            <input className="gate-input" type="password" placeholder="Password (min 8 characters)" value={pw} onChange={(e) => setPw(e.target.value)} />
            <input className="gate-input" type="password" placeholder="Confirm password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
            {rememberRow}
            {err && <div className="gate-err">{err}</div>}
            <button className="gate-btn primary" onClick={doImport} disabled={busy}>{busy ? 'Importing…' : 'Import wallet'}</button>
            <button className="gate-link" onClick={() => { reset(); setView('choose'); }}>← back</button>
          </>
        )}

        {view === 'unlock' && (
          <>
            <h2>Welcome back</h2>
            <p className="gate-sub">Unlock your wallet {status.address && <span className="mono">{short(status.address)}</span>}</p>
            <input className="gate-input" type="password" placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doUnlock()} autoFocus />
            {rememberRow}
            {err && <div className="gate-err">{err}</div>}
            <button className="gate-btn primary" onClick={() => doUnlock()} disabled={busy}>{busy ? 'Unlocking…' : 'Unlock'}</button>
          </>
        )}
      </div>
    </div>
  );
}
