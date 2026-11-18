# BACKLOG — Puzzlewise

Status: `todo` | `in-progress` | `done` | `blocked`

---

## Phase 1: Foundation

### 1.1 — Project scaffolding & config
**Status:** done
**Description:** Vite + TypeScript + PWA plugin setup, folder structure, license, design doc.

### 1.2 — Core data model
**Status:** done
**Depends on:** 1.1
**Description:** Define TypeScript types for Point, Size, Edge, Piece, PieceGroup, GameState as specified in DESIGN.md. The model is graph-based and shape-agnostic — no grid assumptions in the engine types. Include helper functions: `getMateEdge(piece, edge)` → finds the mate piece and edge, `getBorderEdges(group, pieces)` → returns edges in the group that have mates in other groups (used for merge detection).

### 1.3 — Grid puzzle generator
**Status:** done
**Depends on:** 1.2
**Description:** Create a puzzle generator that produces a 6×8 grid of pieces with tab/blank Bézier edges. The generator is a separate module from the engine — it outputs `Piece[]` conforming to the generic model. Each piece gets: an SVG clip-path built from its edges (flat/tab/blank using cubic Bézier curves), edge connectivity (mate relationships to adjacent pieces), and image sampling coordinates. Adjacent pieces must use the exact same curve (inverted) for their shared edge. Border edges have `mateEdgeId: -1, matePieceId: -1`.

## Phase 2: Rendering

### 2.1 — Renderer interface
**Status:** done
**Depends on:** 1.2
**Description:** Define a `Renderer` interface that the game logic calls. Methods: `init(container)`, `renderState(gameState)`, `onPiecePointerDown(callback)`, `bringGroupToFront(groupId)`, `destroy()`. This abstraction allows swapping DOM→Canvas later.

### 2.2 — SVG/DOM renderer implementation
**Status:** done
**Depends on:** 1.3, 2.1
**Description:** Implement the Renderer interface using SVG/DOM. Each piece = `<image>` element clipped by its SVG path. Groups are DOM containers with CSS `transform: translate(x, y)`. Handle devicePixelRatio for crisp rendering. Use a fixed puzzle image (find/create a suitable 800×600ish image).

## Phase 3: Interaction

### 3.1 — Drag handling
**Status:** done
**Depends on:** 2.2
**Done:** 2026-03-22
**Description:** Implement pointer event handling for drag. On pointerdown on a piece: identify its group, capture pointer, track delta. On pointermove: update group position. On pointerup: release capture, trigger merge check. Dragged group moves to front (z-order).

### 3.2 — Game initialization
**Status:** done
**Depends on:** 3.1
**Done:** 2026-03-22
**Description:** On "New Game": use the grid generator to create 48 pieces, initialize each in its own single-piece group, randomize group positions within the viewport (ensuring all pieces are visible and not overlapping too much), render the initial state.

### 3.3 — Clamp drag to viewport bounds
**Status:** done
**Depends on:** 3.1
**Done:** 2026-03-22
**Description:** Prevent pieces/groups from being dragged out of reach. Clamp pointer position during drag so that at least a grabbable portion of the group remains within the visible viewport. This prevents pieces from getting lost behind browser chrome or off-screen. Uses `visualViewport` for accurate bounds on mobile.

### 3.4 — Zoom and pan
**Status:** done
**Depends on:** 3.1
**Done:** 2026-03-22
**Description:** Add a viewport transform layer so users can zoom in/out and pan the puzzle table. Pinch-to-zoom on touch, scroll-wheel zoom on desktop. Pan by dragging on empty space (not on a piece). The puzzle table should be larger than the screen, with the viewport acting as a window into it. Essential for puzzles that don't fit on screen.

## Phase 4: Core Mechanic

### 4.1 — Merge detection
**Status:** done
**Depends on:** 3.1
**Done:** 2026-03-22
**Description:** After a group is dropped: for each piece in the moved group, iterate its edges. For edges with mates, find the mate piece. If the mate piece is in a different group, calculate expected vs actual edge alignment. If within tolerance (~15-20px), trigger merge. Tolerance should be a named constant (`MERGE_TOLERANCE_PX`).

