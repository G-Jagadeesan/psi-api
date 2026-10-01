# AGENT_GUIDE — using `psi-api` to optimize a page

This guide is for an **autonomous agent** driving a page toward a performance target, and for the human supervising it.

Read it end to end before your first run. The short version:

> Measure with 10 runs. Pick the biggest failing insight. **Read `sop-qwik.md` and obey it.** Make one small change. Open the page's staging PR, then wait 10 minutes and poll that PR every minute until the deploy settles — PSI measures a live public URL, so an undeployed change is not measurable. Measure again. Keep it only if the improvement beats the noise. Otherwise revert.

The tool is read-only to you. You use it; you do not modify it.

---

## 0. Orientation

| | |
| --- | --- |
| Tool root | `psi-api/` |
| Human docs | `psi-api/README.md` |
| **Binding rules** | `sop-qwik.md` in the repo root — **read in full before your first code change** |
| Same rules, repo form | `qwik-guvi/CLAUDE.md` (read it if you prefer the app-repo version) |
| App rules, condensed | **Step 4 → "App rules a performance fix must not violate"** in this guide |
| Targets | `psi-api/config/targets.json` |
| Your log | `psi-api/data/<host>/optimization-log.md` (create it if absent — see Step 10) |
| App being optimized | `qwik-guvi/` |

`sop-qwik.md` and `qwik-guvi/CLAUDE.md` carry overlapping content; where they differ, `sop-qwik.md` wins. This guide reproduces the parts of them that change what a Lighthouse-driven agent would otherwise get wrong, so you do not have to hold the whole SOP in your head mid-loop — but it is a subset, not a replacement. Read the SOP.

Two rules that outrank everything else in this document:

1. **`sop-qwik.md` governs every change you make to the app.** This guide only tells you *how to measure*. It never authorizes a change the SOP forbids or does not cover.
2. **`psi-api/` is read-only during optimization.** You may append to the optimization log. Nothing else.

---

## 1. The loop

### Step 0 — Find the report you are working from

Every command that does not spend quota takes `--reportId <id>`. A baseline you measured in an earlier session has an ID you no longer have in front of you, and the directories are the only index — there is no CLI flag or endpoint that lists reports.

```bash
cd psi-api
# newest first; report ids are <ISO timestamp>-<strategy>, so they sort chronologically
ls -1t data/<host>/                       # e.g. data/qwik-guvi-perf-fix.codingpuppet.com/
ls -1 data/www.guvi.in/ | tail            # oldest
```

Each entry is a directory holding `report.json` and `runs.json`. To see what one actually is before spending a command on it, read its header fields directly — free, and no PSI call:

```bash
jq -r '"\(.reportId)  \(.url)  score \(.headline.score)  lcp \(.headline.metrics.lcp)"' \
  data/<host>/<reportId>/report.json

# without jq
node -e 'const r=require(process.argv[1]);
  console.log(r.reportId, r.url, "score", r.headline.score, "lcp", r.headline.metrics.lcp)' \
  ./data/<host>/<reportId>/report.json
```

`--reportId` searches every host directory, so you do not need to know which host a report was filed under — but you do need the ID.

**Baseline hygiene:** pick the baseline with the *same* `environment` line (`lighthouseVersion`, `benchmarkIndex`, `networkUserAgent`). A report from before a PSI infrastructure change is not a valid comparison, and `benchmarkIndex` is the single best predictor — a number that moved with it did not improve.

### Step 1 — Baseline

```bash
cd psi-api
npm run psi -- https://www.guvi.co/ --runs 10 --stat median --strategy mobile
```

Record the whole output, especially `headline`, `score.stddev`, and the gaps.

> **The URL must be reachable from Google's servers.** PSI runs its bots in Google's public cloud. A page on a private network, or one that blocks Google, returns `FAILED_DOCUMENT_REQUEST` or `ERR_CONNECTION_FAILED` on every run and you will waste the whole iteration discovering that. Confirm the URL loads in a browser *and* is publicly reachable before starting.

### Step 2 — Stop condition

If `meetsTarget` is `true`, run the same measurement with `--strategy desktop`. If that meets its target too, **stop.** Report success with before/after numbers for both. Do not keep hunting for wins; the target is met. If desktop fails, it is the next iteration (Step 3d, playbook 8).

If `meetsTarget` is `false`, read `targets.gaps` to see exactly which metric is over budget:

```
METRICS OVER BUDGET
  FCP 2154 vs 1800 (+354)  pass 0%
  SI 3222 vs 3400 (-178)  pass 70%
  TBT 118 vs 200 (-82)  pass 80%
```

`+` means over budget. Work the worst one first, weighted by what Lighthouse says it costs.

**A gap now carries a pass rate, and it is the number to trust.** Each gap reports `passRate`, `overBudgetRuns` and `runsMeasured` alongside the median. A budget describes real sessions, not the middle of a distribution, so a metric is graded on how often individual runs land inside it — at least 90% by default.

This distinction catches a real failure mode. In the report above, TBT's median is 118 ms against a 200 ms budget, so a median-only check calls it a comfortable pass — but 2 of 10 runs came in at 270 ms and 423 ms, and those over-budget runs are precisely the ones dragging the score down. `meets` is `false`, `medianPass` is `true`, and the gap is reported as failing.

When `medianPass` is `true` but `meetsTarget` is `false`, say so in your report rather than reporting a pass. `diagnosis.unreliable` names the metrics where the median and the tail disagree.

**Some gaps are not yours to close.** When a budget sits below what the server round trip alone already costs, `targets.blockedBy` says so. The tool applies this only to elapsed-time metrics (`fcp`, `lcp`, `speedIndex`, `tti`) and only when the *median* is over budget — TBT, INP and CLS are not bounded by TTFB, and a metric that misses on a couple of runs is a variance problem, not a ceiling. If a metric is listed there, escalate rather than spending iterations on it.

### Step 3 — Build the work queue

Use `--diagnose`. It ranks the queue against the metrics that are actually failing, prints the LCP element and its phase split, and lists the cautions that change how the numbers should be read. Do not hand-assemble this from the flat insight table — the flat table answers "what did Lighthouse find", not "what should I work on".

```bash
npm run psi -- --reportId <reportId> --diagnose --party first
```

Over HTTP, for the ranked queue on its own:

```bash
curl "localhost:3939/report/<reportId>/diagnosis?party=first"
```

For the plain filtered table, when you need it:

```bash
npm run psi -- --reportId <reportId> \
  --group opportunity,diagnostic \
  --party first --sortBy savingsMs --limit 10
```

Using `--reportId` re-filters the report you already paid for. **Never re-run PSI just to change a filter** — each run is a quota unit and several minutes of wall clock.

**`--party first` keeps mixed findings.** It drops an insight only when *all* of its cost is somebody else's, and keeps findings Lighthouse could not attribute to a URL at all — a main-thread breakdown with no script behind it is usually your own JavaScript.

The previous behaviour dropped any insight with a single foreign-host row, which discarded real first-party cost. On this project's deployed page, `unused-css-rules` held 43,098 bytes of the site's own dead CSS (94% of the finding) plus one gstatic reCAPTCHA stylesheet — and the whole finding vanished from the queue because of that one row. That is precisely the case where you own most of the fix.

Each insight reports `firstPartyShare` (0–1, or `null` when unattributed). Use it to judge ownership explicitly:

- `--party first` — drop only wholly-foreign findings. The default choice.
- `--minFirstPartyRatio 0.5` — additionally require at least half the cost to be yours.

Check third-party cost separately with `--party third`, and log it; do not attempt it.

**Some findings have no savings estimate at all.** `savingsMs: null` means Lighthouse did not estimate one, which is different from `0` (estimated as worthless). Checklist-style insights such as `lcp-discovery-insight` report a real failure with no time figure, and they sort last as unknown. To surface them deliberately:

```bash
npm run psi -- --reportId <reportId> --group diagnostic --maxScore 0.9 --sortBy score --order asc
```

Add `--metric lcp` / `tbt` / `cls` to focus on the metric that is actually failing, and `--noFlaky` to drop intermittent findings.

**Prioritize like this.** The tool already does this in `--diagnose`; the rules are listed so you can check its work:

1. Metrics that are failing, worst relative overshoot first. Compare each overshoot to *its own budget*, so a 400 ms LCP miss on a 2500 ms budget outranks a 3-point score miss on a 90-point target.
2. Within a metric, findings that affect it at all, then the largest `savingsMs`.
3. First-party cost. A wholly-third-party finding is reported, not hidden, so you can log it as "not actionable in repo" — but it must not be worked.
4. `flaky: true` insights (seen in under 30% of runs) go to the bottom — a finding you cannot reproduce cannot be validated by re-measurement.
5. `savingsMs: null` means "no estimate", not "no gain". A failing insight with a null estimate can still be the right thing to fix — do not skip it just because it sorts low.
6. The score is never a target in its own right. It is a composite that inherits from the Core Web Vitals; optimise the underlying metric, never the score.

> **FCP is a real target, and it is the one that fails most often.** The old priority order here started at LCP, but across this project's 20 stored mobile reports FCP failed 20/20 while LCP failed 11/20. FCP is a Core Web Vital and a ranking input, and on this page it is the binding constraint. Do not skip past it.

**Verify the number, and verify the ownership, before you commit to a fix.** Lighthouse savings are estimates and routinely disagree with reality — a "1.2 s LCP saving" on a page whose LCP is 16 s is a rounding error, not a win. **Rank by what moves the failing metric, not by the raw saving.** And confirm the insight is first-party: check `itemHosts`, `firstPartyItems`, `thirdPartyItems` and `firstPartyShare` on the insight before you read any source code.

### Step 3a — Check what the LCP element actually is

