# Pickforge design context

Load only what the task needs. Find the Pickforge workspace root by locating the sibling `branding-visual/` checkout; `/home/dev/Projects/Pickforge` is the normal personal location. If the canonical checkout is absent, stop directed Pickforge visual work and report the missing dependency. Do not substitute the Claude Design mirror.

## Always for directed visual work

- Target repo `AGENTS.md` and `CLAUDE.md` when applicable
- Running/current surface, relevant components, tokens, screenshots, and tests
- `branding-visual/BRAND-IDENTITY.md`
- `branding-visual/DESIGN-TOKENS.md`

## Load by decision

- Layout or hierarchy: `branding-visual/LAYOUT-PATTERNS.md`, `COMPONENTS.md`
- Product-family consistency: `branding-visual/PRODUCTS-VISUAL-LANGUAGE.md`, `APPLICATION-EXAMPLES.md`
- Motion or interaction: `branding-visual/MOTION-AND-INTERACTION.md`
- Color/theme: `branding-visual/COLOR-SYSTEM.md`, `DARK-LIGHT-MODE.md`
- Type: `branding-visual/TYPOGRAPHY.md`
- Icons or marks: `branding-visual/ICONS-AND-EMBLEMS.md`, `LOGO-AND-MARKS.md`
- Product copy: `branding-visual/VOICE-AND-COPY.md`
- New brand asset: `branding-visual/assets/README.md`, `ASSET-MATRIX.md`, and `README-STANDARD.md`

App-local design docs and tokens override generic examples. Shared brand rules override an app only where they are genuinely studio-wide.

## Prompt-contract prefill

Copy the relevant Contract overrides from `pickforge-ui/SKILL.md`, then add:

- Anti-goals: generic AI dashboard, colorful Material palette, soft corporate cards, ornamental gradients, multiple competing glows
- Proof: target app's real surface, required states, resizing/platform widths, and established VRT/goldens

Do not paste the full brand system into the contract. Link the relevant source files and record only decisions that affect this task.
