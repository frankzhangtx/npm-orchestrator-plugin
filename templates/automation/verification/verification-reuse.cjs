"use strict";
// A commit can affect versioning and external Gradle plugins even if source
// bytes are identical. Reuse only the exact HEAD and candidate binding.
function sameCandidate(previous, current) {
  return JSON.stringify(previous) === JSON.stringify(current);
}
module.exports = { sameCandidate };
