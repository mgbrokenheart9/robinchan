# Robinchan — Design Direction

**Companion-forward** · character: Zundamon (VOICEVOX Live2D sample model) · derived from `robinchan-dev-brief.md` · 21 September 2026

This file translates the dev brief's design tokens and layout rules into a concrete visual direction for implementation. It is a working spec, not the final artboards — when Bix shares the canvas (`Main.dc.html`, `Character.dc.html`, `Market.dc.html`, `Mobile.dc.html`), those are the source of truth for exact spacing/sizing. This doc governs everything the artboards don't pin down: motion, personality, and how the character's presence should read across the whole shell, not just the `/robinchan` page.

---

## 1. Direction

**Companion-forward, anchored to Zundamon.** With the character now picked — [Zundamon](https://www.live2d.com/en/learn/sample/zundamon/), the free VOICEVOX mascot — the companion-forward direction isn't just a stylistic choice, it's a match to the character's actual design:

- Zundamon's palette is green-and-white with pink as a warm secondary accent (rosy cheeks, ribbon, boot soles). The brand accent was originally `#7BE07B` to match; it was changed to lime `#D4F450` (Primary Green) on 2026-09-24 at the owner's request. `accent-ink` moved to `#1C2600` to stay a dark tone of the same hue.
- Her silhouette is soft, round, "mochi"-like, with rounded overalls, puffed sleeves, and edamame-pod-shaped ear antennae — this directly supports the pill/rounded-card language in §2 below, rather than being decoration layered on top of an unrelated shape system.
- She's a chibi/mascot character: approachable and cheerful, not slick or corporate. The UI shell can afford real warmth (§3–§5) precisely because the data itself (prices, quotes, order state) stays strict and monospace — the contrast is what makes the character read as charming rather than the app read as unserious.
- **Bonus alignment**: the brief already specifies VOICEVOX as the TTS engine (§2, §11 of the dev brief) — Zundamon *is* the VOICEVOX mascot. Lip-sync and voice output were always going to be tuned for VOICEVOX's cadence; pairing it with Zundamon's own model means the voice and the face were built for each other, not stitched together after the fact.

The balance to hold: playful shell, serious numbers. Never let motion or ornamentation delay or obscure a price, a quote countdown, or an order confirmation.

---

## 2. Design tokens

Pulled directly from the brief — do not deviate without a reason recorded here.

```ts
// tailwind.config.ts
colors: {
  bg: '#0A0A0A',
  surface: '#111111',
  'surface-2': '#151515',
  border: '#242424',
  'border-soft': '#1C1C1C',
  text: '#FFFFFF',
  'text-2': '#9C9C9C',
  'text-3': '#6E6E6E',
  accent: '#D4F450',
  'accent-ink': '#1C2600',
  up: '#6EE787',
  down: '#FF8080',

  // Companion accent — decorative only, see note below
  'companion-pink': '#FFB6C1',
}
```

**Light and dark themes (2026-09-24).** The values above are now the *dark* theme. The site ships a light theme as the default, following the owner's Robinchan brand board, with a switch (`<ThemeToggle>`) in both headers and on the `/robinchan` toolbar; the choice persists in `localStorage` (`robinchan-theme`) and a pre-paint script in the root layout applies it without a flash. The OS preference is deliberately ignored — light until the visitor picks dark.

Tokens are CSS variables (`--c-*`, bare RGB channels) defined in `globals.css` on `:root` (light) and `.dark` (dark); `tailwind.config.ts` reads them as `rgb(var(--c-x) / <alpha-value>)`, so opacity modifiers keep working. Light values:

| Token | Light | Note |
| --- | --- | --- |
| `bg` | `#F8FAF6` | Background |
| `surface` / `surface-2` | `#FFFFFF` / `#EDF3EC` | Cards / raised or hover |
| `border` / `border-soft` | `#E5EDE7` / `#EDF3EC` | |
| `text` / `text-2` / `text-3` | `#1F2937` / `#4B5563` / `#9AA3B8` | Primary / secondary / muted |
| `accent` | `#D4F450` | Fill only — buttons, bars, dots |
| `accent-fg` | `#4D7C0F` | New. Brand color as *text or outline*; the fill lime is ~1.2:1 on white. Equals `accent` on dark |
| `accent-2` | `#A3E635` | New. Secondary green |
| `accent-ink` | `#1F2937` | Text on the lime fill |
| `up` / `down` | `#22C55E` / `#EF4444` | |
| `warning` / `info` | `#F59E0B` / `#3B82F6` | New |
| `overlay` | `#1F2937` | New. Hairlines/washes on a surface — white on dark, ink on light (replaces hard-coded `white/10`) |

Glass panels (`.card-glass`) and the `.text-on-media` halo take their values from `--glass-*` / `--media-text-shadow`: a smoked pane with a dark halo on dark, frosted white with a light halo on light. Scrims over footage (hero, Live2D stage vignette) wash toward `--c-bg`, so the hero reads pale-with-ink-copy on light and dark-with-white-copy on dark.

**On `companion-pink`.** This is new, not in the original brief token table — added because Zundamon's design uses pink (ribbon, cheeks, boot soles) as her only non-green/white accent. Scope it tightly:

- Allowed: the `/robinchan` page's character-adjacent chrome (ribbon-shaped tier badge accents, a small blush highlight in the stage card's idle state, the chat panel's send-button hover if it needs to feel distinct from the accent green elsewhere)
- Not allowed: anything semantic (never near `up`/`down`), anything on `/market`, anything that could be confused with a price or status signal
- If in doubt, don't use it — `accent` alone is always the safe default, and this exists purely to let Zundamon's own coloring show through in one or two character-specific spots, not to become a second brand color

**Typography**

| Role | Font | Notes |
|---|---|---|
| Heading | Space Grotesk | Slightly wide tracking on large headlines for personality |
| Body | Instrument Sans | Default UI text |
| Numeric | JetBrains Mono | Prices, tickers, timestamps, addresses — always tabular-nums |

**Radius — companion-forward adjustment**

The brief specifies 20px large / 14–16px small / 999px pill. Under companion-forward direction, push toward the top of those ranges rather than the bottom, and prefer pill shapes for anything interactive (buttons, tabs, badges, tier chips) rather than rounded rectangles — this now has a direct source: Zundamon's own rounded, mochi-soft silhouette. Data-table rows and dense list items stay sharper (8–10px) so the Market page doesn't feel mushy under a wall of numbers.

**Glow/accent usage**

- Active nav item: 1px accent border + faint accent glow (`box-shadow: 0 0 24px rgba(212,244,80,0.15)`), not just a bg fill
- Live/streaming indicators (video badge, "quote live" countdown): soft pulsing accent dot, 2s ease-in-out loop, respects `prefers-reduced-motion`
- Order preview card's sign button: accent fill with a subtle glow on hover, not a flat color swap

---

## 3. Shell (sidebar + topbar)

- Sidebar 248px, topbar 76px, shared layout — as specified in the brief.
- Sidebar active-item indicator: pill-shaped highlight behind the icon+label, not just a text color change — this is where companion personality shows up in daily navigation.
- Disabled items (`/trade`, `/heat`, `/portfolio`): visible but at `text-3` opacity, no hover state, small "Soon" pill badge in `border` color — communicates "coming," not "broken."
- Below 1024px: sidebar becomes a drawer. Drawer open/close transition should feel soft (spring-ish ease, ~250ms), matching the companion tone — not an instant snap.
- Optional detail: a small static Zundamon glyph (just the ear-antenna/edamame-pod silhouette, not the full character) as the sidebar's `/robinchan` nav icon, so the character's motif is legible even collapsed. Keep every other nav icon plain/geometric — one character touch, not a theme applied to all icons.

---

## 4. Home (`/`)

Direction: the hero and feature blocks get the most personality; the data-driven cards (Market panel, Heat board) stay closer to terminal-clean since they're carrying real numbers.

- **Hero**: headline in Space Grotesk, generous line-height, badge pill with a small pulsing accent dot ("Live on Robinhood Chain" or similar status copy). Two CTAs — primary filled pill in accent, secondary ghost/outline pill. If a hero illustration is used, a small/cropped Zundamon pose (not full-body, keep it light so the hero still reads as a serious product) is the one place on this page her actual likeness could appear outside `/robinchan`.
- **Market snapshot panel (412×384px)**: terminal-clean card, sharper internal rows, but the card *shell* itself gets the 20px+ radius and a soft border glow so it doesn't feel like a foreign object next to the softer hero.
- **"Ngobrol, jadi order" demo card**: this is the best place for companion personality — chat bubbles rounded and soft, a small static Zundamon avatar/icon next to her chat lines, playful copy in the fake conversation. It's static, so it can afford to be the most "designed" card on the page.
- **Heat board**: bars use accent-to-down gradient per score tier rather than a flat bar, rounded pill-track.
- **Marquees**: gradient-masked edges, pill-shaped ticker chips (not square), soft border glow on the chips carrying positive movement.
- **Feature cards / capital-flow strip / footer**: stay simple and static as the brief specifies — don't over-decorate content that never changes.

---

## 5. Robinchan (`/robinchan`)

This page is the anchor for the whole direction — everything else takes its cue from here, at a lower intensity.

- **Live2D stage card**: the most rounded, softest-edged card on the site. Idle-state skeleton should be a soft breathing/pulsing placeholder in `accent` (not gray) — it should already feel alive before the model loads. A nice, cheap detail given the source character: three small soft dots arranged like an edamame pod as the loading indicator, instead of a generic spinner.
- **Expression-linked UI**: when Zundamon's expression changes (`senang`, `fokus`, `waspada`, `santai`), a very subtle ambient shift in the stage card's border glow color/intensity — e.g. `waspada` = slightly warmer glow (can lean toward `companion-pink` at low opacity), `santai` = softer/dimmer accent glow. Small enough to be a nice detail, never so strong it competes with the chat.
- **Chat panel**: rounded message bubbles, generous padding, streaming-token cursor styled as a soft accent blink rather than a plain caret. Her avatar in the message list can use a small ribbon/pink accent ring, consistent with her actual design, without it becoming a competing color in the chat itself.
- **Order preview card embedded in chat**: even though this is the most "serious" component on the page, keep its card radius consistent with the surrounding chat bubbles so it doesn't look like a jarring institutional insert. The countdown timer can use the pulsing-dot pattern from the Home hero badge. No character theming here — this card should look identical whether or not the user notices Zundamon is in the room.
- **Tier cards**: three pill-badged cards, locked state uses a soft blurred/dimmed treatment with a small lock glyph, not a flat gray overlay — locked should feel like "not yet," not "broken." The "Suara" (voice) tier card is the natural place for a small VOICEVOX/Zundamon voice-waveform icon, tying the tier directly to the character's own voice.

---

## 6. Market (`/market`)

This page stays closest to terminal-clean — it's the highest-density, most numbers-per-pixel screen. The character choice doesn't change this page's direction at all: no Zundamon imagery, no `companion-pink`, no extra motion beyond what's already specified. Density and trust matter more here than anywhere else in the product.

- Index strip, feed, and "sumber yang dipantau" grid: sharper corners (8–10px), tight spacing, monospace numerals throughout.
- The one place to let personality in: the **tape** (marquee headline strip) and the **video channel tabs** — pill-shaped, accent-highlighted active tab, small live-pulse dot next to "LIVE."
- Sentiment dots (green/red/gray): slightly larger than a typical status dot, soft glow on green (positive) only — reinforces the accent-heavy palette without touching the red down-color's clinical/warning read.
- Stale-data state: dim text as specified in the brief, and add a small pill badge ("stale") near the timestamp rather than relying on color dimming alone — keeps it legible and on-brand with the pill-heavy UI language used elsewhere.

---

## 7. Shared components — design notes

| Component | Companion-forward treatment |
|---|---|
| `<Marquee>` | Pill-shaped chips inside the track, gradient edge masks, respects `prefers-reduced-motion` (per brief) |
| `<Live2DStage>` | Soft/rounded card frame, breathing skeleton state (edamame-pod loading dots), optional ambient glow tied to expression |
| `<ChatPanel>` | Rounded bubbles, soft accent streaming-cursor, small pink-ring avatar treatment consistent with the character, never bleeding into message content styling |
| `<OrderPreviewCard>` | Radius matches surrounding context (chat bubble radius on `/robinchan`, slightly sharper if reused on `/trade`); countdown uses pulsing-dot pattern; no character theming — never sacrifices legibility of numbers for style |
| `<TickerCard>` / `<NewsCard>` | Pill category badges, soft glow on positive-sentiment items only, monospace for all numeric/time fields |

---

## 8. What NOT to do

- Don't apply glow/pulse effects to more than one element at a time within a single card — it reads as noisy, not alive.
- Don't soften the Market page to match the Home/Robinchan warmth — density and trust matter more there.
- Don't let character-driven motion block or delay: quote countdowns, sign-button state, streaming chat tokens, or price updates. Personality is decorative; correctness and speed are not negotiable (ties back to the brief's non-custodial / user-decides-last principle).
- Don't let `companion-pink` migrate beyond the scope in §2 — it's a one-character accent, not a second brand color.
- Don't put Zundamon's likeness on `/market` or inside `<OrderPreviewCard>` anywhere it's reused (e.g. future `/trade`) — those surfaces should look the same with or without the character theme.
- Don't hardcode the Live2D model or its expression-glow mapping — keep it reading from `LIVE2D_MODEL_URL` as the brief specifies, so the visual system survives an asset swap if the Zundamon asset can't clear licensing (see §9).

