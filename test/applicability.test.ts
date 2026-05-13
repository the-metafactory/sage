import { describe, test, expect } from "bun:test";
import {
  securityApplies,
  architectureApplies,
  ecosystemComplianceApplies,
  performanceApplies,
  evaluateApplicability,
} from "../src/lenses/applicability.ts";
import type { PrMetadata } from "../src/github/gh.ts";

function pr(files: Array<Pick<PrMetadata["files"][number], "path">>): PrMetadata {
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
    files: files.map((f) => ({ path: f.path, additions: 1, deletions: 0 })),
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

describe("evaluateApplicability", () => {
  test("aggregates all four predicates", () => {
    const result = evaluateApplicability({
      pr: pr([{ path: "src/auth/login.ts" }]),
      diff: "",
    });
    expect(result.security).toBe(true);
    expect(result.architecture).toBe(false);
    expect(result.ecosystemCompliance).toBe(false);
    expect(result.performance).toBe(false);
  });
});