### 4.2 — Group merging
**Status:** done
**Depends on:** 4.1
**Done:** 2026-03-22
**Description:** When merge is detected: combine two groups (recalculate piece offsets relative to new group anchor, snap position so edges align perfectly, remove old group, update DOM structure). Handle cascading merges (after A+B merge, re-check new group's border edges against all mates).

### 4.3 — Win detection
**Status:** done
**Depends on:** 4.2
**Done:** 2026-03-22
**Description:** After each merge, check if all pieces are in a single group. If so, set `completed: true` and show a simple "Puzzle Complete!" message.

### 4.4 — Prevent accidental merges in piece piles
**Status:** done
**Depends on:** 4.2
**Done:** 2026-03-22
**Description:** When dropping a piece near a pile of other pieces, it can accidentally snap to a matching edge even though the player clearly didn't intend to place it there. This makes sorting through piles frustrating. Add a heuristic to suppress merging when the dropped piece/group is overlapping with many other non-matching groups (i.e. it's in a pile, not being intentionally placed). Important: don't block intentional placement into a gap in an assembled section — there, neighboring pieces are expected to be close. Possible approach: count how many distinct other groups overlap the dropped piece's bounding area; if above a threshold and many of those are non-matching, skip the merge.

## Phase 5: Persistence & UI

### 5.1 — Auto-save & restore
**Status:** done
**Depends on:** 4.2
**Done:** 2026-03-22
**Description:** Save full GameState to localStorage on every state change (debounced 500ms). Serialize Maps as entries arrays. On app load: check for saved state, restore if valid, otherwise show new game. Include state version number for future migrations. Wrap restore in try/catch.

### 5.2 — New Game button
**Status:** done
**Depends on:** 5.1
**Done:** 2026-03-22
**Description:** Add a minimal UI: "New Game" button that clears saved state and re-randomizes. Confirm before discarding an in-progress game.

### 5.3 — Centre view button
**Status:** done
**Depends on:** 3.4
**Done:** 2026-03-22
**Description:** Add a UI button that resets the viewport pan/zoom to the default centred view. Useful after zooming/panning around to quickly get back to a known orientation.

### 5.4 — Gather pieces button
**Status:** done
**Depends on:** 3.2
**Done:** 2026-03-22
**Description:** Add a UI button that brings all groups together to the centre of the visible play area. When pieces are scattered widely (especially after zooming out), this collects them into a manageable area without changing their groupings. Should distribute groups loosely so they don't all stack on the exact same point.

### 5.4.1 — Fix: Gather pieces should scatter, not solve
**Status:** done
**Done:** 2026-03-22
**Depends on:** 5.4
**Description:** Scatter groups into a randomised grid within 2.5× the puzzle dimensions. Groups are shuffled and jittered — no correlation with solved positions.

## Phase 6: Polish & Deploy

### 6.1 — PWA manifest & icons
**Status:** done
**Depends on:** 5.2
**Done:** 2026-03-22
**Description:** Configure vite-plugin-pwa with proper manifest (name, icons, theme color, display: standalone). Generate app icons for iPad home screen. Test "Add to Home Screen" flow.

### 6.2 — GitHub Pages deployment
**Status:** done
**Done:** 2026-03-22
**Description:** Set up GitHub Actions workflow to build and deploy to gh-pages on push to main. Verify the app loads correctly from the Pages URL.

### 6.3 — Visual polish
**Status:** done
**Done:** 2026-03-22
**Depends on:** 5.2
**Description:** Subtle drop shadow on pieces/groups for depth. Smooth snap animation when pieces merge. Satisfying "complete" animation. Basic responsive layout (works on iPad in both orientations).

### 6.4 — Suppress context menu on long-press
**Status:** done
**Depends on:** 3.1
**Done:** 2026-03-22
**Description:** On touch devices (especially iPad), long-pressing a puzzle piece brings up the browser's context menu. Prevent this by adding `contextmenu` event prevention on the puzzle container. Also ensure no text selection or callout overlays appear during drag (`-webkit-touch-callout: none`, `user-select: none`).

---

## Phase 7: MLP — Minimum Lovable Product

