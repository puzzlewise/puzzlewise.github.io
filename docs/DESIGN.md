# Puzzlewise — Design Document

## Vision

A jigsaw puzzle web app that recreates the experience of laying a physical puzzle on a physical table. No "snap to correct position" — pieces merge with each other when matching edges are placed close together, regardless of where they are on the screen.

## MVP Scope

- 48 pieces (6×8 grid), fixed cut, fixed image
- Randomized piece placement at game start
- Drag pieces by touch or mouse
- Piece-to-piece merging (the core mechanic)
- Auto-save game state to localStorage
- Win detection (all pieces merged into one group)
- PWA for "Add to Home Screen" on iPad
- Deployed via GitHub Pages

## Architecture Decisions

### Rendering: DOM/SVG with CSS Transforms
- Each piece is an SVG element with a clip-path
- CSS `transform: translate()` for positioning (GPU-accelerated)
- Grouping via DOM structure (`<g>` elements or wrapper divs)
- Native pointer event handling (no manual hit testing)
- DevTools-inspectable for easy debugging

**Renderer interface**: All rendering goes through a `Renderer` interface so we can swap to Canvas later if needed for large puzzles (500+ pieces).

### Data Model: Graph-Based with Groups

The game engine is **shape-agnostic** — it knows nothing about grids, rows, columns, or cardinal directions. The puzzle generator produces pieces with edges and connectivity; the engine handles merging and interaction generically.

- Every piece is always in exactly one group (solo pieces = single-piece groups)
- Merging = combining two groups into one
- Pieces know their offset within their group; world positions are derived from `group.position + piece.groupOffset`
- Connectivity is defined by edge mate relationships, not grid adjacency

This design supports future non-grid cuts (hexagonal, triangular, freeform, etc.) without changing the engine.

### Core Types
```typescript
interface Point {
  x: number;
  y: number;
}

interface Edge {
  id: number;
  mateEdgeId: number;    // The matching edge on the adjacent piece (-1 for border edges)
  matePieceId: number;   // Which piece that edge belongs to (-1 for border edges)
  path: string;          // SVG path segment for this edge
  start: Point;          // Where this edge starts on the piece (in piece-local coords)
  end: Point;            // Where this edge ends on the piece (in piece-local coords)
}

interface Piece {
  id: number;
  edges: Edge[];         // All edges of this piece
  shape: string;         // Full SVG clip-path (d attribute)
  imageOffset: Point;    // Where to position the source image behind the clip-path
}

interface PieceGroup {
  id: number;
  pieces: Map<number, Point>;  // pieceId → offset within group
  position: Point;              // Group's world position
}

interface GameState {
  pieces: Piece[];
  groups: PieceGroup[];
  imageUrl: string;
  completed: boolean;
}
```

### Puzzle Generator (separate from engine)
The puzzle generator is responsible for creating piece definitions for a specific puzzle type. For MVP, a grid generator creates a 6×8 grid with tab/blank Bézier edges. The generator produces:
- Piece shapes (SVG paths)
- Edge connectivity (which edges are mates)
- Image sampling coordinates for each piece

Future generators can produce hexagonal, irregular, or freeform cuts — the engine handles them all the same way.

### Merge Algorithm
On drop of a group:
1. For each piece in the moved group, check each of its edges
2. If an edge has a mate (not a border edge), find the mate piece
3. If the mate piece is in a different group, check whether the edges align within tolerance (~15-20px)
4. Alignment = comparing actual positions of the edge endpoints vs expected positions if pieces were correctly connected
5. If match: merge groups, snap to perfect alignment
6. Cascade: re-check new group's edges (one drop can trigger multiple merges)

### Interaction
- Pointer Events API (unified mouse/touch/pen)
- Drag entire group when any piece in it is grabbed
- Dragged group renders on top (z-order management)
- Pointer capture for reliable drag tracking

### Persistence
- `localStorage` with debounced writes (500ms)
- Full GameState serialized as JSON (Maps serialized as entries arrays)
- Load on startup with try/catch (corrupted state → new game)
- Well under localStorage size limits even for large puzzles

### PWA
- Vite + vite-plugin-pwa for service worker
- Manifest with icons for iPad home screen
- Offline-capable (all assets cached)

## Future Features (not MVP, but architecture must not block)
- Select from built-in image gallery
- Upload/link custom images
- Procedurally generated puzzle cuts (any shape, not just grid)
- Different cut styles and puzzle sizes
- Free rotation of pieces
- Zoom/pan for large puzzles (500+ pieces)

## Testing
- **Unit tests (Vitest):** All pure logic — data model helpers, puzzle generators, merge detection, state serialization. Tests are part of every task, not a separate phase.
- **E2E tests (Playwright):** Interaction scenarios — drag pieces, merge groups, save/restore state, win detection. Added once the rendering layer is in place.
- Run `npm test` before every commit. Don't push broken tests.

## Tech Stack
- TypeScript
- Vite (build + dev server)
- Vitest (unit tests)
- Playwright (e2e tests)
- vite-plugin-pwa
- No framework (vanilla TS)
- GitHub Pages for deployment
