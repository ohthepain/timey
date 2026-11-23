# User-facing report design prompt

Turn the provided source material into a single-file, self-contained HTML report styled as a modern editorial landing page.

## Copy workflow

- Pass all source content through the `/bro` skill to generate the copy used in the report.
- Do not apply any extra tone or copywriting rules of your own. Rely strictly on `/bro` for the text, and organize that output cleanly into the layout sections below.

## Technical requirements

- Output a single, complete `<!DOCTYPE html>` file with embedded `<style>` and zero external dependencies, frameworks, or external images.
- Include `lang="en"`, UTF-8 charset, and a viewport meta tag. Use semantic headings and anchor targets.
- Fully responsive down to mobile (`@media (max-width: 640px)`), using `grid-template-columns: repeat(auto-fit, minmax(..., 1fr))`. Keep grid minimums within the available width on narrow screens.

## Visual design system

Use this exact warm-editorial light palette and elevation scale:

```css
:root {
  --bg: #faf9f5;
  --surface: #ffffff;
  --surface-alt: #f3f1ec;
  --border: #e6e3dc;
  --ink: #171717;
  --ink-soft: #575551;
  --ink-muted: #85827c;
  --claude: #d97757;
  --claude-soft: #fdf3ef;
  --gemini: #2563eb;
  --gemini-soft: #eff5ff;
  --emerald: #0d7a5f;
  --emerald-soft: #ecfdf5;
  --amber: #b45309;
  --amber-soft: #fffbeb;
  --radius-lg: 20px;
  --radius-md: 14px;
  --shadow-sm: 0 2px 8px rgba(23, 23, 23, 0.03);
  --shadow-md: 0 12px 32px rgba(23, 23, 23, 0.05);
}
```

Use `--bg` for the page, `--surface` for cards, `--surface-alt` for muted
callouts, icon boxes, and mini-pills, and `--border` for 1px card and section
dividers. Use `--ink` for headings, primary text, and the dark banner;
`--ink-soft` for body copy; and `--ink-muted` for uppercase eyebrows, labels,
and footer. Accent pairs are terracotta, sapphire blue, emerald for done or
verified items, and amber for in-progress or next items.

## Typography and spacing

- Font stack: `-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif` with `-webkit-font-smoothing: antialiased` and `line-height: 1.6`.
- Container: `max-width: 1080px; margin: 0 auto; padding: 0 24px;`.
- `h1`: `clamp(2.4rem, 5vw, 3.6rem)`, `font-weight: 800`, `letter-spacing: -0.035em`, `line-height: 1.1`, with 1–2 key words highlighted in `--claude` or `--gemini` accent colors.
- `h2`: `clamp(1.75rem, 3vw, 2.25rem)`, `letter-spacing: -0.025em`, `line-height: 1.2`.
- Eyebrows and stat labels: `0.78rem–0.8rem`, `text-transform: uppercase`, `letter-spacing: 0.06em–0.08em`, `font-weight: 600–700`, `color: var(--ink-muted)`.
- Sections: `padding: 64px 0; border-top: 1px solid var(--border);` with a `max-width: 640px` section header (`margin-bottom: 40px`).

## Page architecture

Adapt sections to fit the source material. Use supported facts for snapshot
values and status badges. Do not invent metrics or completion to fill cards.

1. **Sticky frosted top nav**: `rgba(250, 249, 245, 0.85)` with `backdrop-filter: blur(10px)`, a brand label on the left with a `10px` gradient circle (`linear-gradient(135deg, #D97757, #2563EB)`), and smooth anchor links on the right (hidden on mobile).
2. **Centered hero and 4-card snapshot strip**: Rounded status pill at the top with an `8px` colored status dot and key milestone summary. Centered `h1` and `1.2rem` subtitle (`max-width: 650px`). A 4-column grid of compact stat cards (`--surface`, `1px` border, `--radius-md`), each showing an uppercase label, bold headline value, and one-line note.
3. **Primary showcase cards, 3-column grid**: Elevated white cards (`--radius-lg`, `--shadow-md`, `padding: 28px`, flex column `space-between`). Colored pill badge at the top, `h3` title, description, and a bottom row of `.mini-pill` tags (`background: var(--surface-alt)`, `border-radius: 8px`).
4. **Key pillars or guardrails, 4-column grid**: Clean bordered cards (`--radius-md`, `padding: 24px`), each topped with a `40x40px` rounded icon box (`--surface-alt`) containing a simple HTML entity or symbol, followed by `h3` and body text.
5. **High-contrast steps or workflow banner**: Full-width dark container (`background: var(--ink)`, white text, `--radius-lg`, `padding: 40px`) with a 3-column grid. Each step has a `32x32px` translucent circular number badge (`rgba(255,255,255,0.14)`), white `h3`, and muted light-gray body text (`#B8B5AE`).
6. **Readiness or comparison checklist and notes callout**: Two side-by-side cards (`--radius-lg`, `padding: 28px`) with a bottom-bordered header containing an `h3` and a colored pill badge (emerald for completed or verified items; amber for remaining or open items). Clean vertical list items with `20x20px` circular check (`✓`) or bullet (`•`) icons in matching emerald or amber tints. Directly underneath, a full-width muted callout box (`background: var(--surface-alt)`, `--radius-md`, multi-column grid) for important limits, constraints, or footnotes.
7. **Minimal footer**: Centered single-line metadata summary with top border.

## Source material

Use the supplied completed investigation findings, evidence, recommendations,
and provenance, together with any explicitly identified additional observations.
The saved file contains only the HTML document. Return publication references and
the `flow-result` separately as required by the Generate report skill.
