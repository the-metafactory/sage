import { describe, test, expect } from "bun:test";
import {
  securityApplies,
  architectureApplies,
  ecosystemComplianceApplies,
  performanceApplies,
  maintainabilityApplies,
  evaluateApplicability,
} from "../src/lenses/applicability.ts";
import type { PrMetadata } from "../src/github/gh.ts";

type FileSpec = { path: string; additions?: number; deletions?: number };

function pr(files: Array<FileSpec>): PrMetadata {
  return {
    number: 1,
    title: "t",
    body: "",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feat",
    author: { login: "x" },
    changedFiles: files.length,
    additions: 0,
    deletions: 0,
    files: files.map((f) => ({
      path: f.path,
      additions: f.additions ?? 1,
      deletions: f.deletions ?? 0,
    })),
    url: "https://github.com/x/y/pull/1",
  };
}

describe("securityApplies", () => {
  test("matches auth path", () => {
    expect(securityApplies({ pr: pr([{ path: "src/auth/login.ts" }]), diff: "" })).toBe(true);
  });

  test("matches .env file", () => {
    expect(securityApplies({ pr: pr([{ path: ".env" }]), diff: "" })).toBe(true);
  });

  test("matches password keyword in diff", () => {
    expect(
      securityApplies({
        pr: pr([{ path: "src/x.ts" }]),
        diff: "+const password = 'x';",
      }),
    ).toBe(true);
  });

  test("matches SELECT in diff", () => {
    expect(
      securityApplies({
        pr: pr([{ path: "src/x.ts" }]),
        diff: "+const q = 'SELECT * FROM users';",
      }),
    ).toBe(true);
  });

  test("ignores benign code-only change", () => {
    expect(
      securityApplies({
        pr: pr([{ path: "README.md" }]),
        diff: "+# Hello world",
      }),
    ).toBe(false);
  });
});

describe("architectureApplies", () => {
  test("new file in diff triggers", () => {
    const diff = `--- /dev/null\n+++ b/src/new.ts\n@@\n+export const x = 1;\n`;
    expect(architectureApplies({ pr: pr([{ path: "src/new.ts" }]), diff })).toBe(true);
  });

  test("schema dir change triggers", () => {
    expect(
      architectureApplies({ pr: pr([{ path: "src/schemas/user.ts" }]), diff: "" }),
    ).toBe(true);
  });

  test("package.json dep change triggers", () => {
    expect(
      architectureApplies({
        pr: pr([{ path: "package.json" }]),
        diff: '+  "dependencies": {\n+    "x": "^1.0.0"\n+  }',
      }),
    ).toBe(true);
  });

  test("non-architectural change does not trigger", () => {
    expect(
      architectureApplies({
        pr: pr([{ path: "README.md" }]),
        diff: "-old line\n+new line",
      }),
    ).toBe(false);
  });
});

describe("ecosystemComplianceApplies", () => {
  test("cortex.yaml change triggers", () => {
    expect(
      ecosystemComplianceApplies({ pr: pr([{ path: "cortex.yaml" }]), diff: "" }),
    ).toBe(true);
  });

  test("arc-manifest.yaml change triggers", () => {
    expect(
      ecosystemComplianceApplies({ pr: pr([{ path: "arc-manifest.yaml" }]), diff: "" }),
    ).toBe(true);
  });

  test("plist change triggers", () => {
    expect(
      ecosystemComplianceApplies({
        pr: pr([{ path: "services/ai.meta-factory.sage.plist" }]),
        diff: "",
      }),
    ).toBe(true);
  });

  test("CLAUDE.md change triggers", () => {
    expect(
      ecosystemComplianceApplies({ pr: pr([{ path: "CLAUDE.md" }]), diff: "" }),
    ).toBe(true);
  });

  test("plain source change does not trigger", () => {
    expect(
      ecosystemComplianceApplies({ pr: pr([{ path: "src/x.ts" }]), diff: "" }),
    ).toBe(false);
  });
});

describe("performanceApplies", () => {
  test("await in for-loop triggers", () => {
    const diff = "+for (const x of xs) {\n+  await fetch(x);\n+}";
    expect(performanceApplies({ pr: pr([{ path: "src/x.ts" }]), diff })).toBe(true);
  });

  test("SELECT * triggers", () => {
    expect(
      performanceApplies({
        pr: pr([{ path: "src/x.ts" }]),
        diff: "+const q = `SELECT * FROM users`;",
      }),
    ).toBe(true);
  });

  test("setInterval triggers", () => {
    expect(
      performanceApplies({
        pr: pr([{ path: "src/x.ts" }]),
        diff: "+setInterval(() => x(), 1000);",
      }),
    ).toBe(true);
  });

  test("sync I/O triggers", () => {
    expect(
      performanceApplies({
        pr: pr([{ path: "src/x.ts" }]),
        diff: "+const data = readFileSync('/etc/passwd');",
      }),
    ).toBe(true);
  });

  test("benign code does not trigger", () => {
    expect(
      performanceApplies({
        pr: pr([{ path: "src/x.ts" }]),
        diff: "+const x = 1;",
      }),
    ).toBe(false);
  });
});

