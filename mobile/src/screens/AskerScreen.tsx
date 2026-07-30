// The asker's phone: type a health question, wait for a human-reviewed answer, read it with the
// disclaimer attached.
//
// This device carries NO model. There is no local draft and no confidence router — every consult goes
// straight to a paid health-worker peer, so the only states are: idle → sent → drafting → a human is
// reviewing → answered | declined.
//
// The waiting copy matters more than it looks. Most of the wait is a person reading, not a machine
// working, and a spinner that says "thinking…" for 40 seconds reads as a hang. So the stage from the
// health worker's device is surfaced verbatim.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { MEDICAL_DISCLAIMER, formatUsdt, testnetNotice } from '../medconsult';
import { onWorkletEvent, sendConsult, startSwarm, type StartOpts } from '../worklet-bridge';

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

type Outcome =
  | { kind: 'pending'; stage: 'sent' | 'drafting' | 'awaiting_review' }
  | {
      kind: 'answer';
      answer: string;
      approvedByHuman: boolean;
      edited: boolean;
      reviewMs: number;
      draftMs: number;
      cost: string;
    }
  | { kind: 'declined'; reason: string; stage: 'gate' | 'human' | 'error' };

interface Turn {
  id: string;
  question: string;
  outcome: Outcome;
}

export default function AskerScreen({ config }: { config: StartOpts }) {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [peer, setPeer] = useState<{ model: string; price: string; chainId: number } | null>(null);
  const [peers, setPeers] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const costRef = useRef<Record<string, string>>({});

  useEffect(() => {
    const off = onWorkletEvent((e) => {
      if (e.type === 'peers') setPeers(e.count);
      else if (e.type === 'offer')
        setPeer({ model: e.model, price: e.priceBaseUnits, chainId: e.chainId });
      else if (e.type === 'stage')
        setTurns((ts) =>
          ts.map((t) =>
            t.id === e.requestId ? { ...t, outcome: { kind: 'pending', stage: e.stage } } : t,
          ),
        );
      else if (e.type === 'paid') costRef.current[e.requestId] = e.cumulative;
      else if (e.type === 'answer')
        setTurns((ts) =>
          ts.map((t) =>
            t.id === e.requestId
              ? {
                  ...t,
                  outcome: {
                    kind: 'answer',
                    answer: e.answer,
                    approvedByHuman: e.approvedByHuman,
                    edited: e.edited,
                    reviewMs: e.reviewMs,
                    draftMs: e.draftMs,
                    cost: peer?.price ?? '0',
                  },
                }
              : t,
          ),
        );
      else if (e.type === 'declined')
        setTurns((ts) =>
          ts.map((t) =>
            t.id === e.requestId
              ? { ...t, outcome: { kind: 'declined', reason: e.reason, stage: e.stage } }
              : t,
          ),
        );
      else if (e.type === 'error') setError(e.error);
    });
    startSwarm(config);
    return off;
  }, [config, peer?.price]);

  const canSend = useMemo(() => question.trim().length > 4 && peers > 0, [question, peers]);

  function onSend() {
    const q = question.trim();
    if (!q) return;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    setTurns((ts) => [...ts, { id, question: q, outcome: { kind: 'pending', stage: 'sent' } }]);
    setQuestion('');
    sendConsult(id, q);
  }

  return (
    <View style={s.root}>
      <View style={s.header}>
        <Text style={s.title}>Ask a Health Worker</Text>
        <Text style={s.sub}>
          this device carries no medical model ·{' '}
          <Text style={{ color: peers > 0 ? C.accent : C.dim }}>
            {peers > 0
              ? `health worker linked${peer ? ` · ${formatUsdt(peer.price)} USD₮ per consult` : ''}`
              : 'searching for a health worker…'}
          </Text>
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 14, gap: 12 }}>
        {error ? <Text style={s.err}>⚠ {error}</Text> : null}

        {turns.length === 0 ? (
          <View style={s.card}>
            <Text style={s.dim}>
              Describe the symptoms. Your question goes directly to a health worker's device over a
              local peer-to-peer link — no internet, no cloud. They review the AI-assisted draft
              before anything comes back to you.
            </Text>
          </View>
        ) : null}

        {turns.map((t) => (
          <View key={t.id} style={{ gap: 8 }}>
            <View style={s.bubbleUser}>
              <Text style={s.userText}>{t.question}</Text>
            </View>

            {t.outcome.kind === 'pending' ? (
              <View style={s.card}>
                <View style={s.row}>
                  <ActivityIndicator color={C.accent} />
                  <Text style={s.dim}>
                    {'  '}
                    {t.outcome.stage === 'awaiting_review'
                      ? 'a health worker is reviewing your consult…'
                      : t.outcome.stage === 'drafting'
                        ? 'drafting on the health worker’s device…'
                        : 'sending your consult…'}
                  </Text>
                </View>
                {t.outcome.stage === 'awaiting_review' ? (
                  <Text style={s.tinyDim}>
                    A person is reading it. This is meant to take a moment.
                  </Text>
                ) : null}
              </View>
            ) : null}

            {t.outcome.kind === 'answer' ? (
              <View style={s.card}>
                <View style={s.stamp}>
                  <Text style={s.stampText}>
                    ✓ Reviewed &amp; approved by a health worker · {formatUsdt(t.outcome.cost)} USD₮
                  </Text>
                </View>
                <Text style={s.answer}>{t.outcome.answer}</Text>
                {/* Inside the bubble by design: it cannot be scrolled away from the text it qualifies. */}
                <View style={s.disclaimer}>
                  <Text style={s.disclaimerText}>⚕ {MEDICAL_DISCLAIMER}</Text>
                </View>
                <Text style={s.tinyDim}>
                  human-approved · {t.outcome.edited ? 'edited before sending' : 'sent as drafted'} ·
                  review {(t.outcome.reviewMs / 1000).toFixed(1)}s · draft{' '}
                  {(t.outcome.draftMs / 1000).toFixed(1)}s · 0 cloud bytes
                </Text>
              </View>
            ) : null}

            {t.outcome.kind === 'declined' ? (
              <View style={s.card}>
                <Text style={s.declined}>
                  {t.outcome.stage === 'human'
                    ? 'The health worker did not approve this draft'
                    : t.outcome.stage === 'gate'
                      ? 'No health worker available'
                      : 'The consult did not complete'}
                </Text>
                <Text style={s.tinyDim}>{t.outcome.reason} · you were not charged</Text>
              </View>
            ) : null}
          </View>
        ))}
      </ScrollView>

      <View style={s.composer}>
        <TextInput
          style={s.input}
          multiline
          value={question}
          onChangeText={setQuestion}
          placeholder="Describe the symptoms…"
          placeholderTextColor={C.dim}
        />
        <Pressable
          style={[s.send, !canSend && s.sendOff]}
          onPress={onSend}
          disabled={!canSend}
        >
          <Text style={[s.sendText, !canSend && { color: C.dim }]}>Send</Text>
        </Pressable>
      </View>
      <Text style={s.footer}>{testnetNotice(peer?.chainId ?? config.wallet?.voucherDomain.chainId ?? 0)}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 10 },
  title: { color: C.text, fontSize: 19, fontWeight: '700' },
  sub: { color: C.dim, fontSize: 12, marginTop: 3 },
  card: {
    backgroundColor: C.panel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.line,
    padding: 13,
    gap: 9,
  },
  bubbleUser: {
    alignSelf: 'flex-end',
    maxWidth: '86%',
    backgroundColor: C.panel2,
    borderRadius: 12,
    padding: 11,
  },
  userText: { color: C.text, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: 'row', alignItems: 'center' },
  dim: { color: C.dim, fontSize: 13, lineHeight: 19 },
  tinyDim: { color: C.dim, fontSize: 11, lineHeight: 16 },
  stamp: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(43,227,168,0.13)',
    borderWidth: 1,
    borderColor: 'rgba(43,227,168,0.34)',
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  stampText: { color: C.accent, fontSize: 11, fontWeight: '700' },
  answer: { color: C.text, fontSize: 15, lineHeight: 22 },
  disclaimer: {
    padding: 10,
    borderRadius: 8,
    backgroundColor: 'rgba(255,196,77,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,196,77,0.34)',
  },
  disclaimerText: { color: C.warn, fontSize: 12, lineHeight: 17 },
  declined: { color: C.warn, fontSize: 14, fontWeight: '600' },
  err: { color: C.danger, fontSize: 13 },
  composer: {
    flexDirection: 'row',
    gap: 9,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: C.line,
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    backgroundColor: C.panel2,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.line,
    color: C.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    maxHeight: 120,
  },
  send: { backgroundColor: C.accent, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 13 },
  sendOff: { backgroundColor: C.panel2 },
  sendText: { color: '#04231a', fontWeight: '800', fontSize: 15 },
  footer: { color: C.dim, fontSize: 10, textAlign: 'center', paddingBottom: 8 },
});
