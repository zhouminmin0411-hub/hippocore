#!/usr/bin/env bash
set -euo pipefail

SOURCE_WORKSPACE="${SOURCE_WORKSPACE:-/root/clawd-agent2/hippocore-upstream}"
TARGET_RUNTIME="${TARGET_RUNTIME:-/root/clawd-agent2}"
OPENCLAW_HOME="${OPENCLAW_HOME:-/root/.openclaw}"
BACKUP_ROOT="${BACKUP_ROOT:-/root/openclaw-upgrade-backups}"
SERVICE_NAME="${SERVICE_NAME:-openclaw-gateway.service}"
SYSTEMCTL_PREFIX="${SYSTEMCTL_PREFIX:-XDG_RUNTIME_DIR=/run/user/0 systemctl --user}"
SOURCE_REPO_DEFAULT="${SOURCE_REPO_DEFAULT:-https://github.com/zhouminmin0411-hub/hippocore.git}"
TARGET_COMMIT="${TARGET_COMMIT:-}"

PUBLISHED_PATHS=(
  "bin"
  "src"
  "scripts"
  "hooks"
  "openclaw.plugin.js"
  "openclaw.plugin.json"
  "package.json"
  "package-lock.json"
  "README.md"
  "PRD.md"
  "PRD.zh-CN.md"
  "index.js"
)

PRESERVED_RUNTIME_DIRS=(
  "scripts"
)

json_escape() {
  python3 - <<'PY' "$1"
import json,sys
print(json.dumps(sys.argv[1]))
PY
}

usage() {
  cat <<'USAGE'
Usage:
  deploy_runtime_overlay.sh [--commit SHA] [--source-workspace DIR] [--target-runtime DIR]
                            [--openclaw-home DIR] [--backup-root DIR] [--service-name NAME]
                            [--systemctl-prefix CMD]

Defaults:
  --source-workspace /root/clawd-agent2/hippocore-upstream
  --target-runtime   /root/clawd-agent2
  --openclaw-home    /root/.openclaw
  --backup-root      /root/openclaw-upgrade-backups
  --service-name     openclaw-gateway.service

Behavior:
  - aligns source workspace to target commit (or current HEAD if omitted)
  - backs up only code/runtime metadata that will be touched
  - overlays whitelisted code paths into runtime directory
  - writes .release-meta.json
  - reruns hippocore setup to refresh runtime wiring
  - restarts gateway and verifies /healthz
USAGE
}

run_systemctl() {
  local args=("$@")
  local rendered=""
  local arg
  for arg in "${args[@]}"; do
    rendered+=" $(printf '%q' "$arg")"
  done
  bash -lc "$SYSTEMCTL_PREFIX$rendered"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit) TARGET_COMMIT="$2"; shift 2 ;;
    --source-workspace) SOURCE_WORKSPACE="$2"; shift 2 ;;
    --target-runtime) TARGET_RUNTIME="$2"; shift 2 ;;
    --openclaw-home) OPENCLAW_HOME="$2"; shift 2 ;;
    --backup-root) BACKUP_ROOT="$2"; shift 2 ;;
    --service-name) SERVICE_NAME="$2"; shift 2 ;;
    --systemctl-prefix) SYSTEMCTL_PREFIX="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ ! -d "$SOURCE_WORKSPACE/.git" ]]; then
  echo "[error] source workspace is not a git repo: $SOURCE_WORKSPACE" >&2
  exit 1
fi

if [[ ! -d "$TARGET_RUNTIME" ]]; then
  echo "[error] target runtime missing: $TARGET_RUNTIME" >&2
  exit 1
fi

if [[ ! -d "$OPENCLAW_HOME" ]]; then
  echo "[error] openclaw home missing: $OPENCLAW_HOME" >&2
  exit 1
fi

