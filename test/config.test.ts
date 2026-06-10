import { describe, test, expect, afterEach } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolvePrincipalFromConfig,
  resolveDefaultPrincipal,
  cortexConfigPath,
} from "../src/config.ts";

function writeYaml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sage-cfg-"));
  const p = join(dir, "cortex.yaml");
  writeFileSync(p, content);
  return p;
}

describe("resolvePrincipalFromConfig", () => {
  test("reads principal.id from a cortex.yaml", () => {
    const p = writeYaml("principal:\n  id: jc\n  displayName: JC\nstack:\n  id: jc/default\n");
    expect(resolvePrincipalFromConfig(p)).toBe("jc");
  });

  test("missing file → undefined (no throw)", () => {
    expect(resolvePrincipalFromConfig("/no/such/cortex.yaml")).toBeUndefined();
  });

  test("absent principal.id → undefined", () => {
    const p = writeYaml("stack:\n  id: jc/default\n");
    expect(resolvePrincipalFromConfig(p)).toBeUndefined();
  });

  test("empty principal.id → undefined", () => {
    const p = writeYaml("principal:\n  id: ''\n");
    expect(resolvePrincipalFromConfig(p)).toBeUndefined();
  });

  test("malformed YAML → undefined (no throw)", () => {
    const p = writeYaml("principal:\n  id: : : bad\n  - nope\n");
    expect(resolvePrincipalFromConfig(p)).toBeUndefined();
  });
});

describe("resolveDefaultPrincipal precedence", () => {
  const priorOrg = process.env.SAGE_ORG;
  afterEach(() => {
    if (priorOrg === undefined) delete process.env.SAGE_ORG;
    else process.env.SAGE_ORG = priorOrg;
  });

  test("SAGE_ORG env wins over resolved principal", () => {
    process.env.SAGE_ORG = "fromenv";
    expect(resolveDefaultPrincipal(() => "jc")).toBe("fromenv");
  });

  test("resolved principal used when SAGE_ORG unset", () => {
    delete process.env.SAGE_ORG;
    expect(resolveDefaultPrincipal(() => "jc")).toBe("jc");
  });

  test("falls back to metafactory when neither present", () => {
    delete process.env.SAGE_ORG;
    expect(resolveDefaultPrincipal(() => undefined)).toBe("metafactory");
  });
});

describe("cortexConfigPath", () => {
  const prior = process.env.CORTEX_CONFIG;
  afterEach(() => {
    if (prior === undefined) delete process.env.CORTEX_CONFIG;
    else process.env.CORTEX_CONFIG = prior;
  });

  test("honours $CORTEX_CONFIG override", () => {
    process.env.CORTEX_CONFIG = "/custom/cortex.yaml";
    expect(cortexConfigPath()).toBe("/custom/cortex.yaml");
  });

  test("defaults under ~/.config/cortex", () => {
    delete process.env.CORTEX_CONFIG;
    expect(cortexConfigPath()).toMatch(/\.config\/cortex\/cortex\.yaml$/);
  });
});