Before applying any image advice, read `lcp` from the report (or the `LCP ELEMENT` block in `--diagnose`):

```json
{
  "isText": false,
  "elementType": "IMG",
  "snippet": "<img decoding=\"async\" loading=\"eager\" alt=\"…\" fetchpriority=\"high\" …>",
  "phases": { "ttfb": 500, "loadDelay": 632, "loadTime": 439, "renderDelay": 344 },
  "totalMs": 1915,
  "dominantPhase": "loadDelay",
  "bottleneck": "resource"
}
```

Two facts decide which playbook applies, and neither is visible in the LCP number:

- **`isText`** — if the LCP element is a text node there is no image to prioritise, lazy-load or resize, so `lcp-discovery-insight`, `prioritize-lcp-image-insight` and `lcp-lazy-loaded-insight` do not apply. The tag is read from the snippet (or the DOM path), never from `nodeLabel` — an image's label is its `alt` text. Trust `isText` and `elementType`.
- **`bottleneck`** — `loadDelay`/`loadTime` means fetch earlier; `renderDelay` means something is blocking paint, usually CSS; `ttfb` means the server is the constraint and no component change will help. `loadTime` is Lighthouse 13's `resourceLoadDuration`.

A genuinely text LCP element has no load phase, because there is no resource to load. That absence is the finding.

### Step 3b — Do not trust a savings figure of zero

`savingsMs: 0` used to mean "zero" when it actually meant "Lighthouse wrote a rollup of zero and the tool stopped looking". The tool now falls through the rollup to the per-metric estimate, the per-row sum, and finally the display string, and records which one it used in `savingsSource` (`overall` | `metricSavings` | `items` | `displayValue` | `none`).

So a cost that was being reported as nothing is now visible. On the deployed page the three largest findings all reported `0ms` before:

| insight | was | actually | from |
| --- | --- | --- | --- |
| `render-blocking-insight` | 0 ms | 601 ms | `items` |
| `unused-javascript` | 0 ms | 206 KiB | `displayValue` |
| `image-delivery-insight` | 0 ms | 33 KiB | `displayValue` |

Treat `none` as "Lighthouse gave no estimate", which is a different fact from "no gain" — and a real failure with no estimate can still be the right thing to fix.

### Step 3c — Read the rows, not just the ranking

`--diagnose` tells you *which* finding to work on. The finding's rows tell you *what to change*. Open them without another PSI run:

```bash
npm run psi -- --reportId <id> --diagnose --party first
npm run psi -- --reportId <id> --items image-delivery-insight,third-parties-insight
npm run psi -- --reportId <id> --requests size --limit 20
```

`--diagnose` already prints the LCP element, the ranked queue, **IMAGE CHECKS** (oversized after pixel-density correction, `srcset` without `sizes`, eager-offscreen, lazy-in-fold, heavy SVGs), and cautions for a heavy HTML document or a third-party on the longest request chain. `--items` prints every row of named insights. `--requests` prints every request the median run made.

It also:

- **Counts GUVI-owned hosts as yours** when `PSI_FIRST_PARTY_HOSTS` is set (see §4). `static.guvi.in` then scores as first-party, not as "document, do not attempt".
- **Queues passed findings that still have byte savings.** `image-delivery-insight` scored 1 on zen-class with 76 KiB still to save; it is in the queue, labelled as passing.
- **Ranks byte-only savings.** `unused-javascript` at 84 KiB is converted to an equivalent transfer time for ranking only; the reason line says so.

Rows come from the run whose score is closest to the median, trimmed to the top 25 (`itemsTotal` is the real count); nested `subItems` are complete. The fields that matter:

| Field | Where | Use it for |
| --- | --- | --- |
| `node.selector`, `node.snippet`, `node.path` | `--items` | The grep gate. The snippet carries `loading`, `fetchpriority`, `srcset`, `sizes`, `width`/`height`. |
| `node.boundingRect` | `--items` | Where the element rendered. `top` ≥ the emulated viewport height (823 on mobile) is below the first fold; `left` ≥ width or negative is off-screen horizontally. |
| `subItems.items[].reason` | `image-delivery-insight` | Intrinsic vs displayed size, or the compression/format problem. Prefer IMAGE CHECKS for the density-corrected verdict. |
| `url`, `resourceType`, `transferSize` | `--items` / `--requests` | What was fetched and how heavy it was. |
| `wastedBytes`, `wastedMs`, `wastedPercent` | opportunity rows | The size of the problem on that one resource. |
| `entity`, `mainThreadTime` | `third-parties-insight` | Who owns the cost, and whether it costs CPU or only bytes. |

### Step 3d — Playbooks for findings Lighthouse under-explains

Each playbook is *signal → confirm → allowed fix*. Every fix still goes through the grep gate and the SOP in Step 4. Examples are from `qwik-guvi-perf-fix…/zen-class/`, report `2026-09-30T08-04-23Z-mobile`.

PSI's mobile run emulates a **412 × 823 CSS-pixel viewport at device pixel ratio 1.75** (moto g power). Desktop is 1350 × 940 at ratio 1. Use these numbers, not your own screen, whenever a rule below says "first fold" or "displayed size".

#### 1. The LCP image is requested late

- **Signal.** Image LCP (see Step 3a) with a `resourceLoadDelay` over ~300 ms, even though `lcp-discovery-insight` passes (`fetchpriority=high`, eager, discoverable). On zen-class the delay is 632 ms.
- **Why.** The browser's preload scanner only meets the `<img>` when it has parsed that far into the HTML. The zen-class document is 103 KB on the wire and the hero sits deep inside `<main>`, so the image request starts only as the document finishes (~1.15 s).
- **Fix.** Declare the image in the head so it is requested alongside the HTML: `<link rel="preload" as="image" fetchpriority="high" imagesrcset="…" imagesizes="…" media="…">` via the route's `head` export. It must match the exact `srcset`/`sizes`/`media` the `<picture>` uses at that breakpoint — a mismatch downloads the hero twice. Add a `media` query so desktop does not fetch the mobile hero. Then shrink the HTML (playbook 5), which helps every late request.
- **Confirm.** DevTools Network at 412 px wide: the hero is requested once, with High priority, near the top of the waterfall.

#### 2. Images larger than they render

- **Signal.** IMAGE CHECKS `oversized` / `no sizes` / `heavy` rows in `--diagnose`. Confirm with `--items image-delivery-insight`.
- **Correct for pixel density first.** Displayed dimensions are CSS pixels. IMAGE CHECKS already multiplies by the emulated device pixel ratio (1.75 on mobile) and only flags real waste when the intrinsic width is ≳ 1.3× that. A row labelled `fine` is an artifact — leave the image alone.
  - The zen-class hero is 750 px wide for 412 CSS px. It needs 721, so it is right-sized; its "34 KB waste" is an artifact. Do not shrink it — it would go blurry on real phones.
  - The partner logos are 714 px wide for 251 CSS px. They need ~440, so the waste is real.
- **Most common cause: `srcset` with `w` descriptors and no `sizes`.** Without `sizes` the browser assumes the image is 100vw and picks the largest candidate that covers 412 × 1.75. Every partner logo on zen-class has `srcset="… 200w, … 400w, …"` and no `sizes`, so each phone downloads the 714 px file. The fix is a correct `sizes` for the rendered width (or the Unpic component with explicit `width`, which emits it), not re-encoding or swapping the asset.
- **Heavy vector files.** Check `total-byte-weight` for any SVG over ~50 KB — that is almost always an embedded bitmap. `static.guvi.in/zen-class-revamp/tools/devops.svg` is **576 KB**, a third of the page's 1.7 MB. An asset on the CDN cannot be re-encoded from this repo: log it with its size and URL, make sure it is lazy-loaded if it sits below the fold, and escalate the asset itself. Never swap it for a different-looking asset (SOP §6).

#### 3. Lazy-loading: what loads that should not, and what waits that should not

`--diagnose` IMAGE CHECKS already flags eager-offscreen and lazy-in-fold elements Lighthouse attached a node to, and `--requests` lists every image that actually loaded. CSS `background-image` still does not appear in either, so for those (and anything the snippet was clipped on) check the deployed page. Open it at 412 × 823, let it load **without scrolling**, and run in the console:

```js
[...document.querySelectorAll('img, iframe, video')]
  .map((el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      src: (el.currentSrc || el.src || '').slice(0, 90),
      top: Math.round(r.top + scrollY),
      offscreenX: r.left >= innerWidth || r.right <= 0,
      loading: el.getAttribute('loading'),
      fetchpriority: el.getAttribute('fetchpriority'),
      below: r.top >= innerHeight,
    };
  })
  .filter((x) => ((x.below || x.offscreenX) && x.loading !== 'lazy') || (!x.below && !x.offscreenX && x.loading === 'lazy'));
```

- **Below the fold or off-screen horizontally, and not lazy** → add `loading="lazy"`. This includes carousel slides past the first and images inside closed drawers or menus.
- **In the first fold and lazy** → make it eager. The LCP image is never lazy.
- **Exactly one element gets `fetchpriority="high"`:** the LCP image. A second one competes with it.
- **`iframe`** (YouTube, maps) below the fold → `loading="lazy"`. A click-to-load facade is better but is new UI; check the SOP first. **`video`** below the fold → `preload="none"` with a `poster`.
- Then check what was actually fetched before LCP: `performance.getEntriesByType('resource').filter((e) => e.initiatorType === 'img' && e.startTime < 2500)`. An image in that list that the first script said is below the fold is a missed lazy-load.

CSS `background-image` does not appear in either list. Check sections with large backgrounds by hand.

#### 4. Third-party requests that do not need to be there

