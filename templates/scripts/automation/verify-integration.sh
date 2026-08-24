#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

task_id="${1:-}"
base="${2:-}"
head="${3:-}"
[[ "$#" -eq 3 ]] || { printf 'Usage: %s TASK-ID BASE-COMMIT HEAD-COMMIT\n' "$0" >&2; exit 2; }
automation_validate_task_id "$task_id"
[[ "$(automation_read_state "$task_id")" == "INTEGRATING" ]] || automation_die "$task_id is not INTEGRATING"
contract="$(automation_contract_path "$task_id")"

"$SCRIPT_DIR/integration-scope-gate.sh" "$task_id" "$base" "$head"

while IFS= read -r filter; do
    automation_info "running integration focused test: $filter"
    ./gradlew testDebugUnitTest --tests "$filter"
done < <(jq -r '.targetTests[]' "$contract")

automation_info "running integration full unit tests"
./gradlew testDebugUnitTest

automation_info "building integration debug APK"
./gradlew assembleDebug

automation_info "running integration Android lint"
./gradlew lint

if [[ "$(jq -r '.deviceTestsRequired' "$contract")" == "true" ]]; then
    automation_info "running integration connected device tests"
    ./gradlew connectedDebugAndroidTest
fi

automation_info "integration candidate passed all deterministic verification"
