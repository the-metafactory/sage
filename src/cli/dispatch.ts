// Thin re-export shim. The bus-domain dispatch logic lives in
// `src/bus/dispatcher.ts`; this file exists so the Commander action wrapper
// in `cli/index.ts` can import a stable `./dispatch` path without depending
// on the bus module layout. Adapter pattern matching `src/cli/index.ts` ←
// `src/lenses/workflow.ts` for `review` and `src/cli/index.ts` ←
// `src/bus/bridge.ts` for `serve`.

export { dispatchReview, type DispatchOptions } from "../bus/dispatcher.ts";