- **Signal.** `third-parties-insight` rows (`entity`, `transferSize`, `mainThreadTime`, and each resource under `subItems`). Also any vendor URL in `network-dependency-tree-insight`'s chains, or in `legacy-javascript-insight` / `cache-insight`.
- **Inventory in the browser:**

  ```js
  Object.entries(performance.getEntriesByType('resource').reduce((acc, e) => {
    const host = new URL(e.name).host;
    acc[host] = acc[host] || { requests: 0, kb: 0 };
    acc[host].requests += 1;
    acc[host].kb += Math.round(e.transferSize / 1024);
    return acc;
  }, {})).sort((a, b) => b[1].kb - a[1].kb);
  ```

- **Decide by who put it there:**

| Situation | Action |
| --- | --- |
| Grep finds nothing — injected by the platform | Not fixable in the repo. On zen-class, `static.cloudflareinsights.com/beacon.min.js` plus `/cdn-cgi/rum` is Cloudflare Web Analytics, injected at the edge, and is the page's longest request chain. Log it and escalate: it is switched off in the Cloudflare dashboard, not in code. |
| In the repo, only needed on interaction (reCAPTCHA, chat widget, video player, maps) | Load it at the point of use — on form focus, on click — with a dynamic import (SOP §8). reCAPTCHA on a below-fold form should not load on page load. |
| In the repo, analytics or tag manager | Deferring until after load is allowed if the SOP permits; **removing** tracking is a business decision. Ask. |
| A GUVI-owned host (`static.guvi.in`) | First-party once `PSI_FIRST_PARTY_HOSTS` includes `guvi.in`. Use the image playbooks. |

Never edit a vendor's script, and never add Partytown or any other package to move scripts off the main thread without senior approval (SOP §10.3).

#### 5. HTML weight and DOM size

- **Signal.** The `Document` row of `total-byte-weight` (zen-class: 103 KB compressed), and `dom-size-insight` (zen-class: 4,406 elements). The "Most children" row names the worst node — on zen-class, a 251-entry country-code list inside `details#request-formmobile-input`, far below the fold. A heavy document delays everything discovered from it, including the LCP image (playbook 1).
- **Measure:**

  ```bash
  curl -s --compressed https://<host>/<page>/ -o page.html
  wc -c page.html                                              # uncompressed HTML
  grep -o '<script type="qwik/json">.*</script>' page.html | wc -c   # serialized state
  grep -o '<svg' page.html | wc -l                             # inline SVGs
  ```

- **Fix, within SOP §4/§7:**
  - Render long option lists (countries, course catalogues) when the control opens, not in the server HTML.
  - Do not render two copies of a section (a `…mobile…` and a desktop variant) and hide one with CSS, when one responsive copy would do.
  - Keep static data as module constants, never in a `useStore` — a store is serialized into `qwik/json` on every page load.

#### 6. The FCP path: render-blocking CSS and fonts

- **Signal.** `network-dependency-tree-insight` shows the chain, and `render-blocking-insight` / `unused-css-rules` price it. On zen-class the chain is HTML (done 1.15 s) → one 46 KB stylesheet, 92% unused on this page (done 1.80 s) → five font files discovered only from that CSS (done 1.97–2.12 s). FCP is 1.99 s: the stylesheet *is* the FCP.
- **Fix, within the SOP:**
  - Shrink what the first paint waits for. Move page-specific styles into colocated `*.module.css` so the global stylesheet carries only shared rules; the critical-CSS approach is the SOP's call (§8), not yours.
  - Preload only the one or two font files used by first-fold text (`<link rel="preload" as="font" type="font/woff2" crossorigin href="…">`), and update the `@font-face` and every preload together (SOP §6). Preloading all five competes with the CSS and the hero.
- **Preconnects.** The same insight's "Preconnect candidates" section says whether a `preconnect` would help. Add one only when it names an origin.

#### 7. Attributing unused JavaScript to source

- Qwik chunk names are content hashes, so `unused-javascript`, `bootup-time` and `long-tasks` name files like `q-BCYPl1tV.js`. Build the **exact commit that is deployed**, then look the names up in the build manifest:

  ```bash
  cd qwik-guvi && npm run build
  node -e "const m=require('./dist/q-manifest.json'); for (const n of process.argv.slice(1)) console.log(n, JSON.stringify(m.bundles[n]?.origins ?? 'not in this build'))" q-BCYPl1tV.js q-D31wtCEL.js
  ```

- "Not in this build" means the local build does not match the deployed one. Do not guess from a mismatched manifest.
- The origins name the source files. The fix is import timing (SOP §8): the code in that bundle should not load until it is used.

#### 8. Desktop is a target too

`config/targets.json` has desktop budgets, and the SOP's bar is 90+ on both. A mobile fix can regress desktop — a preload without a `media` query makes desktop download the mobile hero. Once mobile meets its target, run `--strategy desktop` before reporting DONE, and treat a desktop failure as the next iteration.

### Step 4 — Read the SOP, then map the insight to an allowed action

**Before the first code change of every session, read `sop-qwik.md` in the repo root in full.** Do not work from memory or from a summary — it governs component structure, styling, images, Qwik patterns, git, and gates.

Then, for the insight you picked, find the action it maps to:

| Insight | What it usually means | Check the SOP for |
| --- | --- | --- |
| `render-blocking-insight`, `unused-css-rules` | CSS blocks first paint | §8 "Initial load ships no JS except Qwik's default module-preload" |
| `lcp-discovery-insight`, `prioritize-lcp-image-insight` | LCP image is late or undiscoverable | §6 images (Unpic, first-fold high priority), §7 |
| `lcp-lazy-loaded-insight` | LCP image is lazy loaded | §6 lazy loading is for **below-fold only** |
| `image-delivery-insight`, `unsized-images` | Oversized or poorly compressed images | §6 image rules, §6 Unpic |
| `bootup-time`, `mainthread-work-breakdown`, `long-tasks` | Expensive JS | §8 dynamic-import heavy libs at point of use, §8 no new packages without senior approval |
| `duplicated-javascript-insight`, `legacy-javascript-insight` | Bundle bloat | §10.3 no new packages / never change dependency versions |
| `font-display-insight` | Invisible text while fonts load | §6 fonts (update `@font-face` **and** every preload together), §5 typography |
| `third-parties-insight` | Other people's code, **except** rows on hosts in `PSI_FIRST_PARTY_HOSTS` | Document vendor rows; work owned-host rows as image or script findings |
| `cls-culprits-insight`, `cumulative-layout-shift` | Layout shift | §5 spacing, §7 never Store static arrays, images need dimensions |
| `forced-reflow-insight` | Synchronous layout thrash | §7 no `useVisibleTask$` on first fold, §7 `noSerialize` for lib instances |
| `cache-insight`, `document-latency-insight` | Headers / server latency | **Likely outside the frontend.** If the SOP does not cover it, stop and ask. Note `document-latency-insight` often carries a large estimate with zero items — it is unattributed, so `--party first` will not filter it out. Judge it by whether the number is plausible against the real LCP, not by the estimate. |
| `non-composited-animations` | Animating layout properties | §8 GPU-only (`transform`/`opacity`) — explicitly required |
| `dom-size-insight` | Oversized DOM | §4 components must be self-contained; §7 no duplicated markup |

**If the SOP does not cover the fix, or covers it differently than the insight suggests: stop and ask a human. Do not improvise a change to the app.** The SOP's precedence is explicit user ask > `DESIGN.md` > SOP > neighbor style, and it forbids disabling lint rules and unapproved packages. A performance win is not a licence to bypass that.

**The grep gate — do not skip this.** Lighthouse has no idea what your repository looks like. It reports DOM selectors, HTML snippets and resource URLs, never file paths. Before you propose any change you must prove the thing exists in the code:

```bash
# take a class name, id, or URL fragment from the insight's items and search for it
grep -rn "image__dam-img" src/
grep -rn "static.cloudflareinsights.com" src/
```

- **Grep finds it** → you have a file. Read it, confirm the insight describes the problem you found, then change it.
- **Grep finds nothing** → the cost is not in code you own. Log it under "not actionable in repo" with the `itemHosts` that told you so, and move to the next insight. **Do not create a file to satisfy the audit, and do not edit a third party's script.**

An insight that greps cleanly is a finding, not a task. On a real report of this project, `cache-insight` and `legacy-javascript-insight` both pointed at Cloudflare's beacon — high savings, zero greppable source, and a `resourceType: Script` attached so you know from the CLI output that the correct move is to disable the Cloudflare feature, not to edit a script.

For third-party images, the `subItems` carry `resourceType: Image` and the full URL. If no `.node` selector is present, grep for the domain or a path fragment:

```bash
grep -rn "static.guvi.in" qwik-guvi/src/
```

This returns `certifications-and-placements.tsx:40` where a base URL plus a relative path is combined to build the third-party image URL. The agent must then read the surrounding code to understand the data flow.

#### App rules a performance fix must not violate

`sop-qwik.md` is binding and `qwik-guvi/CLAUDE.md` carries the same rules in repo form — read both. The `§N` references in the table above point at **`sop-qwik.md`** sections, not at this guide. What follows is the perf-relevant subset: the specific traps an agent falls into when it is optimising against a Lighthouse number.

