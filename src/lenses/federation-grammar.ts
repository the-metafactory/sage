import { runLens, type LensRunInput } from "./base.ts";
import type { LensReport } from "./types.ts";

/**
 * FederationGrammar — ports compass's sops/federation-wire-protocol.md
 * checklist (checks 1-5) into a sage lens. That SOP is the single
 * checklist for cross-principal (`federated.*`) NATS bus traffic; getting
 * it wrong has shipped real incidents (cortex#661, pilot#149-as-written,
 * cortex#686/#715). There is no skill file for this — the SOP itself is
 * the authoritative source; this lens is the sage-side enforcement point
 * for standalone `sage review`, not a port of some other lens spec.
 *
 * Scope: fires only on diffs that touch federated.* wire code (see
 * `federationGrammarApplies` in applicability.ts). Ordinary application
 * logic, local.* bus code, and non-federated changes get nothing from
 * this lens.
 */
const FOCUS = `Look at this PR through the FederationGrammar lens — the load-bearing rules
for cross-principal (federated.*) NATS bus traffic, per compass's
sops/federation-wire-protocol.md. You care ONLY about code that emits,
routes, consumes, or validates a federated.* envelope: deriveNatsSubject,
selectLink, source, originator, peers[] routing, and the review-consumer /
dispatch paths. If the diff does not touch this wire code, you have nothing
to say — do not comment on ordinary application logic or non-federated bus
code.

Check the diff against these five rules. Every finding must quote the
offending line; if you cannot quote it, do not raise it.

1. NO NETWORK ON THE WIRE. No network_id (or equivalent topology value) may
   appear in a subject, in \`source\`, or in \`extensions\` used for routing.
   The network is a topology fact resolved from
   policy.federated.networks[].peers[] — never a value the wire carries.
   selectLink resolves the target leaf from the target principal (subject
   segment[1]) via peers[].

2. THE SUBJECT ADDRESSES THE TARGET. Cross-principal subjects follow
   federated.{target-principal}.{target-stack}.tasks.{capability} (Offer) or
   ...tasks.@{did-encoded-assistant}.{capability} (Direct). deriveNatsSubject
   builds {principal}.{stack} from source's first segments, so to reach a
   target, source must address the TARGET
   ({target-principal}.{target-stack}.{sender-assistant}) — never the
   sender. The receiver subscribes to its OWN
   federated.{me}.{my-stack}.... scope.

3. THE REQUESTER RIDES IN originator.identity. Encoded as the canonical
   principal DID did:mf:{principal}-{stack} (= stack.id with "/" replaced by
   "-"; decode = strip "did:mf:", split on the FIRST hyphen — principals
   carry no hyphen, stacks may). It is NEVER a slash form. The requester
   must never be parsed from the subject or from \`source\` — those address
   the target, not the requester.

4. THE REPLY/VERDICT IS KEYED ON THE REQUESTER. Derived from
   originator.identity, published to
   federated.{requester-principal}.{requester-stack}.review.verdict.* (or
   dispatch.task.*) — never to self, never derived from the subject segment.
   The code must FAIL CLOSED (drop, no spawn, no publish) when originator is
   absent or malformed, or when the requester is not a configured peers[]
   member. A reply/verdict path that proceeds anyway on a missing or
   unverified originator is a blocker.

5. SCOPE IS CORRECT AND SELF-CONSISTENT. local.* never crosses the principal
   boundary; federated.* always does (federation is the default for
   multi-principal collaboration — a shared platform channel does not make
   cross-principal traffic local). Lifecycle/verdict envelopes must mirror
   the inbound scope and carry a consistent classification (e.g. a
   federated envelope left with classification undefined, or a local
   envelope stamped federated, is a self-consistency violation).

Severity: a violation of rules 1-4 is a blocker — it is wire-protocol-
incorrect and will misroute, spoof, or silently drop cross-principal
traffic, or let an unauthenticated/unattributable requester through. A
rule-5 self-consistency slip (missing/undefined classification, scope
mismatch) that does not itself misroute is important. Do not flag code
that already fails closed correctly, defensive checks that already
enforce these rules, or non-federated bus code — this lens is scoped to
federated.* wire code only.

If CONTEXT.md or CONTEXT-MAP.md context is present on stdin, use it only
for §Network / §Dispatch terminology grounding (e.g. distinguishing
"stack" from "principal"). The five numbered checks above are the
authoritative contract — they come from compass's ADR-0001 (subject
grammar) and ADR-0002 (dispatch addressing + verdict-back), not any
per-repo doc.`;

export async function reviewFederationGrammar(input: LensRunInput): Promise<LensReport> {
  return runLens(
    { name: "FederationGrammar", focus: FOCUS },
    { ...input, acceptsArchitectureDocs: true },
  );
}
