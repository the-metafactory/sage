import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "yaml";

/**
 * sage#40 cycle-1 finding #4 — keep `runtime.capabilities` in
 * `arc-manifest.yaml` and the persona frontmatter in `sage.md` in
 * lockstep. Both surfaces are operator-facing (arc renders the manifest
 * into cortex's agents.d/, and humans read sage.md). A drift between
 * them would mean cortex's capability catalog claims one set of flavors
 * while the persona advertises another — and the catalog cross-validator
 * (IAW Phase A.6) would either reject the install or silently route
 * traffic to whichever happened to win.
 *
 * Tested as a unit test rather than a generation step so the failure
 * mode at PR time is a red test (caught in CI), not a silent regeneration
 * that hides the drift author intent.
 */

const REPO_ROOT = (() => {
  // test/manifest-capability-parity.test.ts → ../
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..");
})();

function readManifestCapabilities(): string[] {
  const raw = readFileSync(join(REPO_ROOT, "arc-manifest.yaml"), "utf8");
  const doc = yaml.parse(raw) as { runtime?: { capabilities?: unknown } };
  const caps = doc.runtime?.capabilities;
  if (!Array.isArray(caps)) {
    throw new Error("arc-manifest.yaml has no runtime.capabilities array");
  }
  return caps.map((c) => String(c));
}

function readPersonaCapabilities(): string[] {
  const raw = readFileSync(join(REPO_ROOT, "sage.md"), "utf8");
  // Persona file is a YAML frontmatter block (delimited by `---` lines)
  // followed by markdown. Slice the frontmatter, parse with the same
  // yaml lib so the parity test cannot be defeated by inconsistent
  // parsers (e.g. one that's whitespace-tolerant and one that's not).
  const match = /^---\n([\s\S]*?)\n---/m.exec(raw);
  if (!match) {
    throw new Error("sage.md has no YAML frontmatter block");
  }
  const fm = yaml.parse(match[1] ?? "") as { runtime?: { capabilities?: unknown } };
  const caps = fm.runtime?.capabilities;
  if (!Array.isArray(caps)) {
    throw new Error("sage.md frontmatter has no runtime.capabilities array");
  }
  return caps.map((c) => String(c));
}

describe("runtime.capabilities parity", () => {
  test("arc-manifest.yaml and sage.md advertise the same capability list", () => {
    const manifestCaps = readManifestCapabilities();
    const personaCaps = readPersonaCapabilities();

    // Order-sensitive equality on purpose. The two lists are short and
    // hand-maintained; preserving order makes diff review easier than a
    // set-equality compare that hides reordering.
    expect(personaCaps).toEqual(manifestCaps);
  });

  test("manifest capabilities are all in the canonical code-review.<flavor> shape", () => {
    // Belt-and-suspenders: if the parity test passes but somebody adds
    // a bare `code-review` (pre-sage#40 shape) to both files in lockstep,
    // surface that as its own failure. KNOWN_SPECIALIZATIONS in pilot is
    // the canonical authority for the flavor set; we don't enforce the
    // exact roster here (pilot can grow flavors without sage needing a
    // PR), only the shape.
    const manifestCaps = readManifestCapabilities();
    for (const cap of manifestCaps) {
      expect(cap).toMatch(/^code-review\.[a-z]+$/);
    }
  });
});
