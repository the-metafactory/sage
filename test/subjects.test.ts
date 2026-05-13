import { describe, test, expect } from "bun:test";
import {
  broadcastSubject,
  directSubject,
  dispatchSubject,
  postFailedSubject,
  verdictSubject,
  taskSubject,
  dispatchLifecycleWildcard,
  verdictWildcard,
} from "../src/bus/subjects.ts";

const cfg = { org: "metafactory", did: "did:mf:sage" } as const;

describe("subscribe-side wildcards", () => {
  test("broadcastSubject", () => {
    expect(broadcastSubject(cfg)).toBe("local.metafactory.tasks.code-review.>");
  });

  test("directSubject encodes DID", () => {
    expect(directSubject(cfg)).toBe("local.metafactory.tasks.@did-mf-sage.>");
  });

  test("directSubject with dotted DID", () => {
    expect(directSubject({ ...cfg, did: "did:mf:hub.metafactory" })).toBe(
      "local.metafactory.tasks.@did-mf-hub--metafactory.>",
    );
  });

  test("dispatchLifecycleWildcard", () => {
    expect(dispatchLifecycleWildcard({ org: "metafactory" })).toBe(
      "local.metafactory.dispatch.task.>",
    );
  });

  test("verdictWildcard", () => {
    expect(verdictWildcard({ org: "metafactory" })).toBe(
      "local.metafactory.code.pr.review.>",
    );
  });
});

describe("publish-side concrete subjects", () => {
  test("taskSubject builds capability-suffixed task subject", () => {
    expect(taskSubject({ org: "metafactory" }, "code-review.typescript")).toBe(
      "local.metafactory.tasks.code-review.typescript",
    );
  });

  test("dispatchSubject for each phase", () => {
    for (const phase of ["started", "progress", "completed", "failed"] as const) {
      expect(dispatchSubject({ org: "metafactory" }, phase)).toBe(
        `local.metafactory.dispatch.task.${phase}`,
      );
    }
  });

  test("verdictSubject for each decision", () => {
    for (const decision of ["approved", "changes-requested", "commented"] as const) {
      expect(verdictSubject({ org: "metafactory" }, decision)).toBe(
        `local.metafactory.code.pr.review.${decision}`,
      );
    }
  });

  // Post-failed sits under the same `code.pr.review.>` root as the three
  // verdict outcomes (sage#16) so a `verdictWildcard` subscriber receives
  // it without a separate subscription.
  test("postFailedSubject lives under verdict root", () => {
    expect(postFailedSubject({ org: "metafactory" })).toBe(
      "local.metafactory.code.pr.review.post-failed",
    );
    expect(postFailedSubject({ org: "metafactory" }).startsWith(
      verdictWildcard({ org: "metafactory" }).replace(".>", "."),
    )).toBe(true);
  });
});
