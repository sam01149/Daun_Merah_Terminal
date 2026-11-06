'use strict';

// Compatibility entry point. Rebuild v2 from cached monthly source snapshots.
// Usage: node scripts/backfill_macro_surprises.js --fetch [--write]
// Always checks 61 monthly windows; see rebuild_macro_foundation.js.
require('./rebuild_macro_foundation').main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