**Images — the most common trap**
- **Never introduce a raw `<img>`.** First-fold images go through **Unpic** with explicit `src`, `width`, `height` and loading priority. Local assets: `import Img from './images/x.png?jsx'`.
- Adding `width`/`height` to a raw `<img>` does not make that fix SOP-compliant. `src/` currently holds **56 raw `<img>` occurrences**; treat them as pre-existing debt, match the neighbour's pattern, and do not add more.
- **Never change an element's existing `object-fit`.** `object-fill` / `object-cover` on card and background illustrations (e.g. `src/routes/enterprise/government/components/strategic-offerings.tsx`) must stay exactly as written. Swapping to `object-contain` "to prevent distortion" leaves white gaps and is an explicit CRITICAL violation. Both values are in wide use — 25 `object-fill`, 74 `object-contain` — so the rule is *do not change this element*, not *never write this value*.
- `<picture>` only when desktop and mobile genuinely need different images, not for art direction to win a size.
- **Never swap a custom Figma asset** (stars, badges, checkmarks, illustrations from `./images/`) for a Lucide icon from `~/components/lucide-icons/*` to save bytes unless it is pixel-identical. Fidelity beats byte count.
- Below-fold images stay lazy; **the LCP image is never lazy loaded**.

**Qwik — what actually ships JS**
- **The first fold ships no JS except Qwik's own module-preload.**
- `useVisibleTask$` is DOM-only work and is **never** allowed on the first fold. This codebase has **322 of them across 133 files**, including shared `src/components/` that render above the fold (`carousel`, `code-editor`, `awards-section`) — so "it is used everywhere" is not a defence. It requires `// eslint-disable-next-line qwik/no-use-visible-task`; adding or removing that suppression needs approval.
- Prefer `useTask$` (177 uses) over `useVisibleTask$`, and `onInput$` / `onChange$` over `useTask$` for input reactions.
- Static data is a plain module-level `const`. **Never a `useStore` for a static array** — a frequent cause of `forced-reflow-insight` and `bootup-time`.
- Handlers are defined separately and bound (`onClick$={handler}`). No inline JS in JSX.
- DOM access through `useSignal<HTMLElement>()` refs, never `getElementById`.
- **No `routeAction$` / `<Form>` / `server$`.** The tree currently has **0** `routeAction$`. Data is `routeLoader$` → generated `useX` hooks; forms POST via `post()` in `~/utils/steroid.tsx`.
- **No client-side navigation between routes.**
- **A component you create and never use must be deleted or fully commented out — Qwik builds exported components even when unused, so an orphan export costs real bytes.** This is directly on the critical path for `unused-javascript`.
- Styling belongs in colocated `*.module.css` or `?inline` with `useStylesScoped$` — not inline styles or JSX `style` props. No arbitrary Tailwind values (`w-[313px]`).

**Libraries — the `unused-javascript` fix is import timing, not deletion**
- Already in the tree: `ace-builds`, `mermaid`, `@ricky0123/vad-web`, `hls.js`, `plyr`, `swiper`, `canvas-confetti`, `jspdf`, plus `onnxruntime-web` via vad-web.
- **Dynamic-import them at the point of use.** Do not delete a library to shrink a bundle, do not add one, and **never change a dependency version** to win a number. No new package without senior approval.
- Qwik chunk names are content hashes (`build/q-TYxvsI7E.js`) and do not map to source files — use the build manifest, not grep, to attribute a chunk.

**Styling, motion, a11y — do not trade a11y for CLS**
- On-token colours only, in the correct territory: brand green `#0dba4b`, AI purple `#6729ff`, practice green-on-dark `#0ae056`/`#56f68f` on `#0a0f14`. A new value updates `tailwind.config.js` + `src/global.css` + `DESIGN.md` together.
- Mobile-first; **verify every change at 375 / 576 / 768 / 992 / 1200.** Avoid `max-width` queries.
- GPU-only motion: `translate` / `scale` / `opacity`, never layout properties on the main path. **Exception: accordions/FAQ may transition `grid-template-rows` `0fr↔1fr` plus the needed padding — keep it.**
- WCAG AA contrast, always-visible focus rings (never bare `outline: none`), honour `prefers-reduced-motion`, touch targets ≥44px, no orphan hover on touch.

**Stack facts you need**
- Node **18.17.0** (`.node-version`), Vite 5, npm `legacy-peer-deps`, TS strict, alias `~/*` → `./src/*`, jsx `@builder.io/qwik`, Qwik `^1.16.0`.
- Tailwind `^3.3.5` + DaisyUI `^4.3.1`, single `light` theme, `primary #0dba4b`; fonts DM Sans + Jones; type `h1 2.5rem → h6 1rem` at 700/1.2; radius `0.25rem`.
- All config is public build-time `VITE_*`. **Never commit `.env` secrets.**
- Deploy: Cloudflare Pages primary (`npm run deploy`), plus AWS Lambda / Express / Docker→ECS. CI is CodeBuild (`buildspec.yml`).
- Reference component: `src/components/toast/toast.tsx`. Icons: `src/components/lucide-icons/`.

**Testing — a green build is not a regression check**
- The repo is effectively untested: one stale Playwright spec, no unit tests, and CI runs none. Do not treat the suite as a safety net. Verify with `build.types` + `lint` + `fmt.check` and confirm the change in a browser at the breakpoints above.
- Gates are mandatory even for small work: `brainstorming` → `plan-eng-review` (Gate 1) → `review` (Gate 2) → `verification-before-completion`, then `qa` + `canary` after deploy.

**Two stale references in the upstream docs — know these, do not act on them**
- Both `sop-qwik.md` §2 and `CLAUDE.md` say to read `graphify-out/GRAPH_REPORT.md` first for architecture questions and to run `graphify update .` after source edits. **That directory does not exist in this checkout.** Use the SOP's own architecture section; its absence is not a blocker and is not something to "fix".
- `sop-qwik.md` §6 says "never use raw `<img>`" while 56 raw `<img>` occurrences exist in `src/`. The rule binds on new code; the existing ones are debt, not precedent.

### Step 5 — One change

**Re-read the app rules in Step 4's "App rules a performance fix must not violate" before you touch a file.** Almost every wasted performance iteration on this project comes from a change that was genuinely faster and simultaneously broke an app rule — a raw `<img>`, a swapped `object-fit`, an orphaned export, a `useVisibleTask$` added above the fold.

- Make **one focused change**, or one small cohesive group of changes that only make sense together.
- Touch only the files the SOP permits for this fix.
- Follow the SOP's own workflow: it requires `brainstorming` → `plan-eng-review` (Gate 1) → implement with TDD → `review` (Gate 2) → `verification-before-completion` before DONE. **Never bypass tests, lint, typecheck or build steps the SOP requires.** If a gate is unavailable to you, say so and ask rather than skipping it.
- SOP §9 also requires `design-review` by a fresh agent for UI work, and `qa` + `canary` after deploy.
- Never alter marketing copy as a side effect (SOP §3.7, §7). Performance work is not a copy edit.
- Never add a dependency or change a version (SOP §8, §10.3) to win a Lighthouse number.

### Step 6 — Commit on a branch

Per SOP §10: branch off `development`, descriptive commit message, **no AI-tool attribution** (no `Generated with…`, no `Co-Authored-By`, no footers).

Name the insight in the message so the log is traceable:

```
perf: preload LCP hero image (lcp-discovery-insight)
```

### Step 7 — Open the staging PR. This is not optional.

**PSI measures a live public URL. A change that is not deployed is not measurable.** Measuring your local server measures nothing.

Per SOP §2 and §10, `qwik-guvi` deploys to **Cloudflare Pages** as primary. Build and verify locally first:

```bash
cd qwik-guvi
npm run build          # must pass
npm run build.types && npm run lint && npm run fmt.check
```

Then push the branch and open a **staging PR for the page you are optimizing**:

```bash
git push -u origin <branch>
gh pr create --base development --head <branch> \
  --title "perf: <what changed> (<insight-id>) on <page>" \
  --body "<page>, <insight-id>, baseline median, expected effect, revert plan>"
```

One staging PR per page being optimized. If a staging PR for this page is already open, push to that branch instead of opening a second one.

CI is **AWS CodeBuild (`buildspec.yml`)**, not GitHub Actions, and `qwik-guvi/.github/` currently contains only `CODEOWNERS` — there are no workflow files. So `gh pr checks` may legitimately report *no checks*; that is not a failure to fix, it means the pipeline is elsewhere. Confirm which pipeline the branch actually triggers, and ask a human if you cannot tell. Never invent a workflow file to make polling return something.

> #### ⛔ Do not push while staging is building
>
> **Once a build is in flight, the branch is frozen until it reaches a terminal conclusion.** Pushing again mid-build is the one thing you must never do here, because it damages the shared staging server rather than just your own measurement:
>
> - It **cancels or restarts the in-flight build**, so the previous attempt never completes.
> - It can leave staging **serving a half-applied deploy** — a new HTML shell pointing at assets that were never uploaded, or a mix of old and new chunks. That breaks the staging site for **everyone** using it, not just you.
> - The resulting `500`s or missing-chunk errors look like a performance regression and will send you chasing a fix that does not exist.
> - It wastes the entire poll cycle you already burned.
>
> **The rule:** between the first push and the terminal conclusion of that build, `git push` is forbidden. Do not "just add a small fix", do not amend, do not force-push, do not merge `development` in. Compose those changes locally and push **once**, after the build has settled.
>
> **"In progress" vs "settled" — the distinction that matters:**
>
> | Run state | Meaning | May you push? |
> | --- | --- | --- |
> | `status: in_progress`, `queued`, `waiting`, `pending` | build is live | **No.** Wait it out. |
> | `conclusion: success` | build finished, staging is stable | Yes |
> | `conclusion: failure` | build finished and failed, nothing partial is live | Yes — fix, push, restart the 10-minute wait |
> | `conclusion: cancelled` | someone or something stopped it | Yes — but find out why first |
> | no run visible at all | pipeline not tracked by Actions | Treat as in progress until the staging URL stops changing |
>
> A *failed* build is terminal, so pushing a fix after it is fine. An *in-flight* build is not. When you are unsure which state you are in, the safe action is always to wait.
>
> This also applies to merging `development` into your branch (SOP §10.2). Do that merge **after** the current build settles, never mid-build.

