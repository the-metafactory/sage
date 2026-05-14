export const SUBSTRATE_NAMES = ["pi", "claude", "codex"] as const;
export type SubstrateName = (typeof SUBSTRATE_NAMES)[number];
