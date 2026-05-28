/**
 * Bus-domain dispatcher composer.
 *
 * Publishes a code-review Task envelope to the Myelin bus and waits
 * for the verdict + lifecycle envelopes to come back. Composition
 * of three Modules:
 *
 *   - `src/tasks/envelope.ts`  — pure spec construction
 *   - `src/bus/client.ts`       — encapsulation seam over NATS
 *   - `src/bus/lifecycle.ts`    — async-generator FSM
 *
 * Race-free subscribe-before-publish is structural by program order:
 * `bus.subscribe()` arms the SUB synchronously; `await bus.publish()`
 * is unreachable until both iterables are set up. No thunk closure,
 * no late-bound key (sage#58 — the prior `getPublishedEnvelopeId`
 * thunk is now an internal detail of `filterByCorrelation`).
 *
 * sage#40 — the receiver side previously lived in `src/bus/bridge.ts`
 * as a standalone launchd-supervised daemon. That daemon retired
 * when sage moved in-process inside cortex; cortex's
 * `ReviewConsumer` (cortex#237) owns the subscribe loop and invokes
 * sage's `reviewPr` as the injected `pipelineRunner`. This module is
 * the only NATS-aware code in sage and exists for the operator-
 * facing `sage dispatch` CLI command.
 */

import { parsePrRef } from "../forge/parse.ts";
import type { ForgeKind } from "../forge/types.ts";
import { buildSovereignty } from "../identity.ts";
import {
  buildTaskEnvelopeSpec,
  deriveLifecycleSubject,
  deriveVerdictSubject,
} from "../tasks/envelope.ts";
import { resolveStack } from "../util/stack.ts";
import { filterByCorrelation, openBusClient } from "./client.ts";
import {
  SILENCE_WARN_MS,
  buildSilenceWarning,
  interpretDispatch,
  isSafeRecoveryPath,
  type DispatchEvent,
} from "./lifecycle.ts";

export interface DispatchOptions {
  prRef: string;
  natsUrl: string;
  /**
   * `principal` segment of the Subject. CLI flag `--org` stays
   * at the outermost layer for back-compat; this Module's surface
   * uses `org` as the field name to match the existing CLI without
   * adding a rename layer (sage#58 keeps the canonical
   * `principal` name inside the Task Envelope Module).
   */
  org: string;
  source: string;
  credsFile?: string | undefined;
  post: boolean;
  waitSeconds: number;
  timeoutSeconds?: number;
  dataResidency?: string;
  requireNatsAuth?: boolean;
  stack?: string;
  reviewer?: string;
  forge?: ForgeKind;
}

export async function dispatchReview(opts: DispatchOptions): Promise<number> {
  const ref = parsePrRef(opts.prRef, opts.forge);
  const stack = resolveStack(opts.stack);
  const sovereignty = buildSovereignty(
    opts.dataResidency ? { data_residency: opts.dataResidency } : undefined,
  );
  const spec = buildTaskEnvelopeSpec({
    ref,
    principal: opts.org,
    stack,
    post: opts.post,
    ...(opts.timeoutSeconds ? { timeoutSeconds: opts.timeoutSeconds } : {}),
    forge: opts.forge ?? ref.kind ?? "github",
    ...(opts.reviewer !== undefined ? { reviewer: opts.reviewer } : {}),
  });

  const bus = await openBusClient({
    natsUrl: opts.natsUrl,
    ...(opts.credsFile ? { credsFile: opts.credsFile } : {}),
    ...(opts.requireNatsAuth ? { requireAuth: true } : {}),
    log,
  });
  log(`connected ${opts.natsUrl}`);

  // Subscribe BEFORE publish — race-free by program order. The
  // filter thunk reads `publishedId`, which is assigned by the
  // awaited `bus.publish(...)` below; the iterables can't yield
  // an item before that resolution (program order, not thunk
  // cleverness — sage#58).
  const lifecycleRaw = bus.subscribe(deriveLifecycleSubject(opts.org, stack));
  const verdictRaw = bus.subscribe(deriveVerdictSubject(opts.org, stack));

  let publishedId: string | undefined;
  const correlation = (): string | undefined => publishedId;
  const lifecycle = filterByCorrelation(lifecycleRaw, correlation);
  const verdict = filterByCorrelation(verdictRaw, correlation);

  try {
    log(`▶ publishing ${spec.subject}`);
    publishedId = await bus.publish(
      {
        subject: spec.subject,
        type: spec.type,
        payload: spec.payload as Record<string, unknown>,
      },
      sovereignty,
      opts.source,
    );
    log(`▶ published envelope ${publishedId}`);

    for await (const ev of interpretDispatch({
      lifecycle,
      verdict,
      timeouts: { waitMs: opts.waitSeconds * 1000, silenceMs: SILENCE_WARN_MS },
      context: { principal: opts.org, stack },
    })) {
      renderEvent(ev);
      if (ev.kind === "terminated") return ev.exitCode;
    }
    // Interpreter always yields a `terminated` event before returning;
    // this branch is unreachable. Belt-and-braces return code 2.
    return 2;
  } finally {
    await lifecycleRaw.close();
    await verdictRaw.close();
    await bus.close();
  }
}

/**
 * Single side-effecting render site. All stderr wording for the
 * dispatcher lives here — silence-warning copy, recovery-path
 * hint, verdict-decision line. Re-validates `recoveryPath` with
 * `isSafeRecoveryPath` for defense in depth across the Module
 * boundary even though the interpreter already filtered it.
 */
function renderEvent(ev: DispatchEvent): void {
  switch (ev.kind) {
    case "lifecycle": {
      log(`◀ ${ev.subject} ${ev.type}`);
      if (Object.keys(ev.payload).length > 0) {
        log(`  payload: ${JSON.stringify(ev.payload)}`);
      }
      return;
    }
    case "verdict": {
      log(`◀ ${ev.subject} code.pr.review.${ev.decision}`);
      log(`  verdict: ${ev.decision} (posted=${ev.posted})`);
      return;
    }
    case "post-failed": {
      log(`  post-failed: ${ev.error}`);
      if (ev.recoveryPath && isSafeRecoveryPath(ev.recoveryPath)) {
        log(
          `  recover: cat ${ev.recoveryPath} | gh pr review --body-file -  # add --repo OWNER/REPO and PR number`,
        );
      }
      return;
    }
    case "silence-warning": {
      log(
        buildSilenceWarning({
          org: ev.principal,
          stack: ev.stack,
          silenceMs: ev.silenceMs,
        }),
      );
      return;
    }
    case "terminated": {
      if (ev.reason === "timeout") {
        log(`timed out — no completed/failed envelope received`);
      }
      return;
    }
  }
}

const LOG_PREFIX = "[sage:dispatch]";

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.error(`${LOG_PREFIX} ${msg}`);
}
