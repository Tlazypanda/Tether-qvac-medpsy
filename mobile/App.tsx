// Role picker → one of the two screens. The role is a runtime choice, exactly as on desktop: the
// same build ships to both phones and you pick Asker or Health Worker on launch.
//
// Config comes from mobile-config.json (gitignored, per device) so no keys are committed. The health
// worker's phone is the only one that needs a GPU and the ~2.7 GB model cache; the asker's phone
// deliberately carries no model at all.
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import AskerScreen from './src/screens/AskerScreen';
import HealthWorkerScreen from './src/screens/HealthWorkerScreen';
import { MEDICAL_DISCLAIMER_SHORT } from './src/medconsult';
import type { Role, StartOpts } from './src/worklet-bridge';

// Per-device config. Copy mobile-config.example.json → mobile-config.json and fill it in.
// Not committed: it holds a testnet private key.
let deviceConfig: any = {};
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  deviceConfig = require('./mobile-config.json');
} catch {
  deviceConfig = {};
}

const C = {
  bg: '#0E1217',
  panel: '#151b23',
  line: '#26313d',
  text: '#E7F0EF',
  dim: '#8A9AA6',
  accent: '#2BE3A8',
  warn: '#FFC44D',
};

export default function App() {
  const [role, setRole] = useState<Role | null>(null);

  const config: StartOpts | null = useMemo(() => {
    if (!role) return null;
    return {
      role,
      bootstrap: deviceConfig.bootstrap, // e.g. [{ host: '192.168.1.50', port: 49737 }]
      wallet: deviceConfig.wallet,
      offer: role === 'health-worker' ? deviceConfig.offer : undefined,
    };
  }, [role]);

  const missing = !deviceConfig.wallet;

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={s.root} edges={['top', 'bottom']}>
        {!role || !config ? (
          <ScrollView contentContainerStyle={s.pick}>
            <Text style={s.brand}>MedConsult</Text>
            <Text style={s.tagline}>
              Offline peer-to-peer medical consults. On-device AI, a human in the loop, and a
              testnet micropayment — no internet at the moment of the consult.
            </Text>

            {missing ? (
              <View style={s.warnBox}>
                <Text style={s.warnText}>
                  No mobile-config.json found. Copy mobile-config.example.json and fill in this
                  device's testnet wallet before running the demo.
                </Text>
              </View>
            ) : null}

            <Text style={s.pickLabel}>Which device is this?</Text>

            <Pressable style={s.roleCard} onPress={() => setRole('asker')}>
              <Text style={s.roleTitle}>Asker</Text>
              <Text style={s.roleBody}>
                Carries no medical model. Sends a health question to a health worker's device and
                pays for the reviewed answer.
              </Text>
            </Pressable>

            <Pressable style={s.roleCard} onPress={() => setRole('health-worker')}>
              <Text style={s.roleTitle}>Health Worker</Text>
              <Text style={s.roleBody}>
                Runs QVAC MedPsy-4B on this device (needs a GPU and ~2.7 GB of storage). Reviews and
                approves every draft before it is sent, and earns test USD₮ for it.
              </Text>
            </Pressable>

            <Text style={s.note}>
              ⚕ {MEDICAL_DISCLAIMER_SHORT}
            </Text>
            <Text style={s.note}>
              Physical devices only — QVAC does not run on simulators or emulators.
            </Text>
          </ScrollView>
        ) : role === 'asker' ? (
          <AskerScreen config={config} />
        ) : (
          <HealthWorkerScreen config={config} />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  pick: { padding: 20, gap: 14 },
  brand: { color: C.text, fontSize: 30, fontWeight: '800', marginTop: 20 },
  tagline: { color: C.dim, fontSize: 14, lineHeight: 21 },
  pickLabel: { color: C.text, fontSize: 13, fontWeight: '700', marginTop: 12 },
  roleCard: {
    backgroundColor: C.panel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.line,
    padding: 15,
    gap: 6,
  },
  roleTitle: { color: C.accent, fontSize: 17, fontWeight: '800' },
  roleBody: { color: C.dim, fontSize: 13, lineHeight: 19 },
  warnBox: {
    backgroundColor: 'rgba(255,196,77,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,196,77,0.34)',
    borderRadius: 8,
    padding: 11,
  },
  warnText: { color: C.warn, fontSize: 12, lineHeight: 18 },
  note: { color: C.dim, fontSize: 11, lineHeight: 16, marginTop: 4 },
});