mkdir -p "$BACKUP_ROOT"
STAMP="$(date '+%Y%m%d-%H%M%S')"
BACKUP_DIR="$BACKUP_ROOT/$STAMP-runtime-overlay"
mkdir -p "$BACKUP_DIR/runtime-code" "$BACKUP_DIR/openclaw-runtime" "$BACKUP_DIR/preserved-runtime"

echo "[step] aligning source workspace"
git -C "$SOURCE_WORKSPACE" fetch origin
if [[ -n "$TARGET_COMMIT" ]]; then
  git -C "$SOURCE_WORKSPACE" reset --hard "$TARGET_COMMIT"
else
  TARGET_COMMIT="$(git -C "$SOURCE_WORKSPACE" rev-parse HEAD)"
fi
git -C "$SOURCE_WORKSPACE" clean -fd

ACTUAL_COMMIT="$(git -C "$SOURCE_WORKSPACE" rev-parse HEAD)"
ACTUAL_BRANCH="$(git -C "$SOURCE_WORKSPACE" rev-parse --abbrev-ref HEAD)"
SOURCE_REPO="$(git -C "$SOURCE_WORKSPACE" remote get-url origin 2>/dev/null || true)"
if [[ -z "$SOURCE_REPO" ]]; then
  SOURCE_REPO="$SOURCE_REPO_DEFAULT"
fi

echo "[step] backing up touched files to $BACKUP_DIR"
for entry in "${PUBLISHED_PATHS[@]}"; do
  if [[ -e "$TARGET_RUNTIME/$entry" ]]; then
    mkdir -p "$BACKUP_DIR/runtime-code/$(dirname "$entry")"
    cp -a "$TARGET_RUNTIME/$entry" "$BACKUP_DIR/runtime-code/$entry"
  fi
done

for entry in "${PRESERVED_RUNTIME_DIRS[@]}"; do
  src_dir="$SOURCE_WORKSPACE/$entry"
  dst_dir="$TARGET_RUNTIME/$entry"
  preserve_dir="$BACKUP_DIR/preserved-runtime/$entry"
  if [[ -d "$src_dir" && -d "$dst_dir" ]]; then
    mkdir -p "$preserve_dir"
    while IFS= read -r runtime_file; do
      rel="${runtime_file#$dst_dir/}"
      if [[ ! -e "$src_dir/$rel" ]]; then
        mkdir -p "$preserve_dir/$(dirname "$rel")"
        cp -a "$runtime_file" "$preserve_dir/$rel"
      fi
    done < <(find "$dst_dir" -type f)
  fi
done

for extra in \
  "$TARGET_RUNTIME/.release-meta.json" \
  "$OPENCLAW_HOME/hippocore/openclaw.plugin.json" \
  "$OPENCLAW_HOME/hippocore/install.json"
do
  if [[ -e "$extra" ]]; then
    cp -a "$extra" "$BACKUP_DIR/openclaw-runtime/"
  fi
done

run_systemctl status "$SERVICE_NAME" --no-pager --full >"$BACKUP_DIR/service-status.before.txt" 2>&1 || true
journalctl --user -u "$SERVICE_NAME" -n 200 --no-pager >"$BACKUP_DIR/journal.before.log" 2>&1 || true

echo "[step] publishing overlay into runtime directory"
for entry in "${PUBLISHED_PATHS[@]}"; do
  src="$SOURCE_WORKSPACE/$entry"
  dst="$TARGET_RUNTIME/$entry"
  if [[ -d "$src" ]]; then
    mkdir -p "$dst"
    rsync -a --delete "$src/" "$dst/"
  elif [[ -f "$src" ]]; then
    mkdir -p "$(dirname "$dst")"
    install -m 0644 "$src" "$dst"
    if [[ "$entry" == "bin/"* || "$entry" == "scripts/"* ]]; then
      chmod 0755 "$dst" || true
    fi
  else
    echo "[error] published path missing in source workspace: $entry" >&2
    exit 1
  fi
done

