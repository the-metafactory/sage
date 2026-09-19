import { expect, test } from "bun:test";

import { findGlossaryViolations, parseGlossary } from "../src/lenses/glossary.ts";

test("external TypeSafe contract vocabulary is outside Sage's glossary boundary", () => {
  const entries = parseGlossary(`
**Verdict**: review decision
_Avoid_: status

**Substrate**: coding harness
_Avoid_: model

**Prompt**: substrate input
_Avoid_: request
`);
  const diff = `diff --git a/src/typesafe/transport.ts b/src/typesafe/transport.ts
--- a/src/typesafe/transport.ts
+++ b/src/typesafe/transport.ts
@@ -1,1 +1,2 @@
 const endpoint = "/api/v1/system-one/run";
+const request = { model: "jev-1.13.0", status: "ready" };
`;

  expect(findGlossaryViolations(entries, diff)).toEqual([]);
});
