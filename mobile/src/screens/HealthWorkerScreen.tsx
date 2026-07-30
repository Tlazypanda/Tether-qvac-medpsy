// The health worker's phone: incoming consult → streaming MedPsy draft → edit → Approve & Send.
//
// This is the screen the whole demo exists to show, so the review state is made deliberately
// unmissable on camera: a full-width amber banner, the draft in an editable box, and two large
// buttons. The disclaimer is pinned and cannot be scrolled away from the text it qualifies.
//
// Nothing leaves this device until Approve & Send is tapped — the P2P worklet is only told about the
// answer inside onApprove().
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { MEDICAL_DISCLAIMER, MEDPSY_LABEL, formatUsdt, testnetNotice } from '../medconsult';
import { useMedPsy, type Consult } from '../useMedPsy';
import {
  approveConsult,
  markAwaitingReview,
  onWorkletEvent,
  rejectConsult,
  startSwarm,
  type StartOpts,
} from '../worklet-bridge';

const C = {
  bg: '#0E1217',
  panel: '#151b23',
  panel2: '#1b232d',
  line: '#26313d',
  text: '#E7F0EF',
  dim: '#8A9AA6',
  accent: '#2BE3A8',
  warn: '#FFC44D',
  danger: '#FF6B6B',
};

export default function HealthWorkerScreen({ config }: { config: StartOpts }) {
  const { ready, loadError, loadPct, consults, submit, approve, reject } = useMedPsy();
  const [peers, setPeers] = useState(0);
  const [edits, setEdits] = useState<Record<string, string>>({});

  useEffect(() => {
    const off = onWorkletEvent((e) => {
      if (e.type === 'peers') setPeers(e.count);
      else if (e.type === 'consult-in') submit(e.requestId, e.question, e.askerWallet);
    });
    startSwarm(config);
    return off;
  }, [config, submit]);

  // Tell the asker a human is now reading — otherwise their phone shows a bare spinner and the wait
  // looks like a hang rather than a person doing their job. Tracked in a ref because `consults`
  // changes on every streamed token, and re-sending the notice each time would flood the link.
  const notified = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const c of consults) {
      if (c.stage === 'awaiting_review' && !notified.current.has(c.id)) {
        notified.current.add(c.id);
        markAwaitingReview(c.id);
      }
    }
  }, [consults]);

  function onApprove(c: Consult) {
    const decided = approve(c.id, edits[c.id]);
    if (!decided) return;
    approveConsult({
      requestId: decided.id,
      askerWallet: decided.askerWallet,
      answer: decided.finalAnswer,
      edited: decided.edited,
      reviewMs: decided.reviewMs,
      draftMs: decided.draftMs,
      stats: decided.stats as Record<string, unknown>,
    });
  }

  function onReject(c: Consult) {
    const decided = reject(c.id);
    if (decided) rejectConsult(decided.id, decided.rejectReason ?? 'rejected by health worker');
  }

  const price = config.offer?.priceBaseUnits ?? '0';

  return (
    <View style={s.root}>
      <View style={s.header}>
        <Text style={s.title}>Health Worker · Consult Review</Text>
        <Text style={s.sub}>
          {MEDPSY_LABEL} ·{' '}
          {loadError ? (
            <Text style={{ color: C.danger }}>model failed</Text>
          ) : ready ? (
            <Text style={{ color: C.accent }}>ready</Text>
          ) : (
            `loading ${loadPct}%`
          )}
          {'  ·  '}
          <Text style={{ color: peers > 0 ? C.accent : C.dim }}>
            {peers > 0 ? `${peers} asker${peers === 1 ? '' : 's'} linked` : 'no asker linked'}
          </Text>
        </Text>
      </View>

      {/* Pinned, not scrollable — it must never leave the frame. */}
      <View style={s.disclaimer}>
        <Text style={s.disclaimerText}>⚕ {MEDICAL_DISCLAIMER}</Text>
      </View>

      {loadError ? (
        <View style={s.card}>
          <Text style={s.err}>MedPsy failed to load: {loadError}</Text>
          <Text style={s.dim}>
            This device cannot draft consults. QVAC needs a physical device — it does not run on a
            simulator or emulator.
          </Text>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={{ padding: 14, gap: 14 }}>
        {consults.length === 0 ? (
          <View style={s.card}>
            <Text style={s.dim}>
              Waiting for consults. Nothing is ever sent to an asker without your approval.
            </Text>
          </View>
        ) : null}

        {consults.map((c) => (
          <View key={c.id} style={s.card}>
            <Text style={s.qLabel}>CONSULT · {c.askerWallet.slice(0, 10)}…</Text>
            <Text style={s.question}>{c.question}</Text>

            {c.stage === 'queued' || c.stage === 'drafting' ? (
              <View style={s.row}>
                <ActivityIndicator color={C.accent} />
                <Text style={s.dim}> {MEDPSY_LABEL} is drafting on this device…</Text>
              </View>
            ) : null}

            {c.stage === 'drafting' && c.draft ? <Text style={s.draft}>{c.draft}</Text> : null}

            {c.stage === 'awaiting_review' ? (
              <>
                <View style={s.reviewBanner}>
                  <Text style={s.reviewBannerText}>AWAITING YOUR REVIEW — NOT SENT</Text>
                </View>
                <Text style={s.metaLine}>
                  drafted in {(c.draftMs / 1000).toFixed(1)}s
                  {c.stats.tps ? ` · ${Math.round(c.stats.tps)} tok/s` : ''}
                  {c.stats.backend ? ` · ${c.stats.backend}` : ''}
                </Text>
                <TextInput
                  style={s.editor}
                  multiline
                  value={edits[c.id] ?? c.draft}
                  onChangeText={(t) => setEdits((e) => ({ ...e, [c.id]: t }))}
                  placeholder="The draft appears here — edit freely before sending."
                  placeholderTextColor={C.dim}
                />
                <View style={s.actions}>
                  <Pressable style={[s.btn, s.btnApprove]} onPress={() => onApprove(c)}>
                    <Text style={s.btnApproveText}>Approve &amp; Send</Text>
                    <Text style={s.btnSubText}>
                      earns {formatUsdt(price)} USD₮
                    </Text>
                  </Pressable>
                  <Pressable style={[s.btn, s.btnReject]} onPress={() => onReject(c)}>
                    <Text style={s.btnRejectText}>Reject</Text>
                    <Text style={s.btnSubText}>nothing sent, nothing charged</Text>
                  </Pressable>
                </View>
              </>
            ) : null}

            {c.stage === 'approved' ? (
              <Text style={s.approved}>
                ✓ Approved by you after {(c.reviewMs / 1000).toFixed(1)}s of review
                {c.edited ? ' (edited before sending)' : ' (sent as drafted)'}
              </Text>
            ) : null}

            {c.stage === 'rejected' ? (
              <Text style={s.rejected}>
                ✕ Rejected after {(c.reviewMs / 1000).toFixed(1)}s — {c.rejectReason}
              </Text>
            ) : null}

            {c.stage === 'error' ? <Text style={s.err}>Draft failed: {c.error}</Text> : null}
          </View>
        ))}
      </ScrollView>

      <Text style={s.footer}>
        {testnetNotice(config.offer?.chainId ?? 0)} · Nothing is sent until you tap Approve &amp; Send.
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 10 },
  title: { color: C.text, fontSize: 19, fontWeight: '700' },
  sub: { color: C.dim, fontSize: 12, marginTop: 3 },
  disclaimer: {
    marginHorizontal: 14,
    padding: 10,
    borderRadius: 8,
    backgroundColor: 'rgba(255,196,77,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,196,77,0.34)',
  },
  disclaimerText: { color: C.warn, fontSize: 12, lineHeight: 17, fontWeight: '600' },
  card: {
    backgroundColor: C.panel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.line,
    padding: 13,
    gap: 9,
  },
  qLabel: { color: C.dim, fontSize: 10, letterSpacing: 1, fontWeight: '700' },
  question: { color: C.text, fontSize: 15, lineHeight: 21 },
  row: { flexDirection: 'row', alignItems: 'center' },
  dim: { color: C.dim, fontSize: 13, lineHeight: 19 },
  draft: { color: C.dim, fontSize: 13, lineHeight: 19, fontStyle: 'italic' },
  reviewBanner: {
    backgroundColor: C.warn,
    borderRadius: 7,
    paddingVertical: 9,
    alignItems: 'center',
  },
  reviewBannerText: { color: '#1a1200', fontWeight: '800', fontSize: 13, letterSpacing: 0.6 },
  metaLine: { color: C.dim, fontSize: 11 },
  editor: {
    backgroundColor: C.panel2,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.line,
    color: C.text,
    padding: 11,
    fontSize: 14,
    lineHeight: 20,
    minHeight: 190,
    textAlignVertical: 'top',
  },
  actions: { gap: 9 },
  btn: { borderRadius: 9, paddingVertical: 13, alignItems: 'center' },
  btnApprove: { backgroundColor: C.accent },
  btnApproveText: { color: '#04231a', fontWeight: '800', fontSize: 16 },
  btnReject: { backgroundColor: 'transparent', borderWidth: 1, borderColor: C.danger },
  btnRejectText: { color: C.danger, fontWeight: '700', fontSize: 15 },
  btnSubText: { color: 'rgba(0,0,0,0.55)', fontSize: 11, marginTop: 2 },
  approved: { color: C.accent, fontSize: 13, fontWeight: '600' },
  rejected: { color: C.danger, fontSize: 13, fontWeight: '600' },
  err: { color: C.danger, fontSize: 13, lineHeight: 19 },
  footer: {
    color: C.dim,
    fontSize: 10,
    textAlign: 'center',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderTopWidth: 1,
    borderTopColor: C.line,
  },
});
