// The health worker's approval screen, as one self-contained HTML string.
//
// Deliberately dependency-free and build-step-free: upstream Conduit's provider role is headless
// (`npm run sell`), so there is no seller-side bundler to hook into, and a health worker running
// the CLI on a laptop should be able to open a URL and review consults without first building a
// React app. It is also the screen that has to read clearly on camera, hence the large type and
// the unmissable review banner.
import { MEDICAL_DISCLAIMER, MEDPSY_LABEL, TESTNET_NOTICE } from '../core/medconsult';

export function approvalPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Health Worker — Consult Review</title>
<style>
  :root {
    --bg: #0E1217; --panel: #151b23; --panel2: #1b232d; --line: #26313d;
    --text: #E7F0EF; --dim: #8A9AA6; --accent: #2BE3A8; --warn: #FFC44D; --danger: #FF6B6B;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--text);
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex; flex-direction: column;
  }
  header {
    padding: 14px 20px; border-bottom: 1px solid var(--line);
    display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  }
  h1 { font-size: 17px; margin: 0; font-weight: 600; letter-spacing: .2px; }
  h1 .dot { color: var(--accent); }
  .chip {
    font-size: 12px; padding: 3px 10px; border-radius: 999px;
    background: var(--panel2); border: 1px solid var(--line); color: var(--dim);
    white-space: nowrap;
  }
  .chip.on { color: var(--accent); border-color: #24594a; }
  .chip.off { color: var(--danger); border-color: #5b2b2b; }
  .spacer { flex: 1; }

  /* The disclaimer is persistent by design — it must never scroll off camera. */
  .disclaimer {
    background: #2a2113; border-bottom: 1px solid #4a3a1c; color: var(--warn);
    padding: 9px 20px; font-size: 13px; display: flex; gap: 9px; align-items: baseline;
  }
  .disclaimer b { color: #ffdb8f; font-weight: 600; }

  main { flex: 1; display: flex; min-height: 0; }
  .queue {
    width: 290px; border-right: 1px solid var(--line); overflow-y: auto;
    background: #11161d; flex-shrink: 0;
  }
  .queue h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: .09em; color: var(--dim);
    margin: 0; padding: 15px 16px 9px;
  }
  .item {
    padding: 12px 16px; border-bottom: 1px solid #1c242e; cursor: pointer;
    border-left: 3px solid transparent;
  }
  .item:hover { background: #151c24; }
  .item.sel { background: #172029; border-left-color: var(--accent); }
  .item .q { font-size: 13px; color: var(--text); margin-bottom: 5px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .item .meta { font-size: 11px; color: var(--dim); display: flex; gap: 7px; align-items: center; }
  .stage { font-size: 10px; padding: 2px 7px; border-radius: 4px; text-transform: uppercase;
    letter-spacing: .05em; font-weight: 600; }
  .stage.drafting, .stage.queued { background: #2b2f14; color: var(--warn); }
  .stage.awaiting_review { background: #3a2a0c; color: #ffd479; }
  .stage.approved { background: #102f24; color: var(--accent); }
  .stage.rejected, .stage.error { background: #331717; color: var(--danger); }

  .detail { flex: 1; overflow-y: auto; padding: 22px 26px; min-width: 0; }
  .empty { color: var(--dim); text-align: center; margin-top: 70px; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: .09em;
    color: var(--dim); margin: 0 0 8px; }
  .question {
    background: var(--panel); border: 1px solid var(--line); border-left: 3px solid #3a536b;
    border-radius: 8px; padding: 14px 16px; margin-bottom: 20px; white-space: pre-wrap;
  }

  /* The review banner is the point of the whole screen — make it impossible to miss. */
  .review-banner {
    background: linear-gradient(90deg, #3a2a0c, #2a2113); border: 1px solid #6b5320;
    border-radius: 8px; padding: 13px 16px; margin-bottom: 16px;
    display: flex; align-items: center; gap: 12px;
  }
  .review-banner .big { font-size: 15px; font-weight: 600; color: #ffd479; }
  .review-banner .sub { font-size: 12.5px; color: #c9ab6a; }
  .pulse { width: 9px; height: 9px; border-radius: 50%; background: var(--warn);
    animation: p 1.4s ease-in-out infinite; flex-shrink: 0; }
  @keyframes p { 0%,100% { opacity: 1; transform: scale(1);} 50% { opacity:.35; transform: scale(.8);} }

  textarea {
    width: 100%; min-height: 300px; background: var(--panel); color: var(--text);
    border: 1px solid var(--line); border-radius: 8px; padding: 15px 16px; resize: vertical;
    font: 15px/1.65 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap;
  }
  textarea:focus { outline: none; border-color: #2f6f5c; }
  textarea:disabled { opacity: .75; }
  .editnote { font-size: 12px; color: var(--warn); margin-top: 7px; min-height: 18px; }

  .actions { display: flex; gap: 11px; margin-top: 15px; align-items: center; flex-wrap: wrap; }
  button {
    font: 600 15px/1 system-ui, sans-serif; padding: 13px 22px; border-radius: 8px;
    border: 1px solid transparent; cursor: pointer;
  }
  button:disabled { opacity: .4; cursor: not-allowed; }
  .approve { background: var(--accent); color: #06201a; }
  .approve:not(:disabled):hover { background: #4ff0bd; }
  .reject { background: transparent; color: var(--danger); border-color: #5b2b2b; }
  .reject:not(:disabled):hover { background: #241717; }
  .stats { font-size: 12px; color: var(--dim); margin-top: 14px; line-height: 1.9; }
  .stats code { color: var(--accent); background: #10201b; padding: 1px 6px;
    border-radius: 4px; font-size: 11.5px; }
  .outcome { margin-top: 16px; padding: 13px 16px; border-radius: 8px; font-size: 14px; }
  .outcome.approved { background: #10241d; border: 1px solid #24594a; color: var(--accent); }
  .outcome.rejected { background: #241717; border: 1px solid #5b2b2b; color: var(--danger); }
  footer { padding: 9px 20px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--dim); }

  @media (max-width: 780px) {
    main { flex-direction: column; }
    .queue { width: 100%; max-height: 148px; border-right: none; border-bottom: 1px solid var(--line); }
    .detail { padding: 16px; }
  }
</style>
</head>
<body>
<header>
  <h1><span class="dot">⬡</span> Health Worker — Consult Review</h1>
  <span class="chip" id="model-chip">${MEDPSY_LABEL}</span>
  <span class="chip" id="ready-chip">model loading…</span>
  <div class="spacer"></div>
  <span class="chip" id="net-chip">peer link</span>
  <span class="chip" id="count-chip">0 waiting</span>
</header>

<div class="disclaimer">
  <b>⚕</b><span><b>${MEDICAL_DISCLAIMER}</b></span>
</div>

<main>
  <section class="queue">
    <h2>Incoming consults</h2>
    <div id="list"></div>
  </section>

  <section class="detail" id="detail">
    <div class="empty">Waiting for a consult request from an asker…</div>
  </section>
</main>

<footer>${TESTNET_NOTICE} &nbsp;·&nbsp; Nothing is sent to the asker until you tap <b>Approve &amp; Send</b>.</footer>

<script>
(function () {
  var state = { consults: [], selected: null, ready: false, model: '', edits: {} };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function secs(ms) { return (Number(ms || 0) / 1000).toFixed(1) + 's'; }

  function byId(id) {
    for (var i = 0; i < state.consults.length; i++) if (state.consults[i].id === id) return state.consults[i];
    return null;
  }

  function renderList() {
    var el = document.getElementById('list');
    if (!state.consults.length) {
      el.innerHTML = '<div style="padding:16px;color:#8A9AA6;font-size:13px">No consults yet.</div>';
    } else {
      el.innerHTML = state.consults.map(function (c) {
        return '<div class="item ' + (c.id === state.selected ? 'sel' : '') + '" data-id="' + esc(c.id) + '">' +
          '<div class="q">' + esc(c.question) + '</div>' +
          '<div class="meta"><span class="stage ' + esc(c.stage) + '">' + esc(c.stage.replace(/_/g, ' ')) + '</span>' +
          '<span>' + new Date(c.receivedAt).toLocaleTimeString() + '</span></div></div>';
      }).join('');
      Array.prototype.forEach.call(el.querySelectorAll('.item'), function (n) {
        n.onclick = function () { state.selected = n.getAttribute('data-id'); render(); };
      });
    }
    var waiting = state.consults.filter(function (c) { return c.stage === 'awaiting_review'; }).length;
    var cc = document.getElementById('count-chip');
    cc.textContent = waiting + ' waiting';
    cc.className = 'chip' + (waiting ? ' on' : '');
    var rc = document.getElementById('ready-chip');
    rc.textContent = state.ready ? 'model ready' : 'model loading…';
    rc.className = 'chip' + (state.ready ? ' on' : '');
  }

  function renderDetail() {
    var d = document.getElementById('detail');
    var c = state.selected ? byId(state.selected) : null;
    if (!c) { d.innerHTML = '<div class="empty">Waiting for a consult request from an asker…</div>'; return; }

    var h = '<p class="label">Consult from asker ' + esc((c.askerWallet || '').slice(0, 10)) + '…</p>';
    h += '<div class="question">' + esc(c.question) + '</div>';

    if (c.stage === 'queued' || c.stage === 'drafting') {
      h += '<div class="review-banner"><span class="pulse"></span><div>' +
        '<div class="big">' + esc(state.model) + ' is drafting on this device</div>' +
        '<div class="sub">Nothing has been sent to the asker.</div></div></div>';
      h += '<p class="label">Draft (streaming)</p>';
      h += '<textarea id="draft" disabled>' + esc(c.draft) + '</textarea>';
    } else if (c.stage === 'awaiting_review') {
      h += '<div class="review-banner"><span class="pulse"></span><div>' +
        '<div class="big">Your review is required</div>' +
        '<div class="sub">This draft has NOT been sent. Edit it if needed, then approve or reject.</div>' +
        '</div></div>';
      h += '<p class="label">Draft — edit freely before sending</p>';
      var cur = state.edits[c.id] != null ? state.edits[c.id] : c.finalAnswer;
      h += '<textarea id="draft">' + esc(cur) + '</textarea>';
      h += '<div class="editnote" id="editnote"></div>';
      h += '<div class="actions">' +
        '<button class="approve" id="btn-approve">Approve &amp; Send</button>' +
        '<button class="reject" id="btn-reject">Reject</button></div>';
    } else {
      h += '<p class="label">' + (c.stage === 'approved' ? 'Sent to asker' : 'Not sent') + '</p>';
      h += '<textarea disabled>' + esc(c.stage === 'approved' ? c.finalAnswer : c.draft) + '</textarea>';
      if (c.stage === 'approved') {
        h += '<div class="outcome approved">✓ Approved by you after ' + secs(c.reviewMs) + ' of review' +
          (c.edited ? ' · <b>edited before sending</b>' : ' · sent unedited') +
          '<br>Payment voucher settled peer-to-peer on approval.</div>';
      } else if (c.stage === 'rejected') {
        h += '<div class="outcome rejected">✕ Rejected after ' + secs(c.reviewMs) +
          ' — nothing was sent and nothing was charged.<br>' + esc(c.rejectReason || '') + '</div>';
      } else {
        h += '<div class="outcome rejected">Drafting failed: ' + esc(c.error || 'unknown error') + '</div>';
      }
    }

    var st = c.stats || {};
    if (c.draftMs) {
      h += '<div class="stats">' +
        'model <code>' + esc(state.model) + '</code> · ' +
        'backend <code>' + esc(st.backend || '?') + '</code> · ' +
        'draft <code>' + secs(c.draftMs) + '</code> · ' +
        'ttft <code>' + (st.ttftMs != null ? Math.round(st.ttftMs) + 'ms' : '?') + '</code> · ' +
        'speed <code>' + (st.tps != null ? st.tps.toFixed(1) + ' tok/s' : '?') + '</code> · ' +
        'prompt bytes to cloud <code>0</code></div>';
    }
    d.innerHTML = h;

    var ta = document.getElementById('draft');
    if (ta && !ta.disabled) {
      ta.oninput = function () {
        state.edits[c.id] = ta.value;
        var note = document.getElementById('editnote');
        note.textContent = ta.value.trim() !== (c.draft || '').trim()
          ? '✎ edited — the asker will receive your edited version'
          : '';
      };
      ta.oninput();
      var ap = document.getElementById('btn-approve');
      var rj = document.getElementById('btn-reject');
      ap.onclick = function () {
        ap.disabled = rj.disabled = true;
        post('/api/consults/' + encodeURIComponent(c.id) + '/approve', { text: ta.value });
      };
      rj.onclick = function () {
        var reason = window.prompt('Reason for rejecting (optional, not sent to the asker):') || '';
        ap.disabled = rj.disabled = true;
        post('/api/consults/' + encodeURIComponent(c.id) + '/reject', { reason: reason });
      };
    }
  }

  function render() { renderList(); renderDetail(); }

  function post(url, body) {
    return fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json(); }).catch(function () { /* SSE will resync */ });
  }

  function apply(snap) {
    state.consults = snap.consults || [];
    state.ready = !!snap.ready;
    state.model = snap.model || '';
    document.getElementById('model-chip').textContent = snap.modelLabel || snap.model || '';
    var nc = document.getElementById('net-chip');
    nc.textContent = snap.peersConnected ? snap.peersConnected + ' peer link' + (snap.peersConnected > 1 ? 's' : '') : 'no peer yet';
    nc.className = 'chip' + (snap.peersConnected ? ' on' : ' off');
    // Auto-focus whatever needs a human right now — on a phone, hunting for it costs time.
    var waiting = state.consults.filter(function (c) { return c.stage === 'awaiting_review'; });
    if (!state.selected || !byId(state.selected)) state.selected = (waiting[0] || state.consults[0] || {}).id || null;
    render();
  }

  var es = new EventSource('/api/stream');
  es.onmessage = function (e) { try { apply(JSON.parse(e.data)); } catch (err) {} };
  es.onerror = function () {
    var nc = document.getElementById('net-chip');
    nc.textContent = 'server offline'; nc.className = 'chip off';
  };
  fetch('/api/state').then(function (r) { return r.json(); }).then(apply).catch(function () {});
})();
</script>
</body>
</html>`;
}
