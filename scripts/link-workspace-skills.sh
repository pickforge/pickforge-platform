#!/usr/bin/env bash
# Symlink this repo's skills/ into the workspace root and every sibling repo,
# so agents discover them no matter where the session starts. Skill discovery
# does not traverse parent directories, so each repo needs its own link.
# Links are kept out of git via .git/info/exclude. Idempotent; rerun anytime.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workspace="$(cd "$repo_dir/.." && pwd)"

link_into() {
  local target="$1" name="$2"
  for root in "$target/.claude/skills" "$target/.agents/skills"; do
    local link="$root/$name"
    if [[ -e "$link" && ! -L "$link" ]]; then
      echo "skip: $link exists and is not a symlink" >&2
      continue
    fi
    mkdir -p "$root"
    ln -sfn "$repo_dir/skills/$name" "$link"
    echo "linked $link"
  done
  if [[ -d "$target/.git" ]]; then
    local exclude="$target/.git/info/exclude"
    for pattern in ".claude/skills/$name" ".agents/skills/$name"; do
      grep -qxF "$pattern" "$exclude" 2>/dev/null || echo "$pattern" >> "$exclude"
    done
  fi
}

for skill_dir in "$repo_dir"/skills/*/; do
  name="$(basename "$skill_dir")"
  link_into "$workspace" "$name"
  for sibling in "$workspace"/*/; do
    sibling="${sibling%/}"
    [[ "$sibling" == "$repo_dir" ]] && continue
    [[ -e "$sibling/.git" ]] || continue
    link_into "$sibling" "$name"
  done
done
