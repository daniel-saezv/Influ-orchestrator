#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

log() {
  printf '%s\n' "install-design-skills: $*" >&2
}

skill_ready() {
  [ -f ".agents/skills/$1/SKILL.md" ]
}

install_one() {
  url="$1"
  name="$2"
  dest=".agents/skills/$name"
  if skill_ready "$name"; then
    return 0
  fi
  npx --yes skills add "$url" --skill "$name" --copy -y
  if ! skill_ready "$name"; then
    log "falta $dest/SKILL.md tras instalar $name"
    exit 1
  fi
}

missing=0
for name in design-taste-frontend high-end-visual-design; do
  if ! skill_ready "$name"; then
    missing=1
  fi
done

if [ "$missing" -eq 1 ] && ! command -v npx >/dev/null 2>&1; then
  log "npx no disponible"
  exit 1
fi

install_one "https://github.com/Leonxlnx/taste-skill" "design-taste-frontend"
install_one "https://github.com/Leonxlnx/taste-skill-classics" "high-end-visual-design"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git checkout -- skills-lock.json 2>/dev/null || true
fi