### 7.1 — Random Unsplash images
**Status:** done
**Done:** 2026-03-22
**Depends on:** 5.1
**Description:** On "New Game", fetch a random landscape photo from Unsplash to use as the puzzle image. Use the Unsplash API (free tier, needs API key). Filter for landscape orientation to match the puzzle grid aspect ratio. Store the image URL in GameState so the image persists across app restarts. Handle errors gracefully (fall back to default image if fetch fails). The API key should be configured via environment variable at build time (not committed to repo).

### 7.1.1 — Fix: New Game should show new Unsplash image immediately
**Status:** done
**Done:** 2026-03-22
**Depends on:** 7.1
**Description:** Currently, starting a new game doesn't display a new image until the app is reloaded. The `startNewGame()` function fetches a new Unsplash image, but the rendered puzzle keeps showing the previous image. Investigate whether this is a browser caching issue, a renderer not updating the image source, or the SVG `<image>` elements holding stale `href` references. The new image should appear immediately when "New Game" is pressed.

### 7.2 — Selectable puzzle sizes
**Status:** done
**Done:** 2026-03-22
**Depends on:** 5.2
**Description:** Let the player choose puzzle size when starting a new game. Options: 24 (4×6), 48 (6×8), 96 (8×12), 192 (12×16). The grid generator already accepts rows/cols, so this is primarily a UI task. Show size options in a new-game dialog or screen. Save the chosen size preference. Consider piece size vs screen size — larger puzzles need smaller pieces.

### 7.3 — Procedurally generated cuts
**Status:** done
**Done:** 2026-03-22
**Depends on:** 1.3
**Description:** Create a new puzzle generator that produces varied, natural-looking cuts so no two puzzles have the same cut pattern. Each game should feel unique. The generator should still conform to the generic Piece/Edge model. Vary tab/blank shapes (different Bézier control points), edge positions (not perfectly grid-aligned), and possibly tab sizes. Use a seeded PRNG so the same seed reproduces the same cut (useful for save/restore).

### 7.4 — Improve procedural cut realism (round 1)
**Status:** done
**Done:** 2026-03-22
**Depends on:** 7.3
**Description:** Added mushroom/knob tabs, three head profiles (round, square, heart), neck pinch, and edge wobble. PR #40.

### 7.4.1 — Improve procedural cut geometry (round 2)
**Status:** done
**Done:** 2026-03-22
**Depends on:** 7.4
**Description:** Round 1 improved tab head shapes, but the overall edge geometry is still too uniform. This task is about making the *geometry* more varied and interesting — not skeuomorphic effects like cardboard deformation. Also, the edge wobble and neck pinch added in round 1 should be reverted or toned down — they simulate manufacturing imperfections which isn't what we're going for. Focus areas:
- **Curved edge lines** — the boundary between two pieces shouldn't be a straight line with a bump. Real puzzle dies produce gentle S-curves or arcs between pieces
- **Significantly off-centre tabs** — current centreOffset is ±6%, barely noticeable. Allow tabs at 30% or 70% along the edge
- **Varied edge segments** — the portions of the edge on either side of the tab should be curves, not straight lines
- **Non-uniform grid lines** — the overall grid lines should gently meander rather than being perfectly straight, producing pieces that aren't all identical rectangles
- **Remove or reduce wobble/pinch** — the skeuomorphic "imperfect die cut" effects from 7.4 should be toned down or removed; focus on geometric variety instead

### 7.5 — Background colour selection
**Status:** done
**Done:** 2026-03-22
**Depends on:** 6.3
**Description:** Let the player change the puzzle table background colour. Dark pieces are hard to see on the default dark background. Offer a few preset colours (dark, medium grey, light, wood tone, green felt) and/or a custom colour picker. Persist the choice in localStorage. Apply via CSS custom property on the body/container.

### 7.6 — Free rotation of pieces
**Status:** on-hold ⚠️ (reverted — implementation was broken, needs manual rework with visual verification)
**Depends on:** 4.2
**Description:** Pieces start at random rotations. Two-finger rotate gesture on touch, or modifier+drag on desktop. Merge detection must account for rotation — edges only align when both pieces are at the correct relative rotation (within tolerance). Add rotation field to PieceGroup. Snap rotation to 0° on merge. This significantly increases puzzle difficulty and realism.

## Phase 8: Generator Overhaul & UX

