---
name: pickforge-ui
description: Direct significant Pickforge UI and UX work using the canonical Pickforge brand, app-local design system, and the general design-director workflow. Use in any Pickforge workspace repo when creating or materially changing an app, site, screen, feature flow, component, responsive layout, interaction, animation, or visual design; when auditing an existing Pickforge surface; or when translating visual references into Pickforge. Not for pure backend work or tiny fixes already dictated by local components and tokens.
---

# Pickforge UI

Apply Pickforge constraints as a thin overlay on `design-director`. Do not create a second prompt contract or a separate aesthetic process.

## Start

1. Invoke or read `design-director` and choose its light or directed path.
2. Read the target repo's `AGENTS.md`, `CLAUDE.md` when applicable, and the current surface before proposing changes.
3. Load the relevant sources from [pickforge-context.md](references/pickforge-context.md). Local files are canonical.
4. For directed work, prefill the shared `design-director/references/prompt-contract.md` with the Pickforge constraints below. The task's named design lead still owns the aesthetic decisions and final screenshot acceptance.

If `design-director` is not installed, report the missing shared dependency and use this overlay only for immediate context gathering. Do not fork or duplicate its contract here.

## Contract overrides

- **Existing app first:** preserve app-local components, tokens, density, platform behavior, and validated patterns unless the task explicitly targets them.
- **Brand source:** `branding-visual/` is canonical for studio identity, shared tokens, marks, typography, motion, and voice.
- **Visual character:** cinematic, restrained, sharp, opinionated, and dev-coded. Product usability wins over marketing spectacle.
- **Accent discipline:** one ember focal point per composition. Semantic status colors remain functional exceptions.
- **Typography:** Geist and Geist Mono through the repo's existing font/token setup.
- **Motion:** deliberate and useful; preserve orientation, reveal state, or confirm action. Respect reduced motion.
- **Validation:** use the target app's established screenshots, VRT, goldens, and real resizing/input paths. Never replace rendered inspection with unit tests.

Do not hardcode web-framework techniques into desktop or mobile apps. The target repo's stack and component conventions win.

## Claude Design bridge

The Claude Design project is a review mirror, not the source of truth. The existing `pickforge-design` skill owns brand assets and DesignSync.

Use it only when the task needs relevant mirror context, drift comparison, a browser/phone review artifact, or a reviewed design-system update pushed to the mirror. Do not invoke DesignSync for routine app UI work.

- In Claude Code: invoke `/pickforge-design <specific read, compare, or push task>`.
- From other agents: run `claude -p "/pickforge-design <specific read, compare, or push task>"` from the Pickforge workspace root.
- If local files and the mirror differ, local files win.
- Durable system changes land in `branding-visual/`, are reviewed and committed there, then sync one way: repo to Claude Design.
- Never hand-edit the Claude Design mirror through another tool.

## Finish

Return representative rendered evidence to the same named design lead. Run app-local functional checks plus the narrowest visual validation. If the change creates a reusable brand rule or token, update `branding-visual/` in its own properly scoped change; do not bury canonical system edits inside an app feature.
