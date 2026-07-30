// A tiny local HTTP server that gives the health worker a screen.
//
// Upstream Conduit's provider role is headless — `npm run sell` prints to a terminal and the only
// UI in the repo is the buyer's React app. A human-approval gate needs a human-facing surface on
// the PROVIDER side, so the seller node serves its own: one page, an SSE stream for live draft
// tokens, and two POST endpoints for the approve/reject decision.
//
// Bound to loopback by default: the approval screen can release a medical answer and authorise a
// payment, so it must not be reachable from the network unless the operator opts in explicitly
// (HW_UI_HOST=0.0.0.0, e.g. to review consults from a phone on the same LAN).
import http from 'node:http';
import type { ConsultQueue, Consult } from './consult';
import { approvalPage } from './approval-page';
import { MEDPSY_LABEL } from '../core/medconsult';

export interface ApprovalServerDeps {
  queue: ConsultQueue;
  model: string;
  /** Chain the seller is settling on — the page names it rather than assuming Sepolia. */
  chainId: number;
  port?: number;
  host?: string;
  /** How many asker peers are currently connected — shown as a link indicator on the screen. */
  peersConnected: () => number;
  log?: (m: string) => void;
}

export interface ApprovalServer {
  url: string;
  /** Push the current snapshot to every open screen (called on any queue change). */
  broadcast(): void;
  close(): Promise<void>;
}

/** The JSON shape the approval page renders. Answer text included — this is the reviewer's screen. */
function view(c: Consult) {
  return {
    id: c.id,
    question: c.question,
    askerWallet: c.askerWallet,
    stage: c.stage,
    draft: c.draft,
    finalAnswer: c.finalAnswer,
    edited: c.edited,
    error: c.error ?? null,
    rejectReason: c.rejectReason ?? null,
    receivedAt: c.receivedAt,
    draftMs: c.draftMs,
    reviewMs: c.reviewMs,
    stats: c.stats,
  };
}

export async function startApprovalServer(deps: ApprovalServerDeps): Promise<ApprovalServer> {
  const log = deps.log ?? (() => {});
  const port = deps.port ?? Number(process.env.HW_UI_PORT || 8799);
  const host = deps.host ?? process.env.HW_UI_HOST ?? '127.0.0.1';
  const clients = new Set<http.ServerResponse>();

  function snapshot() {
    return {
      ready: deps.queue.ready(),
      loadError: deps.queue.loadError(),
      model: deps.model,
      modelLabel: MEDPSY_LABEL,
      peersConnected: deps.peersConnected(),
      consults: deps.queue.list().map(view),
    };
  }

  function broadcast() {
    const line = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const c of clients) {
      try { c.write(line); } catch { clients.delete(c); }
    }
  }

  function json(res: http.ServerResponse, code: number, obj: unknown) {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  function body(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
      let b = '';
      req.on('data', (c) => {
        b += c;
        if (b.length > 1_000_000) { b = ''; req.destroy(); resolve({}); } // an edited consult is never 1 MB
      });
      req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const p = url.pathname;
    void (async () => {
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(approvalPage(deps.chainId));
        return;
      }
      if (req.method === 'GET' && p === '/api/state') { json(res, 200, snapshot()); return; }

      if (req.method === 'GET' && p === '/api/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      const decide = /^\/api\/consults\/([^/]+)\/(approve|reject)$/.exec(p);
      if (req.method === 'POST' && decide) {
        const id = decodeURIComponent(decide[1]!);
        const b = await body(req);
        const c = decide[2] === 'approve'
          ? deps.queue.approve(id, typeof b.text === 'string' ? b.text : undefined)
          : deps.queue.reject(id, typeof b.reason === 'string' ? b.reason : undefined);
        if (!c) { json(res, 409, { error: 'consult is not awaiting review' }); return; }
        json(res, 200, view(c));
        broadcast();
        return;
      }

      res.writeHead(404); res.end('not found');
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
  log(`[health-worker] approval screen → ${url}`);
  if (host === '0.0.0.0') log('[health-worker] WARNING: approval screen bound to 0.0.0.0 — reachable from your LAN');

  return {
    url,
    broadcast,
    async close() {
      for (const c of clients) { try { c.end(); } catch { /* gone */ } }
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