### Step 8 — Wait 10 minutes, then poll the staging PR every minute

The deploy needs time to build and propagate through the CDN. **Do not measure before the staging deploy is live** — a measurement taken against a stale edge is a false negative, and you will revert a change that actually worked.

**Phase 1 — wait a flat 10 minutes before the first poll.** Do not poll earlier, do not poll faster:

```bash
sleep 600
```

**Phase 2 — poll once per minute until the PR's deploy settles.** Get the staging PR number from GitHub, then loop at a 60-second cadence:

```bash
# the staging PR number for this page's branch (verified working form)
PR=$(gh pr list --head <branch> --state open --json number,url \
       --jq '.[0] | "PR #\(.number) \(.url)"')
echo "$PR"
PR=${PR##*#}; PR=${PR%% *}

# poll every 60s
while :; do
  echo "--- $(date -u +%H:%M:%SZ) polling PR #$PR ---"
  gh pr checks "$PR" || true          # prints check name + state
  gh run list --branch <branch> --limit 3 \
    --json databaseName,status,conclusion \
    --jq '.[] | "\(.databaseName): \(.status)/\(.conclusion // "-")"' || true
  # break out when the deploy is done: checks are all green/failed and a run has concluded
  if gh run list --branch <branch> --limit 1 --json conclusion \
       --jq '.[0].conclusion != null' | grep -q true; then
    echo "deploy settled"; break
  fi
  sleep 60
done
```

**Expect these two commands to come back empty on this repo.** `qwik-guvi/.github/` holds only `CODEOWNERS`, there are no workflow files, and `gh run list` is verified to return nothing while `buildspec.yml` (AWS CodeBuild) is the real pipeline. An empty `gh run list` is information, not an error:

- If `gh pr checks` lists checks → poll those until terminal, as above.
- If both are empty → the deploy is **not** tracked by GitHub Actions. Fall back to polling the staging URL itself once a minute, checking whether the new build hash is live, and confirm the pipeline with a human. Do **not** add a workflow file to make the commands return something.

Rules for the poll:

- **Exactly one poll per minute.** No tight loop, no hammering the API, no `sleep 5`.
- **Stop when the run reaches a terminal conclusion** — `success`, `failure`, or `cancelled`. Then read the logs, do not just trust the conclusion.
- **The build is frozen while you poll. Do not push.** See "Do not push while staging is building" above. If you find a problem mid-poll, write it down and wait — do not act on it.
- **On failure, read why before retrying:** `gh run view <run-id> --log-failed`. A failed build is terminal, so you may then fix, push, and restart the whole 10-minute wait. Never push *while* it is still in progress.
- **Never cancel a running build** to "get a clean start". Cancelling leaves staging in a worse state than waiting would have.
- **Cap the wait at 30 polls (30 minutes).** Past that, the deploy is stuck or the pipeline is not firing — report BLOCKED with the last poll output instead of polling forever.
- **Never measure while a poll shows work still in progress.** An in-flight deploy means the URL may serve two different builds.

If the staging URL starts returning errors, a `500`, or the shell loads while chunks 404, the deploy is broken. **Stop and report it** — do not push a revert on top of an unknown state, because that pushes on top of a possibly broken build.

Once the poll settles green, confirm the measured URL is actually serving the new build before measuring:

```bash
curl -s https://<staging-host>/<page>/ | grep -oE 'build/q-[A-Za-z0-9_-]+\.js' | head -3
```

A changed chunk hash confirms the new build is live. An unchanged hash means the edge is still serving the old deploy — keep waiting.

### Step 9 — Re-measure and decide

```bash
npm run psi -- https://www.guvi.co/ --runs 10 --stat median --strategy mobile
```

Compare against the baseline:

| Comparison | Verdict |
| --- | --- |
| `new median score - old median score > old stddev` | **Keep.** Real improvement. |
| improvement `< old stddev` | **Inconclusive.** Re-measure once; if it stays flat, revert. |
| score flat or worse, and the target is still missed | **Revert.** The change did not pay for the risk it adds. |

Use the **baseline's `stddev`** as the noise band — it is the same measurement setup that produced the number you are comparing to. Note that `stddev` shrinks as the median climbs; recompute the band from the most recent report each time.

**But judge the change on the metric's own spread, not the score's.** The score is a composite: it moves when any input moves, so `score.stddev` is a band built from every metric at once. A report on this project's deployed page had an LCP `stddev` of `0.0` (2401 ms in all 10 runs) next to a score `stddev` of 3.37. Using the score's spread as the band for an LCP change demands a margin the LCP cannot ever produce, and a genuine 500 ms LCP win gets filed as "inconclusive".

Every metric reports `p25`, `p75`, `p95`, `stddev` and its raw `values`, and `distributions.<metric>` reports whether that metric's samples are bimodal. Judge the change you made against **the distribution of the metric you changed**:

| Change to | Judge on |
| --- | --- |
| LCP or FCP | `metrics.lcp.p75 - baseline.metrics.lcp.p75`, and `metrics.lcp.stddev` |
| TBT | `metrics.tbt.p75` and `passRate`, not the score |
| CSS/JS weight | `distributions.score` and the score's `p75` |

> **These numbers are only in `--json`.** The human-readable view prints a spread line for the **score** only; the metric table shows median, target, verdict, % of target, bar and runs-in-target, and nothing else. `metrics.<metric>.p75`, `metrics.<metric>.stddev` and `distributions.<metric>` do not appear anywhere in the text output. To judge a change on the metric you actually edited, read them from JSON:
>
> ```bash
> npm run --silent psi -- --reportId <id> --json \
>   | jq '{lcp: (.metrics.lcp | {median, p75, p95, stddev}),
>        bimodalLcp: .distributions.lcp.bimodal}'
> ```
>
> No `jq`? See 5.7.1 for the equivalent `node -e` one-liner.
>
> `--diagnose` does print a bimodality *caution* when the score splits, but it prints no percentiles, and it cautions on the *score's* split rather than the metric's. Do not conclude a metric is stable because the text view is quiet about it.

**A bimodal metric is not one population, so its `stddev` is not a noise band.** If `distributions.<metric>.bimodal` is `true`, the page has two distinct states — on this project's page the scores cluster at 87.5–88.5 and 93–95.5. Averaging those gives a spread that describes neither state. Read the two lanes separately, work out which lane the change moved, and only compare within a lane. `--diagnose` prints the score's split as a caution; every other metric's split is JSON-only.

Also check the target metric you were actually fixing, not just the score. A change that trades LCP for CLS may leave the score flat while making things worse for users. And re-check `passRate`: a change that pulls one over-budget run back inside the budget is worth keeping even when the median does not move.

### Step 10 — Log it

Append to `psi-api/data/<host>/optimization-log.md`, where `<host>` is the measured URL's hostname. **Append-only — never edit or delete earlier entries.**

The file does not ship with the tool — create it on your first iteration if it is absent:

```bash
cd psi-api
touch "data/<host>/optimization-log.md"    # the host dir already exists if you have run a report
```

One log per host, shared across every page on that host, so keep each entry headed with the page it concerns.

```markdown
## Iteration 3 - 2026-09-29T11:20:00Z

**Insight targeted:** `lcp-discovery-insight` (diagnostic, 750ms, affects lcp)
**Change made:** Added `fetchpriority="high"` to the Unpic hero image in
`src/routes/learn/[courseId]/components/hero/hero.tsx`.
**Commit:** `perf: preload LCP hero image (lcp-discovery-insight)` on `perf/lcp-hero`
**Staging PR:** #1220 — polled 10 min after push, 60s cadence, settled green at 14:22Z
**Baseline:**  median 27 (stddev 3.1)  LCP 16070ms  TBT 2127ms
**After:**     median 31 (stddev 2.8)  LCP 14810ms  TBT 2102ms
**Delta:**     +4.0 median (> 3.1 stddev)  LCP -1260ms
**Verdict:**   KEPT
```

### Step 11 — Repeat or stop

Loop from Step 2. Stop when `meetsTarget` is `true`, or when you hit the iteration cap, or when you run out of SOP-permitted moves — in which case report what you found and what a human needs to decide.

---

## 2. Safety limits

**Max iterations: 10.** If you have not met the target after 10 iterations, stop and report. A human decides what to do next. Do not raise the cap yourself.

**Scope — you may:**
- Read anything.
- Edit the app/page files the SOP permits for the specific fix.
- Append to `psi-api/data/<host>/optimization-log.md`.

**You may not:**
- Modify `psi-api/` in any way. Not the code, not the targets, not the stored data, not the README. You use the tool; you do not repair it.
- Edit `config/targets.json` to make a page pass. **Targets change only on explicit human instruction.** Relaxing a target to turn a failure into a success is the one move that makes the entire loop meaningless.
- Delete, overwrite or "clean up" stored reports or the log.
- Change a dependency or dependency version.
- Disable lint rules, skip tests, or skip the build.
- Touch marketing copy.
- Deploy to production on your own initiative without the SOP's deploy steps and human sign-off.
- **Push to a branch whose staging build is still running.** The staging server is shared, so a mid-build push can leave it serving a half-applied deploy and break the site for everyone. Wait for a terminal conclusion. See "Do not push while staging is building" in Step 7.
- **Cancel or restart a running staging build** in order to get a clean start.

**If the tool itself looks broken** — a wrong number, a crash, a filter that returns nonsense — do not patch it. Report it with a reproduction and move on to the next insight, or stop. A broken measuring instrument must never be quietly adjusted to produce a number you like.

---

## 3. Noise, and how to read it