describe("maintainabilityApplies", () => {
  test("fires on substantial .ts change (≥20 lines, one file)", () => {
    expect(
      maintainabilityApplies({
        pr: pr([{ path: "src/big.ts", additions: 80, deletions: 5 }]),
        diff: "",
      }),
    ).toBe(true);
  });

  test("fires on .py source change", () => {
    expect(
      maintainabilityApplies({
        pr: pr([{ path: "tool/script.py", additions: 50, deletions: 0 }]),
        diff: "",
      }),
    ).toBe(true);
  });

  test("fires on multiple smaller in-scope files summing past threshold", () => {
    expect(
      maintainabilityApplies({
        pr: pr([
          { path: "src/a.ts", additions: 8, deletions: 2 },
          { path: "src/b.ts", additions: 7, deletions: 3 },
          { path: "src/c.ts", additions: 5, deletions: 0 },
        ]),
        diff: "",
      }),
    ).toBe(true);
  });

  test("skips trivial change (5 added lines, well under threshold)", () => {
    expect(
      maintainabilityApplies({
        pr: pr([{ path: "src/tiny.ts", additions: 5, deletions: 0 }]),
        diff: "",
      }),
    ).toBe(false);
  });

  test("skips docs-only PR (no code-extension files)", () => {
    expect(
      maintainabilityApplies({
        pr: pr([
          { path: "README.md", additions: 200, deletions: 50 },
          { path: "docs/design.md", additions: 100, deletions: 0 },
        ]),
        diff: "",
      }),
    ).toBe(false);
  });

  test("skips lock-file-only churn", () => {
    expect(
      maintainabilityApplies({
        pr: pr([{ path: "bun.lock", additions: 500, deletions: 200 }]),
        diff: "",
      }),
    ).toBe(false);
  });

  test("skips generated / vendored paths even with code extensions", () => {
    expect(
      maintainabilityApplies({
        pr: pr([
          { path: "node_modules/foo/index.ts", additions: 100, deletions: 0 },
          { path: "dist/bundle.js", additions: 5000, deletions: 0 },
          { path: "vendor/lib.ts", additions: 100, deletions: 0 },
        ]),
        diff: "",
      }),
    ).toBe(false);
  });

  test("skips .d.ts ambient declarations (mechanical, not maintained)", () => {
    expect(
      maintainabilityApplies({
        pr: pr([{ path: "types/api.d.ts", additions: 200, deletions: 0 }]),
        diff: "",
      }),
    ).toBe(false);
  });

  test("mixed in/out-of-scope: only in-scope lines count toward threshold", () => {
    // In-scope total: 10 lines (under 20) — should NOT fire even with
    // a giant docs change alongside.
    expect(
      maintainabilityApplies({
        pr: pr([
          { path: "src/x.ts", additions: 8, deletions: 2 },
          { path: "README.md", additions: 1000, deletions: 0 },
        ]),
        diff: "",
      }),
    ).toBe(false);
  });

  test("threshold edge: exactly 20 lines fires", () => {
    expect(
      maintainabilityApplies({
        pr: pr([{ path: "src/edge.ts", additions: 15, deletions: 5 }]),
        diff: "",
      }),
    ).toBe(true);
  });

  test("threshold edge: 19 lines does not fire", () => {
    expect(
      maintainabilityApplies({
        pr: pr([{ path: "src/edge.ts", additions: 14, deletions: 5 }]),
        diff: "",
      }),
    ).toBe(false);
  });
});

describe("evaluateApplicability", () => {
  test("aggregates all five predicates", () => {
    const result = evaluateApplicability({
      pr: pr([{ path: "src/auth/login.ts" }]),
      diff: "",
    });
    expect(result.security).toBe(true);
    expect(result.architecture).toBe(false);
    expect(result.ecosystemCompliance).toBe(false);
    expect(result.performance).toBe(false);
    expect(result.maintainability).toBe(false); // only 1 line under default helper
  });

  test("maintainability fires on substantial code PR", () => {
    const result = evaluateApplicability({
      pr: pr([{ path: "src/feat.ts", additions: 100, deletions: 20 }]),
      diff: "",
    });
    expect(result.maintainability).toBe(true);
  });
});
