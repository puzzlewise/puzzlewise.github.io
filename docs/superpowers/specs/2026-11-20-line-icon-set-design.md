# One line-icon set for the interface (#786)

## Intent

The interface mixes custom line icons, colour emoji and Unicode glyphs. Emoji
are drawn by the operating system: they differ per platform, ignore the
light/dark chrome colours, and the red ❓ reads as an error. The toolbar's
right column mixes two text buttons of different widths with three icon
buttons, and on phones those text buttons cover pieces.

Replace every emoji and glyph icon with line icons from one set, and turn New
Game and Gather Pieces into icon buttons.

## Goals

- Every interface icon is an inline SVG drawn with `currentColor`, in the
  style the select and marquee icons already use (24×24 viewBox, 2 px stroke,
  round caps and joins).
- The right toolbar is five equal 40×40 px squares, matching the two tool
  buttons on the left.
- The help modal's button list shows the new icons and stays correct.

## Non-goals

- 44 px touch targets and the swatch grid: #787.
- Reserving space for the toolbar in the first-load and gather layouts.
- Restyling the rotate handle, the quarter-turn rotate buttons or the deselect
  button, which are already line icons.
- The "Downloaded ✓" text in the corrupt-save dialog.
- Labels beside the toolbar icons on wide screens. This may follow later if
  icon-only proves too terse.

## Anti-goals

- A button whose only name is its picture. Every icon-only button keeps an
  accessible name and a tooltip.
- A new runtime dependency.

## Approaches

1. **Inline Lucide paths in `src/ui/tool-icons.ts`** (chosen). Lucide (ISC
   licence, v1.77.0) uses the same viewBox, stroke and caps as the existing
   icons, so its path data drops into the existing `makeSvg` helper. No
   dependency, and only the icons used are shipped.
2. **Add the `lucide` package.** Same icons, but a fourth runtime dependency
   and a Dependabot stream for nine icons.
3. **Hand-draw the icons.** No licence notice needed, but slower and less
   consistent than a designed set.

## Decided

| Where | Today | Lucide icon |
| --- | --- | --- |
| New Game button | text | `plus` |
| Gather Pieces button | text | `layout-grid` |
| Background button | 🎨 | `palette` |
| Help button | ❓ | `circle-question-mark` |
| Settings button | ⚙️ | `settings` |
| Show different images | ↻ | `refresh-cw` |
| Surprise me | 🎲 + text | `dices` + the same text |
| Modal close | ✕ | `x` |
| Puzzle complete heading | 🧩 + text | `party-popper` + the same text |

- New Game and Gather Pieces become icon-only, with `aria-label` and `title`
  set to "New Game" and "Gather Pieces". The other icon-only buttons keep the
  names and tooltips they have, and Help and Settings gain an `aria-label`.
- New Game keeps its confirmation when there is progress to lose.
- The debug Solve button loses its 🧩 and keeps its text.

## Constraints

- Lucide's licence (ISC, with MIT for icons inherited from Feather; check its
  `LICENSE` file) requires the copyright notice to travel with copies of the
  icons. Record it where the path data lives or in a notices file, and add
  Lucide to the help modal's Credits section.
- `createSwatchPicker` takes its button icon as a string and is shared with
  the outline colour picker, which passes an empty one.
- Many tests assert the old glyphs and labels; they change with the code.
- Comment policy in `CLAUDE.md` applies: two existing comments name the 🎨
  panel.

## Left to the builder

- How buttons receive an icon (`createToolbarButton`, `createSwatchPicker`,
  the New Game button, which is built by hand).
- Whether the five right-hand buttons share one CSS rule.
- The image picker's error text and the help text both mention ↻ in a
  sentence; show the icon inline or reword.
- Icon size inside each control.
- The wording of the help entries for New Game and Gather Pieces now that the
  buttons carry no text.
