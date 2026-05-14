# Cosmocopia design-system audit

Worktree: `/tmp/design-audit` at `origin/main` (HEAD `55bff4c`, "docs: refresh screenshots — new brutalist UI + planet view + rarity tiers"; design-system port `fcef1d6` is in this history).

**Note on sources.** The Anthropic-hosted package URL
`https://api.anthropic.com/v1/design/h/MLAQ3azVSzlVE2ATETvWDQ?open_file=ui_kits%2Fweb%2Findex.html`
returned **HTTP 404** for both the file and the listing — the hash has either rotated or been revoked. The audit below therefore uses the spec captured by the previous porting commit (the comment header in `web/app/globals.css` and the brief's mandates) as the authoritative reference, and verifies that the **applied** tokens in `:root` are internally consistent (they are — radii are all 0/2/4/pill, shadows are all `var(--pitch)` offsets, fonts are Space Grotesk / JetBrains Mono / VT323). Visual verification via Playwright was attempted but blocked: turbopack refuses `node_modules` symlinks that escape the project root, and a clean `npm ci` was out of scope. The audit is therefore a thorough static review of the seven listed components plus the three app pages.

---

## 1. Summary table

| File | Verdict | Headline reason |
|---|---|---|
| `web/app/globals.css` | partial | Defines all new tokens correctly, but keeps a `--hover-lift` soft-shadow token that contradicts the "hard offsets, no soft drops" rule, and `.planetViewCanvasWrap` still wraps the pixel canvas in `padding: 8px` rather than a flush hard frame. |
| `web/app/layout.tsx` | compliant | Pure shell; preconnect to Google Fonts is correct. |
| `web/app/page.tsx` | partial | Uses legacy `var(--dim)` once (line 71) and a non-grid `marginTop: 40` (line 106); otherwise clean. |
| `web/app/galaxy/page.tsx` | compliant | Page chrome uses `.hero` + `.tag` correctly. |
| `web/components/ConnectButton.tsx` | compliant | Uses `.walletChip`, `.modal`, `.option`, `.kbd`, `.errBox` — all canonical. Modal title is lowercase ("choose your wallet"), which matches `--font-chrome` lowercase styling. |
| `web/components/PlanetView.tsx` | compliant | Uses `.modal.planetView`, `.planetViewHeader`, `.planetViewCanvasWrap`, `.popBadge`, `.civBadge`. The rounded-frame concern flagged in the brief is a **CSS** issue, not a TSX one — see Findings M1. |
| `web/components/PlanetSprite.tsx` | compliant | Pixel-art canvas only; no chrome. Inline `imageRendering: 'pixelated'` is correct. Canvas overlay glows are art, not chrome — exempt. |
| `web/components/RarityBadge.tsx` | partial | Carries a **soft glow** `boxShadow: 0 0 12px <color, 0.35>` inline (line 23). Glows are explicitly distinct from drop-shadows in the system (`--glow-primary` is allowed), so this one is **deliberate** — but it should reference the token, not hardcode the recipe. |
| `web/components/Traits.tsx` | partial | Two uses of legacy `var(--dim)` (lines 9, 13). |
| `web/components/OwnedPlanets.tsx` | partial | Internal vital track is hand-built (lines 258-268) with inline styles rather than a reusable `.vitalTrack` class; `marginBottom: 24` (line 67) and `gap: 12` (line 68) are on-grid but bypass `var(--space-*)` tokens — they drift if spacing scale changes. |
| `web/components/GalaxyMap.tsx` | **non-compliant** | `borderRadius: 8` on the map canvas (line 214) — direct violation of the sharp-radius rule. Sector legend swatch and selector ring also miss the new tokens. Sector ring `lineWidth: 1` with `setLineDash([4, 4])` is fine, but the labels render in `ui-monospace` (line 135) instead of JetBrains Mono. |

---

## 2. Findings by severity

### High — clear violations of stated principles

**H1 — `web/components/GalaxyMap.tsx:214` rounded canvas**
```tsx
style={{ width: '100%', aspectRatio: '4 / 3', display: 'block', borderRadius: 8, cursor: ...
```
The map canvas wears an 8-px radius, contradicting the brutalist sharp-radius rule (`--radius-sm: 0`, `--radius-xl: 4`). Fix:
```tsx
style={{ width: '100%', aspectRatio: '4 / 3', display: 'block', border: '2px solid var(--pitch)', cursor: ...
```
Drop `borderRadius` entirely; add a `2px` `--pitch` border and the standard `--shadow-hard-sm` on the wrapping panel (already present). Effort: 1 line.

**H2 — `web/components/GalaxyMap.tsx:135, 173` non-system canvas font**
```js
ctx.font = '11px ui-monospace, monospace';   // line 135
ctx.font = '10px ui-monospace, monospace';   // line 173
```
The map labels paint inside a `<canvas>` and bypass the global font stack. The design system mandates JetBrains Mono for chrome/data labels. Fix:
```js
ctx.font = '11px "JetBrains Mono", ui-monospace, monospace';
```
(Canvas needs a literal stack — `var(--font-mono)` won't resolve there.) Effort: 2 lines. **Caveat:** JetBrains Mono is web-loaded via `@import url(...)`; canvas paints occur synchronously and may render before the font is ready. Wrap the chart in a `useEffect` that waits on `document.fonts.ready` before the first draw.

**H3 — `web/components/GalaxyMap.tsx:166` selector ring uses raw hex**
```js
ctx.strokeStyle = '#ff85c4';
```
This is the `--conjoin` magenta, but inlined. Fix:
```js
ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue('--conjoin').trim() || '#ff85c4';
```
Or define a module-level constant `const CONJOIN = '#ff85c4'` with a comment pointing to the token. Effort: 1 line + comment.

**H4 — `web/app/globals.css:113` lingering soft-drop token**
```css
--hover-lift:   0 4px 16px rgba(77, 255, 174, 0.25);
```
The design system explicitly forbids soft drops. The token is currently unreferenced (grep finds zero call sites), but its presence is a trap — the next dev to type "hover-lift" will think it's blessed. Fix: delete the line. Effort: 1 line.

### Medium — legacy aliases / structural drift

**M1 — `web/app/globals.css:709` `.planetViewCanvasWrap` adds `padding: var(--space-2)`**
```css
.planetViewCanvasWrap {
  background: var(--pitch);
  border: 2px solid var(--pitch);
  outline: 1px solid var(--hairline);
  outline-offset: -2px;
  border-radius: 0;
  padding: var(--space-2);       /* ← 8px of black framing the pixel scene */
  ...
}
```
The wrap is correctly sharp (`border-radius: 0`), and the 8-px frame is consistent black, so this is **not** a strict violation. But the brief calls out a "hard frame instead". Recommend the inner outline be replaced with a second hairline-2 border directly butted against the canvas, removing the `padding` so the pixel art touches the slab edge:
```css
.planetViewCanvasWrap {
  background: var(--pitch);
  border: 2px solid var(--pitch);
  box-shadow: inset 0 0 0 1px var(--hairline-2);
  padding: 0;
  ...
}
```
Effort: 4 lines.

**M2 — `web/components/Traits.tsx:9, 13` legacy `var(--dim)`**
```tsx
<span style={{color:'var(--dim)'}}>score {r.score}</span>
<span style={{color:'var(--dim)'}}>×{t.featureIntensity}</span>
```
Works today via the alias `--dim: var(--stardust)` (`globals.css:34`), but if the aliases are removed (and the porting commit message implies that's the long-term plan) Traits goes blank. Fix:
```tsx
<span style={{color:'var(--stardust)'}}>score {r.score}</span>
```
Effort: 2 lines.

**M3 — `web/app/page.tsx:71` legacy `var(--dim)`**
```tsx
<div style={{ ..., color: 'var(--dim)' }}>invalid hex</div>
```
Same fix — swap to `var(--stardust)`. Effort: 1 line.

**M4 — `web/components/OwnedPlanets.tsx:198-280` vital track is open-coded**
The `Vital` sub-component constructs the sunken bar inline with `background: var(--pitch)`, `border: 1px solid var(--pitch)`, `outline: 1px solid var(--hairline)`. That **does** match the brief's "sunken black tracks with hairline outline" pattern — the token usage is correct. The smell is that this pattern is duplicated nowhere else, so it never made it into `globals.css` as `.vitalTrack`. Fix: extract a class so any future progress bar inherits it. Effort: 12 lines of CSS + a 3-line TSX swap.

**M5 — `web/components/RarityBadge.tsx:23` inline glow recipe**
```tsx
boxShadow: `0 0 12px ${alpha(color, 0.35)}`,
```
The 12-px-radius / 0.35-alpha recipe is **exactly** the `--glow-primary` / `--glow-conjoin` shape (compare `globals.css:110-111`). The badge is tier-coloured at runtime so a static var won't do, but the magic numbers should live in a helper. Fix: extract `function tierGlow(color: string) { return `0 0 12px ${alpha(color, 0.35)}` }` and reference the same `0.35` from a shared module — or accept the inline duplication and add a comment naming it as a glow variant. Effort: 6 lines.

**M6 — `web/components/OwnedPlanets.tsx:67, 68` magic-number spacing**
```tsx
<div className="panel" style={{ marginBottom: 24 }}>
  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
```
24 and 12 are on the 4-px grid but bypass `--space-6` / `--space-3`. Fix:
```tsx
<div className="panel" style={{ marginBottom: 'var(--space-6)' }}>
  <div style={{ ..., gap: 'var(--space-3)', ... }}>
```
Effort: ~6 line edits across `OwnedPlanets.tsx` and `page.tsx`.

**M7 — `web/components/GalaxyMap.tsx:101, 140` legacy navy background**
```js
ctx.fillStyle = '#0a0b1a';                       // base fill — not the new --void
ctx.fillStyle = 'rgba(10,11,26,0.88)';           // label backdrop
```
The new neutral `--void` is `#0a0b0e` (no blue). `#0a0b1a` and `rgba(10,11,26,...)` carry a perceptible blue cast that won't match the rest of the surface. Fix:
```js
ctx.fillStyle = '#0a0b0e';                       // --void
ctx.fillStyle = 'rgba(10,11,14,0.88)';
```
Effort: 2 lines.

### Low — minor polish

**L1 — `web/app/page.tsx:106` `marginTop: 40`** isn't on the 4-px scale's named tokens (4/8/12/16/20/24/32/48/64). Closest is 48 (`--space-12`). Fix: `marginTop: 'var(--space-12)'`. Effort: 1 line.

**L2 — `web/components/GalaxyMap.tsx:291` `marginLeft: 22`** — same off-grid issue. Use `var(--space-5)` (20px) or `var(--space-6)` (24px). Effort: 1 line.

**L3 — `web/app/globals.css:213` `code` border is `1px solid var(--primary)`** — the system shows panel/button borders as `2px solid var(--pitch)`. The contrast green border on inline code is an *intentional* accent (chip-like), so this is design-correct, but worth a token: `--border-code-emphasis: 1px solid var(--primary)` for documentability. Effort: optional.

**L4 — `web/components/OwnedPlanets.tsx:225` `a.toLowerCase()` on care buttons** — emits "warm", "rain", etc. The button base style is already `text-transform: lowercase`, so calling `.toLowerCase()` is redundant. Harmless, but the duplicate lowercase logic obscures whether the casing is structural (CSS) or content (JS). Effort: 1 line.

**L5 — `web/components/Traits.tsx`** — no `font-family` declaration on the wrapping `<dl>`; the `.traits` class (`globals.css:421`) sets `dt`/`dd` to mono but **not** the `<dl>` itself. If a future addition adds a non-`dt`/`dd` child it inherits Space Grotesk. Defensive fix: add `font-family: var(--font-mono)` to `.traits`. Effort: 1 line.

**L6 — `web/components/PlanetSprite.tsx`** is pure canvas; the *positioning chrome* concern in the brief refers to the `.rarityRow` / `.pickBadge` containers, which live in `OwnedPlanets.tsx` and use the canonical classes. Verified clean.

---

## 3. Recommended PR plan

Five small commits, sequenced so each compiles cleanly on its own:

1. **`web: drop GalaxyMap rounded canvas + use system tokens`** *(High, ~10 min)* — fixes H1, H2, H3, H4, M7 in one focused commit since they all touch GalaxyMap.tsx + globals.css. Drop `borderRadius: 8`, swap canvas font stacks to JetBrains Mono with `document.fonts.ready` gating, replace `#ff85c4` / `#0a0b1a` with comments naming the tokens, delete `--hover-lift`.

2. **`web: retire legacy --dim/--bg/--panel/--ink/--accent aliases at call sites`** *(Medium, ~15 min)* — fixes M2, M3 and proactively sweeps any other inline uses (`grep -r 'var(--dim\|--bg\|--panel\|--ink\|--accent)' web/`). Leave the alias block in `globals.css` for one release as a deprecation cushion, then remove it in a follow-up.

3. **`web: flatten planet-view canvas frame`** *(Medium, ~5 min)* — fixes M1. Replace padding+outline with inset hairline box-shadow so the pixel scene touches the slab edge.

4. **`web: extract .vitalTrack class; route inline spacing through var(--space-*)`** *(Medium, ~20 min)* — fixes M4, M6, L1, L2. Adds a `.vitalTrack` rule to `globals.css`, switches `OwnedPlanets.Vital` to use it, and walks `page.tsx` / `OwnedPlanets.tsx` / `GalaxyMap.tsx` swapping integer margins for `var(--space-*)`.

5. **`web: name tier-glow recipe; tidy Traits font-family`** *(Low, ~10 min)* — fixes M5, L4, L5. Extract `tierGlow()` helper, drop redundant `.toLowerCase()`, set `.traits { font-family: var(--font-mono) }`.

Total effort: **~1 hour** of careful editing plus a Playwright pass at three widths (1280/768/390) per commit to confirm nothing snapped.

---

## Closing observation

The port is in good shape overall. The shell (`globals.css`) is internally consistent and rigorously brutalist; the seven dedicated classes (`.panel`, `.card`, `.modal`, `.option`, `.walletChip`, `.careBtn`, `.rarityBadge`) all carry the right shapes, fonts, shadows, and radii. The actual non-compliance is concentrated in **one** file — `GalaxyMap.tsx` — which renders most of its chrome inside a `<canvas>` and so escapes the global CSS by design. That's the one component that needs a real pass; the rest is shallow alias-sweeping that the previous agent explicitly left for a follow-up.
