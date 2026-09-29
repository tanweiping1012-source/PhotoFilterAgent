#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
[[ "$(uname -s)" == Darwin ]] || { echo 'Requires macOS 14+.' >&2; exit 1; }
PROFILE="${DSH_PROFILE:-web}"
# Exact runtime: do not clone a moving default branch and call it a pinned release.
DSH_VERSION=0.2.0-rc.2
if [[ ! -f "${DSH_HOME:-$HOME/.dsh}/profiles/$PROFILE/package.json" ]]; then
  if [[ "$PROFILE" == web ]]; then
    npx --yes "@deepseek-ai/dsh@${DSH_VERSION}" --profile web --dump-config >/dev/null
  else
    npx --yes "@deepseek-ai/dsh@${DSH_VERSION}" --profile "$PROFILE" --from-default-profile web --dump-config >/dev/null
  fi
fi
npm ci
OUT="$(mktemp -d "${TMPDIR:-/tmp}/photofilter-package.XXXXXX")"
npm pack --pack-destination "$OUT"
npx --yes "@deepseek-ai/dsh@${DSH_VERSION}" plugin --profile "$PROFILE" add "$OUT/photo-filter-agent-dsh-photo-filter-v4-0.4.0-rc.1.tgz"
node lib/setup.js --install-deps --python "${PHOTOFILTER_PYTHON:-python3}"
echo "Bundle installed. Model downloads: node lib/setup.js --download-models"
echo "Authorize folders: node lib/setup.js --profile $PROFILE --photos /path/to/photos --exports /path/to/export"
echo 'Then select PhotoFilter in a new DSH chat. Visual review is OFF.'