### 8.1 — Refactor generator: generate-once-reverse-for-mate
**Status:** done
**Done:** 2026-03-23
**Depends on:** 7.3
**Description:** Refactor the procedural generator to generate each shared edge's path ONCE (from one side's perspective), store the path points, and create the mating edge by reversing the points array. This eliminates the entire class of bugs where tab and blank don't match because of direction-dependent parameters (centreOffset, skew). Currently both sides are generated independently with shared params — this is fragile. The reversal approach is mathematically guaranteed to produce a perfect mirror. See `docs/reference-algorithms.md` for details on how Dillo's CodePen does this.

### 8.2 — Classic shape generator (Dillo-inspired)
**Status:** done
**Done:** 2026-03-23
**Depends on:** 8.1
**Description:** Replace the current 2-Bézier tab shape with a 6-Bézier classic jigsaw shape inspired by Dillo's CodePen (`twist0` function). Uses 5 key points (neck entry, head left, head top, head right, neck exit) with control points that create the distinct mushroom shape with a narrow neck and wide head. Coordinate system uses edge direction + perpendicular-to-opposite-side as axes. Randomize: horizontal scale (0.8-1.0), vertical scale (0.9-1.0), centre position (0.45-0.55). Credit Dillo in the info modal. Reference: `docs/reference-algorithms.md`.

### 8.3 — Fractal cut generator (alternative style)
**Status:** done
**Done:** 2026-03-24
**Depends on:** 8.1
**Description:** Add the fractal/circle-packing generator as an alternative cut style, inspired by the Fractal Jigsaw Generator (proceduraljigsaw/Fractalpuzzlejs). Uses a circle-packing grid where pieces are organic shapes formed by merging adjacent circles — no traditional tabs/blanks. Very different aesthetic from classic cuts. Should be selectable as a cut style option. Must still produce Piece[] conforming to our generic data model. Credit the Fractal Jigsaw project in the info modal. Reference: `docs/reference-algorithms.md`.