**Why 10 runs.** A single Lighthouse run is a lab measurement on a shared, throttled connection. Run-to-run score varies by several points on an unchanged page. Ten runs gives the median something stable to sit on and gives `stddev` enough samples to be meaningful. Three runs is a reasonable quick look while you are still exploring; it is not enough to accept a change on.

> **PSI caches per URL.** Ask for the same URL twice in a row and you get *one* Lighthouse run back, not two — the tool works around this by adding a unique `?psi_nonce=…` to every request, and by warning you if the runs collapse to a single timestamp. **If you see that warning, the report is not a real measurement. Discard it and re-run.** Never accept a change on the strength of a cached report.

**Why median is the headline.** Lighthouse is right-skewed — an occasional run catches a slow third-party response and drags the page down. The mean follows those outliers; the median does not. Compare **median to median**.

**When to use mean.** Only when you specifically care about average user cost, and always alongside `stddev`. Useful for judging how bad the bad runs are, not for deciding whether a change worked.

**When to use mode.** The most frequently observed bucket, after bucketing (score to 1 point, time metrics to 100 ms, CLS to 0.01). Read it as "what this page typically scores". It is a good sanity check: if `mode` and `median` disagree wildly, the page is bimodal — usually one flaky third party — and you should look at the raw `values` array before trusting either.