for entry in "${PRESERVED_RUNTIME_DIRS[@]}"; do
  preserve_dir="$BACKUP_DIR/preserved-runtime/$entry"
  dst_dir="$TARGET_RUNTIME/$entry"
  if [[ -d "$preserve_dir" ]]; then
    while IFS= read -r preserved_file; do
      rel="${preserved_file#$preserve_dir/}"
      mkdir -p "$dst_dir/$(dirname "$rel")"
      cp -a "$preserved_file" "$dst_dir/$rel"
    done < <(find "$preserve_dir" -type f)
  fi
done

DEPLOYED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
published_files_json="$(
  python3 - <<'PY' "${PUBLISHED_PATHS[@]}"
import json,sys
print(json.dumps(sys.argv[1:]))
PY
)"
preserved_runtime_files_json="$(
  python3 - <<'PY' "$BACKUP_DIR/preserved-runtime"
import json, os, sys
base = sys.argv[1]
items = []
if os.path.isdir(base):
    for root, _, files in os.walk(base):
        for name in files:
            items.append(os.path.relpath(os.path.join(root, name), base))
print(json.dumps(sorted(items)))
PY
)"
deployed_at_json="$(json_escape "$DEPLOYED_AT")"
commit_json="$(json_escape "$ACTUAL_COMMIT")"
branch_json="$(json_escape "$ACTUAL_BRANCH")"
source_repo_json="$(json_escape "$SOURCE_REPO")"
source_workspace_json="$(json_escape "$SOURCE_WORKSPACE")"
target_runtime_json="$(json_escape "$TARGET_RUNTIME")"

cat >"$TARGET_RUNTIME/.release-meta.json" <<EOF
{
  "deployedAt": $deployed_at_json,
  "gitCommit": $commit_json,
  "gitBranch": $branch_json,
  "sourceRepo": $source_repo_json,
  "sourceWorkspace": $source_workspace_json,
  "targetRuntime": $target_runtime_json,
  "deployMode": "publish-overlay",
  "publishedFiles": $published_files_json,
  "preservedRuntimeFiles": $preserved_runtime_files_json
}
EOF

echo "[step] refreshing OpenClaw runtime metadata"
node "$TARGET_RUNTIME/bin/hippocore.js" setup \
  --project-root "$TARGET_RUNTIME" \
  --openclaw-home "$OPENCLAW_HOME" \
  --mode cloud \
  --storage local \
  --no-sync \
  >"$BACKUP_DIR/setup.after.json" 2>&1 || true

echo "[step] restarting gateway"
run_systemctl restart "$SERVICE_NAME"
sleep 8

echo "[step] collecting post-deploy verification"
node "$TARGET_RUNTIME/bin/hippocore.js" openclaw-runtime \
  --project-root "$TARGET_RUNTIME" \
  --openclaw-home "$OPENCLAW_HOME" \
  >"$BACKUP_DIR/openclaw-runtime.after.json"
curl -sS http://127.0.0.1:18789/healthz >"$BACKUP_DIR/healthz.after.json"
run_systemctl status "$SERVICE_NAME" --no-pager --full >"$BACKUP_DIR/service-status.after.txt" 2>&1 || true
journalctl --user -u "$SERVICE_NAME" -n 200 --no-pager >"$BACKUP_DIR/journal.after.log" 2>&1 || true

if ! grep -q '"ok":true' "$BACKUP_DIR/healthz.after.json"; then
  echo "[error] health check failed. Backup at: $BACKUP_DIR" >&2
  echo "[hint] rollback by restoring $BACKUP_DIR/runtime-code into $TARGET_RUNTIME and the runtime files in $BACKUP_DIR/openclaw-runtime" >&2
  exit 1
fi

if grep -q 'unknown typed hook' "$BACKUP_DIR/journal.after.log"; then
  echo "[error] typed hook warning detected after deploy. Backup at: $BACKUP_DIR" >&2
  exit 1
fi

echo "[done] deploy succeeded"
echo "commit: $ACTUAL_COMMIT"
echo "backup: $BACKUP_DIR"
echo "release-meta: $TARGET_RUNTIME/.release-meta.json"
