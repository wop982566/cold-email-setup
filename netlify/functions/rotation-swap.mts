// ---------------------------------------------------------------------------
// The daily rotation schedule. Nothing else.
//
// A Netlify scheduled function is NOT reachable over HTTP — its URL answers an
// empty 404 — so the manual dry-run / rotate-now / test-email paths live in
// rotation-swap-test.mts (an ordinary HTTP function). Both call runRotation().
//
// It runs @daily and rotates only the campaigns whose 15-day interval has
// elapsed (per-campaign state), so the effective cadence is 15 days even though
// the cron fires every day. Scheduled functions fire only on the PRODUCTION
// deploy; the UI's "Rotate now" button drives it on demand meanwhile.
// ---------------------------------------------------------------------------
import { runRotation } from "./_rotationRun.js";

export default async (): Promise<Response> => runRotation();

// Typed structurally (Config isn't a dependency here); Netlify reads this shape.
export const config = {
  schedule: "@daily",
};