---

## 9. Open items

- **Waiting on Bix's actual canvas** (`Main.dc.html`, `Character.dc.html`, `Market.dc.html`, `Mobile.dc.html`) for exact pixel values — this doc should be reconciled against those once shared, not treated as a replacement for them.
- **Character license — now concrete, not generic.** The brief (§15, open decision #7) already flags that Live2D character/TTS licensing needs clearing before shipping final assets; with Zundamon specifically chosen, there are two separate things to verify before this ships to production, not one:
  1. The model file at `live2d.com/en/learn/sample/zundamon/` is published by Live2D Inc. as a **sample model** for testing tracking software — sample models are commonly licensed for demos/streaming but may explicitly restrict embedding in a commercial product's UI. This needs checking against Live2D Inc.'s own terms for that specific download, separate from the character IP itself.
  2. Zundamon as a character belongs to the **Tohoku Zunko / Zundamon Project**, which publishes its own character usage guidelines (separate from the Live2D file license) — commercial use, especially in a product tied to a token launch and real trading, likely needs its own review against those guidelines.
  Until both are confirmed, keep `LIVE2D_MODEL_URL` swappable (already required by the brief) so M1–M3 can proceed with this model as a placeholder without blocking on legal clearance.
- The "expression-linked ambient glow" idea in §5 and the `companion-pink` token in §2 don't depend on final art clearing — they're safe to build now. Anything that renders Zundamon's actual likeness (hero illustration in §4, sidebar glyph in §3, chat avatar in §5) should be treated as placeholder-swappable until §9's licensing items clear, same as the stage model itself.

---

## 10. Home gets its own layout, not the dashboard shell

Amendment, added post-M1/M2 build. Home (`/`) has moved off the sidebar+topbar shell in §3 and onto a dedicated marketing layout. The dashboard shell still applies to `/robinchan` and `/market` exactly as before — this section only concerns `/`.

**Why.** A landing page's one job is to get a first-time visitor to understand and trust the product in one scroll. A 248px sidebar reserving space for `/trade`, `/heat`, `/portfolio` — pages that don't exist yet — works against that; it makes Home look like a workspace someone already committed to, not an invitation. Splitting the shell is a routing-level change (Next.js route groups: `(dashboard)` wraps `/robinchan` and `/market` in `<AppShell>`; `(marketing)` wraps `/` in a plain top nav), not a fork of the design system — both shells share the same color tokens, type scale, and `.page-container` width (1112px), so navigating between them doesn't feel like leaving the product.

**What the marketing shell gets that the dashboard doesn't:**

- **`<LandingHeader>`** — a sticky top nav, transparent over the hero and picking up a solid blurred background once scrolled past it. Logo left, `Robinchan` / `Market` links, one primary CTA ("Launch app" → `/robinchan`). No wallet-connect placeholder, no "Soon" items — those belong to the workspace, not the pitch.
- **A full-bleed hero backdrop** — a slow WebGL fiber field behind the hero content only (`<HeroBackground>`, recoloring React Bits' GhostFibers to accent-green lines and a companion-pink glow, tuned well below its own out-of-the-box defaults — fewer layers, slower motion, lower brightness — and blended in at 60% opacity so it stays peripheral rather than competing with the headline). This is the one place on the whole product a decorative background effect is allowed, and the one place `companion-pink` is allowed outside strictly character-adjacent chrome (§2) — it's brand-mood, not a UI signal. It fades to flat black before the next section so it reads as "hero backdrop," not a site-wide tint, and fails silently (no background, not an error state) on a browser without WebGL2 — it's decoration, not the product, so it doesn't get the Live2D stage's explicit fallback UI.
- **Scroll-triggered entrances** — `<Reveal>` (`lib/useReveal.ts`, an IntersectionObserver hook, fires once) fades and rises each section into view as the visitor scrolls: the chat-demo/heat-board row, the marquees, the feature cards, capital flow. The hero itself uses a one-shot mount animation (`animate-hero-in`, staggered per element) instead, since it's already on screen at load — nothing above the fold should make a visitor wait for it to animate in. Every one of these motions is a plain CSS `transition`/`animation`, so the existing global `prefers-reduced-motion` rule (§8, and the one in `globals.css`) neutralizes all of it automatically — no separate reduced-motion handling needed per component.
- **`ember` (`#F2A65A`)** — one new supporting color, marketing-layout-only. Used on exactly one of the three feature cards (the middle one) so the row reads as three distinct ideas instead of three copies of the same green card, without turning into a second general-purpose brand color the way §2 already warns against for `companion-pink`. It does not appear on `/market` or `/robinchan`.
- **Hover feedback everywhere a card or step is a real destination or a real idea** — feature pillars pick up their tone color on hover; capital-flow steps highlight on hover. None of this touches `/market` or the dashboard's data-driven cards — those still follow §6/§8 exactly as written.

**What does NOT change:** the dashboard shell (§3), the Market page's terminal-clean density (§6), the Robinchan stage and chat treatment (§5), and the restraint rules in §8 — all of that still governs `/robinchan` and `/market` unmodified. This section only grants Home the room the rest of the product deliberately doesn't get.

### 10.1 Landing-page scale

Second amendment, after an audit of the built page. The split in §10 gave Home its own shell but left it wearing the dashboard's typography and spacing, so it still read as a workspace screen with a nav bar swapped in. Four changes, all scoped to the marketing route:

- **A display scale that only Home uses.** `.t-display` now runs to 100px (from 56px), and three marketing-only classes join it: `.t-section` (section headings, to 48px), `.t-stat` (proof-band numerals, to 64px), `.t-lead` (hero and CTA lead paragraphs). These are deliberately *not* changes to `.t-h2`/`.t-h3`, which are shared with `PageHeader`, `TierCards`, and `/robinchan` and must stay small there. **Tracking inverts at this scale:** §2's "slightly looser tracking on large headlines" (+0.006em) was written for a 56px ceiling and still holds there, but past roughly 72px it reads as gaps between letters, so `.t-display` and `.t-section` run negative instead.
- **The hero headline spans the full container**, with the lead/CTA/market-panel row beneath it, rather than sitting in the artboard's 660px left column. At 100px that column would break "Read the market." across two lines and cost the copy its three-beat rhythm. `<HeroBackground>`'s band is now per-breakpoint (380px / 620px) because the headline it covers is ~118px tall at the mobile floor and ~294px at the desktop ceiling.
- **Section rhythm (`.section-y`, 72–144px) and section headings.** Home previously ran `py-4` between blocks and gave most of them no heading at all, so the feature row and marquees read as stacked widgets rather than as an argument with parts. `<SectionHead>` (eyebrow, statement heading, optional aside for the caveat) now introduces each one.
- **Varied treatment per section, instead of `card` everywhere.** A page where every block has identical chrome gives a reader no way to tell the thesis from the footnote. The feature block drops to numbered hairline rules (01–03); the stat band and capital flow are tile grids (originally hairline-separated, changed to separated glass tiles in §10.2); the closing CTA is the only other block allowed a decorative wash, and it's static — the hero keeps the page's one *animated* background.

**On the proof band.** Landing pages in this category lead with headline metrics — TVL, 24h volume, holders. Robinchan is pre-launch and has none, and fabricating them would be a lie printed at 64px. `<StatBand>` states what the system verifiably *is* instead: keys stored (0), symbols tracked (13 = `WATCHED_SYMBOLS` + `INDEX_SYMBOLS`), price refresh (20s, the `prices` job interval), feeds running (6 scheduled collectors, excluding `retention`). **Every figure there is read off the code and carries a comment saying where — anything added to that band later must clear the same bar.**

---

### 10.2 Glass surfaces on Home

Third amendment. Home's panels use a translucent glass treatment (`.card-glass`); `/market` and `/robinchan` keep the flat opaque `.card`.

**Why it's a separate class, not a change to `.card`.** Dense data tables need an opaque surface — translucency behind a price grid costs contrast exactly where the numbers have to stay readable, and §8's restraint rules still govern those pages. `.card` is untouched.

**Glass needs something behind it, or it isn't glass.** `backdrop-filter` samples and blurs whatever is painted behind the element; blurring flat `#0A0A0A` returns flat `#0A0A0A`. The hero has the GhostFibers canvas behind it and works for free, but every section below it sat on bare background, where the filter was an expensive no-op. `<AmbientField>` supplies that backdrop. **It is a material requirement of the treatment, not decoration — if the blob field is ever removed, the glass has to go with it.** It is also the one place §10's "decorative backgrounds belong to the hero alone" is relaxed; that rule still holds for anything *animated*, and this is static and subordinate.

**The effect is a comparison, not a texture.** This took three attempts and the two failures are worth keeping on record, because both look reasonable on paper:

1. *Faint smooth gradients (4–7%).* Blur only visibly alters high-frequency detail, so a blurred smooth gradient is the same smooth gradient. The opacities also moved the background by under 20 RGB values. Net result: a `#1B221B` card instead of a `#111111` one, with a filter running for nothing.
2. *A fine 56px rule grid.* Right in principle — it gave the blur real edges to destroy — but it reads as a visible design motif of its own, and a 1px line at 5% white has nowhere near the luminance range to survive a darkened pane.

What works is what every reference glassmorphism composition uses: **large, bright, saturated shapes that cross the panel's edge.** The eye reads "glass" because the same blob is crisp and vivid just outside the border and soft and muted just inside it. With no shape spanning that boundary there is nothing to compare, and the panel is only a tinted rectangle. Hence: rotated capsules in the brand hues with near-white cores, blurred 14–28px — *lightly*, because the panel's own 40px blur needs headroom to take something away. **The gap between the blob's blur and the panel's blur is the effect.** Matching them flattens it.

**The pane is dark, not white.** The other correction that made it work. A panel built only from white overlay gets *lighter* than its surroundings — that's frosted acrylic over a light page, not a smoked pane over a dark one. In the reference compositions the card area is visibly darker and less saturated than the shapes passing behind it. So `.card-glass` is `rgba(10,10,10,0.45)` with a white sheen on top, and `saturate()` runs below 100% at the blur. This also does the legibility work: body text sits on this while near-white blob cores pass behind it.

**Blob placement has to respect non-glass text.** `<FeatureCards>` is the one block with body copy sitting directly on the background instead of on a panel, so there is no darkened pane there to protect contrast. The blobs in that zone are held at ~0.2 opacity against 0.36–0.55 elsewhere. Anything added to that section later either needs a panel or needs the blobs behind it kept down.

**Divided slabs can't be glass.** `<StatBand>` and `<CapitalFlow>` previously drew hairline dividers with the `gap-px` trick — an opaque cell grid over a `bg-border-soft` parent, with the parent showing through 1px gaps. Translucent cells let that parent fill show through the cells as well, tinting every tile with the divider color. Both now use separated tiles with real gaps.

**Two details that carry the edge.** The `inset 0 1px 0` top hairline reads as light catching a lit edge, and the `inset 0 -1px 0` dark one reads as the thickness of the pane. Without them a translucent panel is a flat tint with a border.

**Fallback is a legibility requirement.** Under `@supports not (backdrop-filter)`, `.card-glass` falls back to opaque `bg-surface` — a translucent dark pane with no blur behind it puts body text over near-white blob cores, which is a contrast bug, not a cosmetic downgrade. The fallback must also clear `background-image`, since the sheen gradient would otherwise paint straight over the opaque fill, and it must override the hover state, or an opaque fallback card darkens on hover instead of lightening.

**Not converted:** marquee chips (continuously animated — backdrop-filter on scrolling elements is a real per-frame cost), `<OrderPreviewCard>` nested inside the chat demo (glass on glass muddies; inner elements sit *on* the glass), and `<FeatureCards>`, which is numbered hairline rules with no panel at all. `<MarketSnapshot>` dropped `shadow-glow-soft`: it's a utility, so it beat `.card-glass`'s `box-shadow` in the cascade and took the inset highlight with it.

---

### 10.3 Video backdrops

Fourth amendment. Two surfaces now use looping video behind their content: the Home hero (`hero.mp4`) and `/robinchan` (`stage-1.mp4` / `stage-2.mp4`, crossfading on a 15s hold with a 2.5s fade). Both go through `<VideoBackdrop>`, which owns the treatment and the motion policy. `/market` has none.

**The footage is the inverse of the product's surface.** It's bright, sunlit, high-detail and pale sage-green; the UI is near-black with white text. Nothing uses it untreated. `filter` on the video element crushes brightness and saturation, and a `scrim` gradient takes specific regions fully to background color. Because `filter` applies to the poster image as well as decoded frames, the treatment is identical before and after load — no bright flash on a slow connection.

**The embedded fake data must stay unreadable.** All three clips contain *legible fake tickers and invented percentage moves* — readable symbols with readable numbers beside them. This product renders real market data, and on `/robinchan` it renders it on the same screen. A decorative number a user can read is a number they can mistake for live data. **This constraint is permanent; the mechanism that satisfies it is not.**

The first pass satisfied it with blur alone — `blur(3px)` on the hero, `blur(10px)` and `brightness(0.22)` on `/robinchan`. That worked and looked like nothing: both plates were so far under the floor they read as grey murk, which defeated the point of using footage at all.

The two surfaces now solve it differently, because they can:

- **Hero: cropped, not blurred.** The offending board occupies the top ~20% of `hero-video.mp4`, so `hero.mp4` is encoded from `crop=1920:864:0:216` with that strip removed. What's left is architecture, light, and slogan text — "GOOD TRADERS BETTER PEOPLE" is a mood line, not market data, and can stay sharp. That buys back `brightness(0.62)` and drops the blur to `2px`, which only has to cover chart *shapes* on the desk monitors. **Any recrop of this file must keep the top strip out of frame**, or the blur has to go back up.
- **`/robinchan`: still blur.** These clips can't be cropped clear — bg-vid1's ticker ribbons and bg-vid2's board *are* the composition. `blur(6px)` is still well past the point where the figures resolve, and is enough to allow `brightness(0.45)`. **Do not take that blur below ~5px.**

**Darkening the plate is the wrong lever for text contrast.** The first pass darkened globally so that text placed anywhere would be safe, which is what made the footage invisible. `.text-on-media` (two text-shadows, one tight for edge definition, one wide and soft) buys the same contrast locally at the glyph edge, leaving the rest of the frame alone. It's applied to the hero's badge, headline, and lead, and — via a wrapper, since `PageHeader` is shared with `/market` and shouldn't carry it — to `/robinchan`'s header and tier heading.

**Scrims are directional, not uniform.** The hero footage is dark at the top (arches, banners) and bright at the bottom (a polished floor), which is inverted from where the hero needs contrast: the headline sits high-left where the plate is already dark, the lead and CTAs sit low-left over the brightest part. So the hero scrim weights left and down and leaves the upper right nearly clear, which also gives the `MarketSnapshot` glass panel something worth refracting. `/robinchan` adds a vignette; without one the plate is an even wash edge to edge and reads as flat texture rather than depth.

**Reduced motion has to be handled in JS.** The global `prefers-reduced-motion` rule in `globals.css` neutralizes CSS animations and transitions; it does nothing to a playing `<video>`. A looping video is decorative motion under brief §7 and §8, so `<VideoBackdrop>` renders *without* `autoPlay` and starts playback from an effect only when the query doesn't match, listening for changes. Users who ask for reduced motion get the poster frame, treated identically, as a still. `<StageBackdrop>` additionally stops its rotation interval — otherwise the neutralized CSS transition would turn each crossfade into an instant cut every 15 seconds, which is worse than the fade it replaced.

**Encoding.** Sources were 1920×1080 at ~4.2MB each. Shipped as 1280×576 (hero, cropped) and 960px (stage) H.264 with audio stripped and `+faststart`: 12.6MB → 1.8MB total. The stage clips can afford the lower resolution precisely because they're blurred. Posters are small JPEGs from frame 0 and are *not* pre-darkened — the element's `filter` applies to the poster too, so treating it twice would make it darker than the video it stands in for.

**The hero plate covers the whole section**, not a band at the top of it. The earlier `h-[380px] lg:h-[620px]` band existed to keep the fiber field off the CTA row; with a cropped, scrim-shaped video there's no reason to stop it short, and a band that ends mid-hero reads as a seam. One consequence: the cropped file is 2.22:1, so on a narrow viewport `object-cover` shows a narrow centre slice of the hall rather than the full composition.

**This replaced GhostFibers** as the hero backdrop. Running a WebGL fiber field and a video decode behind the same 620px band means two effects competing rather than layering. `components/effects/GhostFibers.tsx` and the `ogl` dependency are now unreferenced; nothing imports them, so they carry no bundle cost, but they are dead code.

**Panels stay opaque over video.** On `/robinchan` the `.card` surfaces are unchanged, so the backdrop only shows in the gutters and behind `PageHeader` — whose lead copy sits directly on it, which is what sets the brightness ceiling there.

---

## 11. Heat, Portfolio, Trade

The three dashboard pages from the Trade / Heat / Portfolio brief. They follow §6's terminal-clean rules (opaque `.card`, sharp rows, mono numbers) and both themes; this section records only what's new.

**The four data states are a visual contract.** Loading is always a skeleton with the content's own row heights (a skeleton of a different size makes the layout jump, which reads as cheap). Empty says why and offers one action. Error is one sentence and a retry, never a code. Stale keeps the content, dims it (`.is-stale`) and adds the `stale` pill next to "updated …" — dimming alone isn't enough (§6).

**Locked reads as "not yet", not "hidden".** A gated heat row is drawn as its own silhouette — blurred placeholder bars, no real text, because the server sends none — with a `<TierLockLabel>` pill ("Connect wallet", "Tier 1", "Tier 3"). The same pill marks the Watchlist chip, the Limit tab, and the triggers/read blocks of an opened row. A page that needs a wallet (Portfolio, the Trade ticket) shows its real layout with sample data at `blur(5px)` and one centered card with the connect button, per the brief.

**Components are three mini-bars, and inactive is a dashed track.** A null component (social until phase 3) is an empty dashed outline with "not active yet" — never an empty solid track, which would read as "no activity". Filled component bars use `accent-fg`; the heat bar itself is `up` (mint), as the brief asks.

**Buy is mint, sell is salmon — as tints.** The side toggle uses `up`/`down` at 15% with a 40% ring; the action button uses `up` at 90% / `down` at 80% so the light theme's `#EF4444` softens toward salmon instead of alarm red.

**The quote countdown lives in the sign button**, right-aligned in mono; the last ten seconds swap it onto a `warning` pill. At zero the button becomes "Refresh price". Nothing else on the ticket pulses (§8: one live signal per card).

**Charts read the theme at runtime.** `lightweight-charts` draws on canvas, so `useThemeColors` reads `--c-*` off `<html>` and re-applies on the `.dark` flip. Candles and the volume histogram use `up`/`down`; resting limit orders are dashed price lines in the same colors; the portfolio line is one mint line with a thin gradient. The library's logo is off and credited in text under each chart instead.

**Robinchan's dock is small and stays out of the way.** A 56px avatar, bottom-right, on Heat, Portfolio and Trade only — `/market` keeps no character likeness (§6), and no likeness goes inside `<OrderPreviewCard>` (§8). Her unprompted line is a single truncated pill *beside* the avatar, so it can't cover the order ticket; it fades after nine seconds. The chat panel opens above the avatar and says what she can see ("sees: Trade · NVDA").

---

## 12. Perps

`/perps` replaces Trade (Agri Perps brief); `/trade` redirects there. It keeps §11's rules — the four data states, the connect gate with blurred sample data, the countdown in the sign button — and this section records only what's new.

**Three categories, one board.** Agri · Crypto · Stocks tabs sit over a single board, each tab counting its live markets. The markets Chainlink has no feed for on Robinhood Chain — all nine agri markets, SOL and ARB — stay on the board, dimmed, with a "No oracle" pill; the header says why in one sentence. Dropping them would read as a bug next to a brief that lists them. The page opens on BTC.

**Status is a pill, and only "Open" moves.** Open carries the mint pulse dot, the card's one live signal (§8). Closed shows the last price in `text-2` with the reason — a stock's weekend, or a feed silent past its daily heartbeat — and the market's hours. A Chainlink price hours old is normal (a round comes on a 0.5% move), so age alone never closes a market. Close-only covers a paused or delisted market.

**Long is mint, short is salmon**, as tints like §11's buy and sell: 15% fill with a 40% ring on the toggle, `up` at 90% and `down` at 80% on the action button.

**Leverage is a slider with the market's own stops**: 1 / 5 / 10 / 20 for crypto, 1 / 3 / 5 for stocks. The value sits beside the label in mono `accent-fg`. From 20× on, the quote says in words how small a move liquidates.

**The header names the feed** behind the price ("Chainlink ETH / USD") in the stats row, with a tooltip on how it updates. The chart carries each Chainlink round forward to the next, as positions are marked; a stock's weekend leaves a gap.

**The two steps of an on-chain order are told in the button, not a tooltip.** The progress line walks through the wallet's transactions ("Approve USDC", "Open long ETH"), then says "Request landed. It fills at Chainlink's next ETH price — when the price moves 0.5%, or within a day." until the keeper fills it. That can take hours, so a waiting order also lives under a **Waiting** tab beside Positions, where "Take back" first says what it costs ("You get the collateral back; the $0.50 opening fee is kept") with *Keep it* and a salmon *Take it back* — then asks the wallet; the row then reads "Asked back: released by 14:05, unless its price was already observed." A cancelled order says why in a sentence: price past the limit, taken back, never priced in its window, or the feed moved to a new aggregator.

**The liquidation price is salmon** in the positions table, beside PnL (mint or salmon) and funding. A position with a close on its way shows a `warning` "closing…" pill where its close button was.
