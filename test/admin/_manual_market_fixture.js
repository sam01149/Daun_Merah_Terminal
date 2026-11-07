'use strict';
// Old isolation/telemetry/contradiction tests intentionally use only ~80 H1 and
// exercise their own guards. Keep price/RR validation real, isolate the new
// strategy-data gate here. manual_analysis_v2.test.js tests that gate unmocked.
function isolateManualMarketEvidence() {
  const manual = require('../../api/_manual_analysis');
  const original = manual.assess;
  manual.assess = (result, context = {}) => original(result, { ...context, evidence: undefined });
  manual.loadInputs = async primary => primary;
}
module.exports = { isolateManualMarketEvidence };
