// ---------------------------------------------------------------------------
// The daily schedule. Nothing else.
//
// A Netlify scheduled function is NOT reachable over HTTP — its URL answers an
// empty 404. The manual dry-run and test-email paths used to live here, which
// is why they failed with "Unexpected end of JSON input": the browser was
// parsing an empty 404 body. They now live in auto-swap-test.mts, an ordinary
// HTTP function, and both entry points call the same runAutoSwap().
// ---------------------------------------------------------------------------
import { runAutoSwap } from "./_autoSwapRun.js";

export default async (): Promise<Response> => runAutoSwap();

// Typed structurally rather than importing Config from @netlify/functions,
// which isn't a dependency here. Netlify reads this shape directly.
export const config = {
  // Daily. Deliverability metrics are daily-bucketed at source, so a tighter
  // schedule would re-read the same numbers and act on noise.
  schedule: "@daily",
};
