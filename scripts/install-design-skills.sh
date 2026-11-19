#!/usr/bin/env bash
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

log() {
  printf '%s\n' "install-design-skills: $*" >&2
}

install_one() {
  url="$1"
  name="$2"
  dest=".agents/skills/$name"
  if [ -f "$dest/SKILL.md" ]; then
    return 0
  fi
  if ! npx --yes skills add "$url" --skill "$name" -y; then
    log "no se pudo instalar $name; se continúa"
  fi
}

if ! command -v npx >/dev/null 2>&1; then
  log "npx no disponible; se omiten las skills de diseño"
  exit 0
fi

if ! curl -fsS --connect-timeout 10 --max-time 25 https://github.com/ >/dev/null 2>&1; then
  log "sin red; se omiten las skills de diseño"
  exit 0
fi

install_one "https://github.com/Leonxlnx/taste-skill" "design-taste-frontend"
install_one "https://github.com/Leonxlnx/taste-skill-classics" "high-end-visual-design"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git checkout -- skills-lock.json 2>/dev/null || true
fi

exit 0