**Bimodality is reported, not left to be guessed.** `distributions.<metric>` carries `bimodal`, both `lanes`, their `separation`, and a human-readable `note`. The detection splits the samples at the point that minimises within-lane spread (Otsu's method in 1D) and only claims two populations when both lanes hold at least 20% of the samples, there are at least 6 samples in total, and the lane means are far enough apart to be more than jitter. A single bad run among nine good ones is reported as ordinary spread, not as a second mode. When `bimodal` is `true`, the median is a number between two real states and means less than either of them.

**What `flaky: true` means.** The insight appeared in fewer than 30% of successful runs. It is intermittent. Deprioritize it: a flaky finding may not reproduce when you re-measure, so you cannot tell your fix from the noise. If a flaky insight is enormous, check whether a third party is involved before touching anything.

**Accepting a change.** Require the improvement to exceed roughly one `stddev` of the baseline. If it does not, the honest answer is "inconclusive", not "small win". Re-measure once to break the tie; if still inconclusive, revert and note it in the log. Small real wins are still real — but you cannot distinguish them from noise, and shipping a change you cannot measure is how regressions accumulate.

**When `stddev` is `0.0`.** The threshold above silently stops working, so work out which of the two causes you are looking at before deciding anything:

- **The tool warned "same analysis timestamp"** → the runs were served from PSI's cache. The report is worthless. Re-measure. Do not compare anything against it.
- **No warning** → the page is genuinely pinned, usually because it sits far inside the "good" band or already scores 100. A real `cnn.com` baseline showed `25, 29, 27, 35, 36` (stddev 4.9) while `example.com` shows `100, 100, 100` because every run rounds to the ceiling. In that case judge the change on the **metric values and the target comparison** — does LCP actually drop by more than its own spread? — rather than on the score, and require a real margin instead of "> 1 stddev", which is meaningless at zero.

---

## 3a. The "measured under" line

Every report header carries a line like:

```
measured under moto g power (2022) · CPU index 928 (higher = slower) · en-US · performance only
```

This records the device emulation, CPU benchmark, locale and categories the run was taken with. PSI chooses these server-side — the caller cannot request a different device or throttle — so the only way to know what a stored number means is to record what the response said about it.

**Why it matters.** Two reports are only comparable when they were measured under the same conditions. A score that moves with the CPU index has not improved. If you are comparing a report from before a PSI infrastructure change against one from after, check this line first.

**What it does not say.** Throttling. PSI does not echo the throttle model, so the line does not name one. Inferring "Slow 4G" from the form factor would be a guess printed as a measurement.

**Old reports.** Reports stored before this was recorded show `Lighthouse 13.5.0, device not recorded` or `not recorded`. They are still usable, but you cannot verify their conditions. Re-run or `--reanalyze` to get a fresh report with the full record.

---

## 4. Quota

**Each run costs one PSI API unit. A 10-run check costs 10.** Google gives each API key a daily cap; exceeding it returns `429` for the rest of the day.

- **Always set `PSI_API_KEY`.** Without one you share a tiny anonymous quota that is usually already exhausted.
- Budget explicitly: a 10-iteration loop with a 10-run baseline and a 10-run re-measure per iteration is **~200 units**. Know your daily cap before you start.
- `PSI_CONCURRENCY` (default 10) controls how many calls are in flight per report, so a 10-run check goes out in one round. It does not change the quota cost — 10 runs is 10 units at any concurrency. Leave it at 10, and do not run two reports at once: the limit is per report, so overlapping runs double the load on the staging origin.
- **Only compare reports taken at the same concurrency.** Ten simultaneous page loads can raise the origin's TTFB, and with it FCP and LCP, compared with staggered runs. A baseline taken at concurrency 2 is not a valid comparison for a re-measure at 10 — re-take the baseline.
- `PSI_FIRST_PARTY_HOSTS` lists other domains the site owns, comma-separated (`guvi.in,guvi.co`). Without it, `static.guvi.in` is filed as third party and `--diagnose` tells you not to touch 800 KB of the site's own images. Confirm it is set before you build a work queue. `--reanalyze` re-classifies stored reports against today's list at no quota cost.
- **Re-filter with `--reportId`, never re-run.** Changing a filter is free:
  ```bash
  npm run psi -- --reportId <id> --metric tbt --group diagnostic
  ```
- **Rebuild old reports for free with `--reanalyze`.** A stored `report.json` is a snapshot of whatever the aggregation rules produced on the day it was written, so improving the rules does nothing for history. `--reanalyze` re-derives the report from its own retained runs, costing no quota:
  ```bash
  npm run psi -- --reanalyze                 # every stored report on disk
  npm run psi -- --reanalyze --reportId <id> # just one
  npm run psi -- --reanalyze --no-save       # preview the changes, write nothing
  ```
  It reports what each rebuild changed — cost figures recovered, phantom zeroes corrected, and the set of failing metrics before and after. A rebuilt report only *fills in* a savings figure that was missing; a figure Lighthouse already gave is never overwritten with a rougher row-derived approximation. `runs.json` is left untouched, so a rebuild can always be redone.
- A report is cached for 10 minutes server-side; pass `force=true` only when you genuinely need a fresh measurement.
- If you see `429`, stop and report it. Do not retry in a loop and do not fall back to `runs=1` pretending that is a valid baseline.
- `INSUFFICIENT_RUNS` means fewer than 60% of runs returned data. The result is discarded on purpose — a median of 2 runs out of 10 is not a measurement. Check the `errors` array.

---

## 5. Worked examples

### 5.1 `POST /report` — 10 runs, mobile

```bash
curl -X POST http://127.0.0.1:3939/report \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","runs":10,"stat":"median","strategy":"mobile"}'
```

```json
{
  "reportId": "2026-09-29T05-45-30Z-mobile",
  "url": "https://example.com/",
  "finalUrl": "https://example.com/",
  "strategy": "mobile",
  "stat": "median",
  "runsRequested": 10,
  "runsSucceeded": 10,
  "lighthouseVersion": "13.5.0",
  "headline": { "score": 27, "metrics": { "lcp": 16070, "tbt": 2127, "cls": 0, "fcp": 7332, "speedIndex": 13287, "ttfb": 380 } },
  "score": {
    "mean": 27.4, "median": 27, "mode": 27,
    "min": 24, "max": 31, "stddev": 2.1, "count": 10,
    "values": [27, 26, 24, 28, 29, 27, 31, 25, 28, 30]
  },
  "metrics": {
    "lcp": { "mean": 16120.5, "median": 16070, "mode": 16000, "min": 15200, "max": 17400, "stddev": 640, "count": 10, "values": [] }
  },
  "stats": {
    "mean":   { "score": 27.4, "metrics": { "lcp": 16120.5 } },
    "median": { "score": 27,   "metrics": { "lcp": 16070 } },
    "mode":   { "score": 27,   "metrics": { "lcp": 16000 } }
  },
  "targets": {
    "strategy": "mobile",
    "targets": { "score": 90, "lcp": 2500, "tbt": 200, "cls": 0.1, "fcp": 1800, "speedIndex": 3400 },
    "meetsTarget": false,
    "gaps": [
      { "metric": "score", "actual": 27, "target": 90, "delta": -63, "meets": false },
      { "metric": "lcp", "actual": 16070, "target": 2500, "delta": 13570, "meets": false }
    ]
  },
  "insights": [],
  "fieldData": { "loadingExperience": {}, "originLoadingExperience": {} },
  "errors": []
}
```

### 5.2 `GET /report/:reportId/insights` — the LCP work queue

```bash
curl "http://127.0.0.1:3939/report/2026-09-29T05-45-30Z-mobile/insights?group=opportunity,diagnostic&maxScore=0.9&metric=lcp&sortBy=savingsMs&limit=3"
```

```json
{
  "reportId": "2026-09-29T05-45-30Z-mobile",
  "headline": { "score": 27, "metrics": { "lcp": 16070 } },
  "targets": { "meetsTarget": false, "gaps": [] },
  "totalInsights": 32,
  "matched": 3,
  "filters": { "group": ["opportunity", "diagnostic"], "maxScore": 0.9, "metric": ["lcp"], "sortBy": "savingsMs" },
  "insights": [
    {
      "id": "cache-insight",
      "title": "Use efficient cache lifetimes",
      "score": 0,
      "group": "diagnostic",
      "displayValue": "Est savings of 11,289 KiB",
      "savingsMs": 6550,
      "savingsBytes": 11520018,
      "savingsSource": "overall",
      "firstPartyShare": 1,
      "metricsAffected": ["lcp", "fcp"],
      "appearedInRuns": 10,
      "runsSucceeded": 10,
      "flaky": false,
      "items": [],
      "itemsTotal": 99
    }
  ]
}
```

`savingsSource` says where the figure came from: `overall` (Lighthouse's own rollup), `metricSavings` (its per-metric time impact), `items` (the per-row sum), or `displayValue` (parsed out of the human-readable string). `firstPartyShare` is `0`–`1`, or `null` when the cost could not be attributed to a host at all.

#### `fieldData` — the only field data in the report

Every report carries `fieldData`, passed through from PSI untouched:

```json
"fieldData": {
  "loadingExperience": { "initial_url": "https://example.com/", "metrics": { … }, "percentiles": { … } },
  "originLoadingExperience": { … }
}
```

**This is CrUX — real user measurements, not a lab run.** Everything else in a report is a Lighthouse lab measurement on one emulated device; this is what actual visitors experienced. It is the only place the tool can tell you whether the lab number reflects reality, and it is worth reading before you accept a change: a page whose CrUX `percentiles.lcp.p75` is already good while the lab LCP is poor means the lab is measuring a case real users do not hit.

- `loadingExperience` is keyed on the exact measured URL; `originLoadingExperience` covers the whole origin.
- **`{}` or `null` means insufficient traffic, not a bug.** CrUX only reports an origin once it has enough real sessions. A staging host will essentially always be empty — so on staging, judge on the lab numbers and say so in your report rather than treating the absence as a finding.
- It is stripped of the cache-busting nonce along with everything else, so `initial_url` never carries `?psi_nonce=`.
- It appears in `--json` and over HTTP. It is **not** rendered in the text output at all, and it is not part of `--diagnose`.

### 5.3 `GET /report/:reportId/diagnosis` — the ranked work queue

```bash
curl "http://127.0.0.1:3939/report/2026-09-30T03-46-50Z-mobile/diagnosis?party=first"
```

```json
{
  "reportId": "2026-09-30T03-46-50Z-mobile",
  "headline": { "score": 94, "metrics": { "lcp": 2401, "tbt": 117.5, "cls": 0, "fcp": 2153.8 } },
  "targets": { "meetsTarget": false, "medianPass": true, "gaps": [], "blockedBy": [] },
  "lcp": {
    "isText": true,
    "phases": { "ttfb": 578.17, "renderDelay": 1083.34 },
    "totalMs": 1662,
    "dominantPhase": "renderDelay",
    "bottleneck": "render"
  },
  "distributions": { "score": { "bimodal": true, "lanes": [] } },
  "priorityOrder": [ { "metric": "fcp", "actual": 2153.78, "target": 1800, "delta": 353.78, "passRate": 0, "meets": false } ],
  "primary": { "metric": "fcp", "actual": 2153.78, "target": 1800, "passRate": 0 },
  "ranked": [
    {
      "rank": 1,
      "insight": { "id": "render-blocking-insight", "savingsMs": 601, "savingsSource": "items", "firstPartyShare": 1 },
      "sop": { "sop": "§6/§8", "action": "Inline critical CSS or defer the rest; ship no JS on first fold" },
      "affectsFailing": ["fcp"],
      "thirdPartyOnly": false,
      "estimateFromText": false,
      "reason": "affects failing FCP; 100% first-party; 601ms est. saving"
    }
  ],
  "blocked": [],
  "unreliable": [ { "metric": "tbt", "passRate": 0.8, "overBudgetRuns": 2, "runsMeasured": 10 } ],
  "cautions": ["FCP reads as failing on 0% of runs ..."],
  "exhausted": false
}
```

Read it in this order: `primary` tells you the metric to work on, `ranked` is the queue, `unreliable` and `cautions` tell you which numbers not to over-read, and `exhausted` is `true` when the failing metrics have no first-party work left against them — stop and escalate rather than burning another iteration.

The same queue is produced by `npm run psi -- --reportId <id> --diagnose`. Both surfaces read the same code path, so the ranking cannot diverge between them.

### 5.4 `npm run psi -- --reanalyze` — rebuild stored reports for free

```bash
npm run psi -- --reanalyze --no-save
```

```
RE-ANALYZED 27 stored report(s), 25 with a changed conclusion, 68 cost figure(s) recovered, 373 phantom zero(es) corrected
  2026-09-30T04-17-57Z-mobile       same (not saved)
  2026-09-30T03-50-24Z-mobile       changed (not saved)
      render-blocking-insight: was 0, actually 601ms (from items)
      16 finding(s) claimed 0ms where Lighthouse gave no estimate
  2026-09-30T03-53-46Z-mobile       changed (not saved)
      unused-javascript: was 0, actually 1050ms (from items)
      failing: [fcp lcp] -> [fcp lcp speedIndex tbt]
```

Two different corrections are reported separately, and the distinction matters: a **recovered** figure is a real cost the tool had been hiding, while a **phantom zero** is a stored `0` that claimed an estimate of zero where Lighthouse gave none — it is corrected to `null`, not counted as a win. Drop `--no-save` to write the rebuilt reports back.

### 5.5 `POST /insights` — run and filter in one call

```bash
curl -X POST http://127.0.0.1:3939/insights \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","runs":10,"stat":"median","strategy":"mobile",
       "filters":{"group":["opportunity","diagnostic"],"maxScore":0.9,"metric":["tbt"],"limit":5}}'
```

Returns the same shape as 5.2, with `headline` and `targets` from a fresh 10-run report.

### 5.6 `GET /health`

```json
{ "status": "ok", "uptimeSeconds": 42, "apiKeyConfigured": true, "cacheEntries": 1, "activeJobs": 0 }
```

### 5.7 CLI — baseline, then a free re-filter

```bash
# costs 10 units
npm run psi -- https://www.guvi.co/ --runs 10 --stat median --strategy mobile
```

```
https://www.guvi.co/
mobile · Lighthouse 13.5.0 · median of 10/10 runs · 2026-09-30
measured under moto g power (2022) · CPU index 843 (higher = slower) · en-US · performance only

SCORE    95 / 100  target 90   p25 95 · p75 95 · p95 95 · range 94–95 · stddev 0.4

VERDICT  PASS  2 of 6 targets failing
        FCP 1991ms vs 1800ms (0/10 runs in target), SI 3427ms vs 3400ms (4/10 runs in target)

  METRIC       MEDIAN  TARGET  VERDICT      % OF TARGET                    RUNS IN TARGET
  FCP          1991ms  1800ms  +191ms over         111%  ████████×·······            0/10
  LCP          2476ms  2500ms  in target            99%  ████████┃·······            9/10
  Speed index  3427ms  3400ms  +27ms over          101%  ████████×·······            4/10
  TBT             8ms   200ms  in target             4%  ········┃·······           10/10
  CLS           0.000   0.100  in target             0%  ········┃·······           10/10

FINDINGS  32 shown
  EST. SAVING  INSIGHT                          AFFECTS  OURS   SEEN
        559ms  render-blocking-insight          LCP FCP  100%  10/10
        225ms  image-delivery-insight           LCP FCP     —  10/10
        150ms  cache-insight                    LCP FCP    0%  10/10
            —  bootup-time                      TBT      100%  10/10
         84KB  unused-javascript                LCP FCP  100%  10/10
  ...

saved as reportId 2026-09-30T08-04-23Z-mobile
```

The spread line reports the score's tail percentiles, and every failing gap carries its run count. **Note what is *not* here:** per-metric `p75`/`stddev`, per-metric bimodality, `fieldData`, and the insight rows. Add `--diagnose` for the ranked queue, LCP element, image checks and cautions; `--items` / `--requests` for the rows; `--json` for everything else (see 5.7.1).

```bash
# costs nothing - same stored report, TBT focus, flaky hidden, JSON out
npm run --silent psi -- --reportId 2026-09-29T05-45-30Z-mobile \
  --group opportunity,diagnostic --maxScore 0.9 --metric tbt --noFlaky --json
```

> Use `npm run --silent psi --` for anything you pipe or parse. Plain `npm run psi` prints npm's `> psi-api@1.0.0 psi` banner to **stdout**, which corrupts `--json` output. Human-readable output does not need it.

Useful flags: `--strategy desktop`, `--stat mean`, `--limit N`, `--search "third-party"`,
`--minSavingsMs 500`, `--minFirstPartyRatio 0.5`, `--sortBy firstPartyShare`,
`--id lcp-discovery-insight,image-delivery-insight`, `--no-save`, `--reanalyze`, `--help`.
Exit code is `0` on success and `1` on error.

#### 5.7.1 `--json` — everything the text view leaves out

`--json` is not "the same report, machine-readable". It is a **superset**, and several things you need exist *only* here. This is the single most under-used surface in the tool.

```bash
npm run --silent psi -- --reportId <id> --json
```

The payload is the whole `AggregatedReport`, plus four extra keys the report file does not have:

| Extra key | What it is |
| --- | --- |
| `images` | The full image-check list. The text view caps IMAGE CHECKS at 15 rows; this has every finding. |
| `matchedInsights` | The insights **after** your filters. `insights` alongside it is always the complete unfiltered set — use `matchedInsights` when you passed filters. |
| `diagnosis` | Present **only** when you also pass `--diagnose`. Same object `GET /report/:reportId/diagnosis` returns. |
| `warnings` | Array of strings. Empty is good; the PSI-cache warning lands here. |

And inside the report itself, these are JSON-only:

| Field | Why you want it |
| --- | --- |
| `metrics.<metric>.p75` / `p95` / `stddev` / `values` | **The metric's own spread.** Step 9 tells you to judge on these; the text view prints a spread line for the score only. |
| `distributions.<metric>` | Bimodality per metric, with `lanes`, `share`, `separation` and `note`. `--diagnose` cautions on the *score's* split only. |
| `stats.mean` / `stats.median` / `stats.mode` | Every metric recomputed under each statistic, side by side. |
| `fieldData` | CrUX real-user data — the only field-vs-lab signal. See 5.2. |
| `requests[]` | Every request with `resourceSize`, `statusCode`, `priority`, `entity`, `mimeType`. `--requests` prints a subset. |
| `insights[].title` / `description` | Lighthouse's own explanation of each audit. `--items` prints rows, not prose. |
| `insights[].displayValue` | The raw human string savings were parsed from — how you audit a suspicious estimate. |
| `insights[].itemHosts` | The distinct hosts behind the rows. This is what tells you "not actionable in repo". |
| `insights[].firstPartyItems` / `thirdPartyItems` | The counts behind `firstPartyShare`. |
| `insights[].stats` | mean/median/mode of *that insight's* score and savings — shows whether a saving is consistent across runs. |
| `environment` | The full record including `benchmarkIndex`, `hostUserAgent`, `channel`, `categories`. |

A worked read — is the metric I changed actually bimodal, and how tight is it? With `jq`:

```bash
npm run --silent psi -- --reportId <id> --json | jq '{
  lcp:  (.metrics.lcp | {median, p75, stddev}),
  fcp:  (.metrics.fcp | {median, p75, stddev}),
  bimodalLcp: .distributions.lcp.bimodal,
  field: .fieldData,
  warnings
}'
```

`jq` is not always installed. The same read in `node`, which the tool already depends on:

```bash
npm run --silent psi -- --reportId <id> --json > report.tmp.json
node -e '
const r = require("./report.tmp.json");
const spread = (k) => ({ median: r.metrics[k].median, p75: r.metrics[k].p75, stddev: r.metrics[k].stddev });
console.log(JSON.stringify({
  lcp: spread("lcp"), fcp: spread("fcp"),
  bimodalLcp: r.distributions.lcp.bimodal,
  field: r.fieldData, warnings: r.warnings
}, null, 2));'
rm report.tmp.json
```

> Two traps this avoids. **Redirect to a file rather than piping** — if the reader exits early the CLI dies with an unhandled `EPIPE` and prints a stack trace. And **write the file into the current directory**: `require("/tmp/…")` works on a POSIX shell but fails on Windows, where Node resolves `/tmp` literally.

**`--items` and `--json` compose differently, and it surprises people.** With `--items` the named ids are printed as rows; with `--json` the same flag is silently converted into an `id` filter (`src/cli.ts`), so you get the matching insights — rows included — under `matchedInsights`. `--requests` is ignored under `--json`, because `requests` is already in the payload.

### 5.8 `runs.json` — per-run detail nothing else exposes

Every free command above reads `report.json`, which is an **aggregate**. The individual runs live beside it:

```
data/<host>/<reportId>/
  report.json   # the aggregate - what every CLI flag and endpoint returns
  runs.json     # array of NormalizedReport, one per successful run
```

Nothing in the CLI or the HTTP API reads `runs.json` except `--reanalyze`. It is the only place you can see:

| Field | Only available here |
| --- | --- |
| `runs[].metrics` | Every metric of that individual run — the raw series behind `p25`/`stddev` |
| `runs[].environment` | That run's own `benchmarkIndex`, `networkUserAgent`, `lighthouseVersion` |
| `runs[].requests[]` | That run's own request table. `report.json` keeps only the **median** run's. |
| `runs[].insights[]` | That run's insights, including ones absent from the median run |
| `runs[].fetchTime` | When the run happened |

This matters more than it sounds. `report.environment` is taken from the run **closest to the median**, so it is one run's conditions, not the set's. On one real stored report here, `report.environment.benchmarkIndex` read 473.5 while the ten runs behind it ranged from **105.5 to 1292.5** — a twelve-fold spread in the CPU each was scored against. The "measured under" line is honest about what it is, but it is not a summary, and two runs measured under materially different CPU conditions are not two samples of one population. That report's `distributions.lcp.bimodal` is `true` for exactly this reason.

```bash
# every run's CPU benchmark index, with the score and timestamp  (jq)
jq -r '.[] | "\(.environment.benchmarkIndex)\t\(.score)\t\(.fetchTime)"' \
  data/<host>/<reportId>/runs.json

# same thing without jq
node -e 'require(process.argv[1]).forEach(r =>
  console.log(r.environment.benchmarkIndex, r.score, r.fetchTime))' \
  ./data/<host>/<reportId>/runs.json

# per-run LCP series
node -e 'console.log(require(process.argv[1]).map(r => r.metrics.lcp).join(", "))' \
  ./data/<host>/<reportId>/runs.json
```

Reading `runs.json` is free and read-only. Do not edit it — `--reanalyze` rebuilds from it, and it is never rewritten, so a rebuild can always be redone.

### 5.9 GitHub — find the staging PR and poll it

Verified against `guvi-geek/qwik-guvi` on 2026-09-29, branch `perf-fix`:

```bash
$ gh pr list --head perf-fix --state open --json number,url,headRefName
[{"headRefName":"perf-fix","number":1220,"url":"https://github.com/guvi-geek/qwik-guvi/pull/1220"}]

$ gh run list --branch perf-fix --limit 3
(no output — this repo has no GitHub Actions workflows)
```

So on this repo the staging PR number is discoverable, and the poll loop runs, but there is nothing for GitHub Actions to report. The build is CodeBuild via `buildspec.yml`. The agent's fallback is to poll the staging URL's build hash each minute, and to ask a human which pipeline the branch triggers.

### 5.10 Why one push per settled build

A correct timeline, and the mistake next to it:

```
14:10  push A                          build A starts
14:12  push B   ← WRONG                build A cancelled, build B starts
       └ staging may now serve A's shell with B's missing chunks
14:20  run A/B concludes               only now is a push safe
14:22  push C  (after the fix)         ok
```

```
14:10  push A                          build A starts
14:12  poll → in_progress              ⛔ no push
14:13  poll → in_progress              ⛔ no push
...
14:20  poll → success                  build settled
14:21  push B  (if still needed)       ok
```

The second timeline costs nothing but waiting. The first one can take staging down for every other user of that host, and the resulting 404s on chunks look like a performance regression rather than a deploy you broke.

---

## 6. Quick reference

```bash
cd psi-api
npm run psi -- <url> --runs 10 --stat median --strategy mobile   # baseline
npm run psi -- --reportId <id> --diagnose --party first          # the ranked work queue
npm run psi -- --reportId <id> --metric lcp --sortBy savingsMs   # free re-filter
npm run psi -- --reanalyze --no-save                              # rebuild stored reports, free
npm run --silent psi -- --reportId <id> --metric tbt --noFlaky --json  # machine output
npm test                                                          # the tool's own tests
```

```bash
# staging deploy: push, open the page's staging PR, then poll it
git push -u origin <branch>                              # only when no build is in flight
gh pr create --base development --head <branch> --title "perf: <what> (<insight-id>) on <page>"
sleep 600                                    # flat 10 min before the first poll
PR=$(gh pr list --head <branch> --state open --json number --jq '.[0].number')
gh pr checks "$PR"                           # then repeat every 60s until the run concludes
gh run view <run-id> --log-failed            # when a poll reports failure
# ⛔ no git push until a poll reports a terminal conclusion (success/failure/cancelled)
```

```bash
# server mode, if you want the HTTP API
npm run dev                     # http://127.0.0.1:3939
curl http://127.0.0.1:3939/health
```

**Checklist before you say you are done:**

- [ ] `sop-qwik.md` read in full this session
- [ ] Baseline and re-measurement both free of the "same analysis timestamp" cache warning
- [ ] Work queue built with `--diagnose --party first`
- [ ] IMAGE CHECKS read; `fine` oversized rows left alone
- [ ] `--items` opened for the chosen insight, and every chosen finding grepped to a real file
- [ ] `--requests` checked for heavy images and unexpected third-party hosts
- [ ] `PSI_FIRST_PARTY_HOSTS` includes `guvi.in,guvi.co`, so `static.guvi.in` is treated as ours
- [ ] Lazy-loading: IMAGE CHECKS plus a browser pass at 412 × 823 for CSS backgrounds (Step 3d, playbook 3)
- [ ] Third-party findings logged as "not actionable in repo", not attempted
- [ ] Every change maps to an action the SOP allows
- [ ] No raw `<img>` introduced; no existing `object-fit` changed; no Figma asset swapped for an icon
- [ ] No `useVisibleTask$` added to the first fold; no orphan exported component; no `routeAction$` / `server$`
- [ ] No dependency added, removed, or version-bumped
- [ ] Change verified in a browser at 375 / 576 / 768 / 992 / 1200, not just by a green build
- [ ] One focused change, on a branch off `development`, rebased on latest `development` before final push
- [ ] Commit message names the insight id, no AI attribution
- [ ] Built, linted, typechecked
- [ ] Staging PR opened for this page, number captured
- [ ] **No push issued while a build was in progress** — branch frozen until terminal conclusion
- [ ] Waited a flat 10 minutes, then polled every 60s until the deploy settled
- [ ] Confirmed the new build hash is being served, not a stale edge
- [ ] Re-measured with 10 runs
- [ ] Desktop measured once mobile met its target, and it meets its own target
- [ ] Improvement beat the baseline `stddev`, or the change was reverted
- [ ] `optimization-log.md` appended
- [ ] `psi-api/` untouched
- [ ] `config/targets.json` untouched
- [ ] Reported DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT (SOP §10.4)
