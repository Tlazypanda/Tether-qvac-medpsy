// MUST be imported first in index.ts, before anything that pulls in @qvac/sdk or ethers.
//
// We run on JSC (see app.json) because that is the engine the QVAC Bare bridge and the Holepunch
// stack are exercised against. JSC is missing several globals that those libraries assume, and each
// gap below is a real crash we would otherwise hit on a device:
//
//   BigInt            Android JSC has none. Our prices and voucher totals are BigInt.
//   TextEncoder/      the worklet bridge frames newline-delimited JSON as bytes.
//   TextDecoder
//   structuredClone   used by the SDK's RPC layer to pass plain objects across the bridge.
//   ReadableStream    streamed completions surface as web streams.
//
// Guarded individually so a newer RN/JSC that ships one of these natively is left alone, and so one
// missing optional dependency cannot take the whole app down at startup.
import { Platform } from 'react-native';

/* eslint-disable @typescript-eslint/no-var-requires */

const g: any = globalThis as any;

function install(name: string, make: () => unknown) {
  try {
    if (g[name] == null) g[name] = make();
  } catch (e) {
    console.warn(`[polyfills] ${name} unavailable:`, (e as Error)?.message);
  }
}

// BigInt via JSBI. NOTE: this is a *display-side* shim only — it is deliberately NOT good enough for
// ethers, which requires a genuine BigInt. That is exactly why voucher signing lives in the Bare
// worklet instead of here. See babel.config.js.
if (typeof g.BigInt === 'undefined') {
  try {
    const JSBI = require('jsbi');
    const Shim: any = (v: any) => JSBI.BigInt(v);
    Shim.asIntN = (bits: number, v: any) => JSBI.asIntN(bits, v);
    Shim.asUintN = (bits: number, v: any) => JSBI.asUintN(bits, v);
    g.BigInt = Shim;
  } catch (e) {
    console.warn('[polyfills] JSBI BigInt shim unavailable:', (e as Error)?.message);
  }
}

if (Platform.OS !== 'web') {
  try {
    require('fast-text-encoding'); // installs TextEncoder / TextDecoder when absent
  } catch (e) {
    console.warn('[polyfills] fast-text-encoding unavailable:', (e as Error)?.message);
  }

  install('structuredClone', () => require('@ungap/structured-clone').default);

  try {
    const streams = require('web-streams-polyfill');
    install('ReadableStream', () => streams.ReadableStream);
    install('WritableStream', () => streams.WritableStream);
    install('TransformStream', () => streams.TransformStream);
  } catch (e) {
    console.warn('[polyfills] web-streams-polyfill unavailable:', (e as Error)?.message);
  }

  try {
    const te = require('@stardazed/streams-text-encoding');
    install('TextEncoderStream', () => te.TextEncoderStream);
    install('TextDecoderStream', () => te.TextDecoderStream);
  } catch {
    /* only needed for streaming text encoders; safe to skip */
  }
}

export {};