### 8.4 — Info/help modal with credits
**Status:** done
**Done:** 2026-03-23
**Depends on:** 5.2
**Description:** Add an info/help button (ℹ️ or similar) that opens a modal overlay with:
- **Credits:** algorithm inspirations (Dillo's CodePen, Fractal Jigsaw Generator), with links
- **Project link:** link to our GitHub repo (puzzlewise/puzzlewise.github.io)
- **License info:** MIT
- **How to play:** brief help text explaining features — drag pieces, pinch to zoom, pan on empty space, piece merging, buttons (New Game, Gather Pieces, Centre View, Background Colour)
- Keep the Unsplash photo credit in its current position (tied to the current image)
- Style: glassmorphism modal matching the existing button aesthetic, dismissable by clicking outside or a close button

### 8.5 — Cut style selection UI
**Status:** done
**Done:** 2026-03-24
**Depends on:** 8.2, 8.3
**Description:** Add UI for selecting between cut styles when starting a new game. Options: "Classic" (default, Dillo-inspired), "Fractal" (circle-packing). Show in the new-game dialog alongside puzzle size selection. Save preference. The selected generator is used by createNewGame().

## Phase 9: Interaction Polish

### 9.1 — Dismiss completion overlay on tap
**Status:** done
**Done:** 2026-03-24
**Depends on:** 4.3
**Description:** When the "Puzzle Complete!" message is shown, tapping/clicking anywhere on the screen should dismiss the overlay so the player can admire the finished image. Currently there's no way to close it.

### 9.2 — Merge tolerance options
**Status:** done
**Done:** 2026-03-24
**Depends on:** 8.4
**Description:** Add merge tolerance settings to the info/settings modal. At least two options: "Normal" (current tolerance) and "Forgiving" (larger tolerance for casual players). Persist the choice. Update `MERGE_TOLERANCE_PX` (or equivalent) based on the setting.

### 9.3 — Prevent piece drag during pinch-to-zoom
**Status:** done
**Done:** 2026-03-23
**Depends on:** 3.4
**Description:** When a pinch-to-zoom gesture begins, any piece drag that started from the first finger of that gesture should be cancelled immediately. Currently, pinching sometimes moves a piece with the first touch point while zooming with both. Detection: as soon as a second pointer goes down while a drag is active, cancel the drag (restore the piece to its pre-drag position) and let the gesture become a pure zoom/pan.

### 9.4 — Bias touch targets toward pieces over background
**Status:** done
**Done:** 2026-03-24
**Depends on:** 3.1
**Description:** When zoomed out, it's easy to miss a piece and grab the background instead (triggering pan). Improve hit detection so that touches near a piece edge are more likely to register as hitting the piece. Possible approach: expand the hit-test area of pieces by a few pixels (in screen space, not puzzle space — so the expansion is larger when zoomed out), but only for the purpose of choosing "piece vs background". When multiple pieces overlap, do NOT expand — use exact hit testing to avoid grabbing the wrong piece. The bias should only apply to the piece-vs-empty-space decision.

### 9.5 — Auto-pan when dragging to viewport edge
**Status:** done
**Done:** 2026-03-24
**Depends on:** 3.4
**Description:** When dragging a piece to the edge of the visible viewport, automatically pan the play area in that direction. This lets the player move pieces across large distances without the tedious cycle of: drag piece to edge → drop → pan → pick up → drag again. Implementation: define an edge zone (e.g. 40-60px from viewport edge), and while the pointer is in that zone during a drag, smoothly scroll the viewport in that direction. Pan speed should be proportional to how deep into the edge zone the pointer is. Stop panning when the pointer leaves the zone or the drag ends.

## Phase 10: Fractal & UX Polish

### 10.1 — Scale fractal grid to match target piece count
**Status:** done
**Done:** 2026-03-24
**Depends on:** 8.3
**Description:** The fractal generator receives a tile grid size (e.g. 6×4), not a piece count. Since each piece spans multiple tiles, a 6×4 grid produces far fewer than 24 pieces. We need to scale the tile grid so the resulting piece count approximately matches the target (24, 48, 96, 192). This likely means using a larger tile grid and calibrating the min/max piece size parameters. Could use a lookup table or a formula based on empirical testing. The New Game dialog should still show approximate piece counts, not tile grid dimensions.

### 10.2 — Fix remaining visual gaps in fractal puzzles
**Status:** todo
**Depends on:** 8.3
**Description:** Some fractal puzzles still show small star-shaped visual gaps at 4-piece junctions. The cells are topologically filled (a diagonal connection exists), but the `addArcs` algorithm doesn't generate arcs that visually cover the full cell area at certain piece boundary configurations. The fix likely involves adjusting how piece boundary paths are drawn — either extending arcs slightly to overlap at junctions, or adding extra arc segments at junction points.

### 10.3 — Improve Gather Pieces layout
**Status:** done
**Done:** 2026-03-24
**Depends on:** 5.4
**Description:** The current Gather Pieces function spreads pieces out too much, making them hard to work with. Improve it to arrange pieces in a compact grid layout with a consistent minimum margin between each piece. Use the bounding box of each piece/group to tile them efficiently. Important: the layout must NOT correlate with the solved positions — pieces should be shuffled so it doesn't accidentally solve the puzzle. Consider sorting by size (larger groups first) and packing them in a grid pattern. Also update the description of the Gather Pieces button in the info modal to reflect the new behaviour.

### 10.4 — Use gather layout for new game initial placement
**Status:** done
**Done:** 2026-03-24
**Depends on:** 10.3
**Description:** When starting a new game, use the same gather layout algorithm (compact grid with zoom-to-fit) instead of random scattering. This gives the player a neatly organized starting point at the right zoom level, immediately playable without having to zoom out and hunt for pieces.

## Phase 11: Sharing

### 11.1 — Puzzle sharing via link
**Status:** done
**Done:** 2026-04-22
**Depends on:** 8.5, 10.4
**Description:** Share a puzzle via `#p=<payload>` URL hash — same image, cuts, seed, rotation mode, and optionally merge progress. The info modal grows a "Share this puzzle" section with a checkbox to include current progress; the completion overlay gets a "Challenge a friend" button. Sharing uses the Web Share API when available and falls back to copying the link to the clipboard. Recipients land on the same puzzle on boot; if they already had a game in progress, a confirm dialog prompts before overwriting.

---

*Last updated: 2026-04-22*
