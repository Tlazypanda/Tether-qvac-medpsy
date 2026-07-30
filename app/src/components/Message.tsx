import { motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMsg } from '../types';
import type { AskResult } from '../api';
import { Coin, Local } from './icons';

// The disclaimer the asker sees under every answer. Kept in sync with src/core/medconsult.ts —
// the engine also sends it on each result, but a hardcoded fallback means it can never go missing
// just because an older engine didn't send the field.
const DISCLAIMER =
  'AI-assisted draft, reviewed by a human health worker before sending. ' +
  'Not a substitute for professional medical care in an emergency.';

// USD₮ amounts here are micro-payments — fractions of a cent (0.002–0.02). Two decimals would
// round them to "0.00", so show up to 4 decimals and trim trailing zeros (0.002, 0.005, 0.01).
function usdt(v: string | number): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function secs(ms: number | null): string {
  return ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`;
}

function Stamp({ r }: { r: AskResult }) {
  if (r.source === 'consult') {
    return (
      <motion.span
        className="stamp paid"
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 520, damping: 22 }}
      >
        <Coin /> Reviewed &amp; approved by a health worker · {usdt(r.cost)} USD₮
      </motion.span>
    );
  }
  // No answer came back. Say which of the four reasons it was — a human declining to send is a
  // legitimate outcome and must not read like a network error.
  const label =
    r.reason === 'no-peer' ? 'No health worker online'
    : r.reason === 'rejected' ? 'Health worker did not approve'
    : r.reason === 'budget' ? 'Budget reached · not sent'
    : 'Consult did not complete';
  return (
    <span className="stamp declined" title={r.note ?? undefined}>
      <Local /> {label}
    </span>
  );
}

function Telemetry({ r }: { r: AskResult }) {
  if (r.source !== 'consult') return null;
  return (
    <div className="telemetry">
      <span className="ok">human-approved</span>
      {r.edited ? <span>edited before sending</span> : <span>sent as drafted</span>}
      <span>review <b>{secs(r.reviewMs)}</b></span>
      <span>draft <b>{secs(r.draftMs)}</b></span>
      {r.stats.tps ? <span><b>{Math.round(r.stats.tps)}</b> tok/s</span> : null}
      <span className="ok">0 cloud bytes</span>
    </div>
  );
}

export default function Message({ m }: { m: ChatMsg }) {
  const isConsult = m.result?.source === 'consult';
  return (
    <motion.div
      className={`msg ${m.role}`}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <div className="bubble">
        {m.role === 'me' ? (
          m.text
        ) : m.pending ? (
          <div className="thinking">
            <i /><i /><i />
            {/* The wait here is mostly a person reading, not a machine working — say so, or a
                30-second pause looks like a hang. */}
            <span>a health worker is drafting and reviewing your consult…</span>
          </div>
        ) : m.error ? (
          <div className="errline">⚠ {m.error}</div>
        ) : (
          <>
            {m.result && <Stamp r={m.result} />}
            {m.result && m.result.source === 'declined' && m.result.note ? (
              <div className="answer">{m.result.note}</div>
            ) : (
              <div className="answer markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
              </div>
            )}
            {isConsult && (
              <div className="disclaimer-inline">⚕ {m.result?.disclaimer ?? DISCLAIMER}</div>
            )}
            {m.result && <Telemetry r={m.result} />}
          </>
        )}
      </div>
    </motion.div>
  );
}
