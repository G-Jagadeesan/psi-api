# AGENT_GUIDE — using `psi-api` to optimize a page

This guide is for an **autonomous agent** driving a page toward a performance target, and for the human supervising it.

Read it end to end before your first run. The short version:

> Measure with 10 runs. Pick the biggest failing insight. **Read `../sop-qwik.md` and obey it.** Make one small change. Deploy it — PSI measures a live public URL, so an undeployed change is not measurable. Measure again. Keep it only if the improvement beats the noise. Otherwise revert.

The tool is read-only to you. You use it; you do not modify it.

---

## 0. Orientation

| | |
| --- | --- |
| Tool root | `psi-api/` |
| Human docs | `psi-api/README.md` |
| **Binding rules** | `sop-qwik.md` in the repo root — **read in full before your first code change** |
| Targets | `psi-api/config/targets.json` |
| Your log | `psi-api/data/<host>/optimization-log.md` |
| App being optimized | `qwik-guvi/` |

Two rules that outrank everything else in this document:

1. **`sop-qwik.md` governs every change you make to the app.** This guide only tells you *how to measure*. It never authorizes a change the SOP forbids or does not cover.
2. **`psi-api/` is read-only during optimization.** You may append to the optimization log. Nothing else.

---

## 1. The loop

### Step 1 — Baseline

```bash
cd psi-api
npm run psi -- https://www.guvi.co/ --runs 10 --stat median --strategy mobile
```

Record the whole output, especially `headline`, `score.stddev`, and the gaps.

> **The URL must be reachable from Google's servers.** PSI runs its bots in Google's public cloud. A page on a private network, or one that blocks Google, returns `FAILED_DOCUMENT_REQUEST` or `ERR_CONNECTION_FAILED` on every run and you will waste the whole iteration discovering that. Confirm the URL loads in a browser *and* is publicly reachable before starting.

### Step 2 — Stop condition

If `meetsTarget` is `true`, **stop.** Report success with before/after numbers. Do not keep hunting for wins; the target is met.

If `meetsTarget` is `false`, read `targets.gaps` to see exactly which metric is over budget:

```
BELOW TARGET  score -63 lcp +13570 tbt +1927
```

`+` means over budget. Work the worst one first, weighted by what Lighthouse says it costs.

### Step 3 — Build the work queue

```bash
npm run psi -- --reportId <reportId> \
  --group opportunity,diagnostic --maxScore 0.9 \
  --sortBy savingsMs --limit 10
```

Using `--reportId` re-filters the report you already paid for. **Never re-run PSI just to change a filter** — each run is a quota unit and several minutes of wall clock.

Add `--metric lcp` / `tbt` / `cls` to focus on the metric that is actually failing, and `--noFlaky` to drop intermittent findings.

**Prioritize like this:**

1. The metric that is failing, in this order: **LCP → TBT → CLS → score**.
2. Within it, the largest `savingsMs` first.
3. `flaky: true` insights (seen in under 30% of runs) go to the bottom — they are usually a third party you do not control.
4. A `diagnostic` with a large saving beats an `opportunity` with a small one.

Before you commit to a fix, sanity-check the number. Lighthouse savings are estimates and routinely disagree with reality — a "1.2 s LCP saving" on a page whose LCP is 16 s is a rounding error, not a win. **Rank by what moves the failing metric, not by the raw saving.**

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
| `third-parties-insight` | Third-party cost | Usually **not yours** — document it, do not attempt it |
| `cls-culprits-insight`, `cumulative-layout-shift` | Layout shift | §5 spacing, §7 never Store static arrays, images need dimensions |
| `forced-reflow-insight` | Synchronous layout thrash | §7 no `useVisibleTask$` on first fold, §7 `noSerialize` for lib instances |
| `cache-insight`, `document-latency-insight` | Headers / server latency | **Likely outside the frontend.** If the SOP does not cover it, stop and ask. |
| `non-composited-animations` | Animating layout properties | §8 GPU-only (`transform`/`opacity`) — explicitly required |
| `dom-size-insight` | Oversized DOM | §4 components must be self-contained; §7 no duplicated markup |

**If the SOP does not cover the fix, or covers it differently than the insight suggests: stop and ask a human. Do not improvise a change to the app.** The SOP's precedence is explicit user ask > `DESIGN.md` > SOP > neighbor style, and it forbids disabling lint rules and unapproved packages. A performance win is not a licence to bypass that.

### Step 5 — One change

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

### Step 7 — Deploy. This is not optional.

**PSI measures a live public URL. A change that is not deployed is not measurable.** Measuring your local server measures nothing.

Per SOP §2 and §10, `qwik-guvi` deploys to **Cloudflare Pages** as primary:

```bash
cd qwik-guvi
npm run build          # must pass
npm run build.types && npm run lint && npm run fmt.check
npm run deploy         # wrangler pages deploy ./dist
```

CI is **AWS CodeBuild (`buildspec.yml`)**, not GitHub Actions — pushing may be enough to deploy, or you may need to trigger the pipeline. Check `buildspec.yml` and confirm with a human if you are unsure which path this repo currently uses. Other supported targets per SOP §2: AWS Lambda, Express, Docker→ECS.

**Wait for the deployment to be live on the measured URL before measuring.** Caching layers (Cloudflare) can serve stale assets; if a measurement looks unchanged immediately after deploy, verify the new build is actually being served before concluding the change did nothing.

### Step 8 — Re-measure and decide

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

Also check the target metric you were actually fixing, not just the score. A change that trades LCP for CLS may leave the score flat while making things worse for users.

### Step 9 — Log it

Append to `psi-api/data/<host>/optimization-log.md`. **Append-only — never edit or delete earlier entries.**

```markdown
## Iteration 3 - 2026-09-29T11:20:00Z

**Insight targeted:** `lcp-discovery-insight` (diagnostic, 750ms, affects lcp)
**Change made:** Added `fetchpriority="high"` to the Unpic hero image in
`src/routes/learn/[courseId]/components/hero/hero.tsx`.
**Commit:** `perf: preload LCP hero image (lcp-discovery-insight)` on `perf/lcp-hero`
**Baseline:**  median 27 (stddev 3.1)  LCP 16070ms  TBT 2127ms
**After:**     median 31 (stddev 2.8)  LCP 14810ms  TBT 2102ms
**Delta:**     +4.0 median (> 3.1 stddev)  LCP -1260ms
**Verdict:**   KEPT
```

### Step 10 — Repeat or stop

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

**If the tool itself looks broken** — a wrong number, a crash, a filter that returns nonsense — do not patch it. Report it with a reproduction and move on to the next insight, or stop. A broken measuring instrument must never be quietly adjusted to produce a number you like.

---

## 3. Noise, and how to read it

**Why 10 runs.** A single Lighthouse run is a lab measurement on a shared, throttled connection. Run-to-run score varies by several points on an unchanged page. Ten runs gives the median something stable to sit on and gives `stddev` enough samples to be meaningful. Three runs is a reasonable quick look while you are still exploring; it is not enough to accept a change on.

**Why median is the headline.** Lighthouse is right-skewed — an occasional run catches a slow third-party response and drags the page down. The mean follows those outliers; the median does not. Compare **median to median**.

**When to use mean.** Only when you specifically care about average user cost, and always alongside `stddev`. Useful for judging how bad the bad runs are, not for deciding whether a change worked.

**When to use mode.** The most frequently observed bucket, after bucketing (score to 1 point, time metrics to 100 ms, CLS to 0.01). Read it as "what this page typically scores". It is a good sanity check: if `mode` and `median` disagree wildly, the page is bimodal — usually one flaky third party — and you should look at the raw `values` array before trusting either.

**What `flaky: true` means.** The insight appeared in fewer than 30% of successful runs. It is intermittent. Deprioritize it: a flaky finding may not reproduce when you re-measure, so you cannot tell your fix from the noise. If a flaky insight is enormous, check whether a third party is involved before touching anything.

**Accepting a change.** Require the improvement to exceed roughly one `stddev` of the baseline. If it does not, the honest answer is "inconclusive", not "small win". Re-measure once to break the tie; if still inconclusive, revert and note it in the log. Small real wins are still real — but you cannot distinguish them from noise, and shipping a change you cannot measure is how regressions accumulate.

---

## 4. Quota

**Each run costs one PSI API unit. A 10-run check costs 10.** Google gives each API key a daily cap; exceeding it returns `429` for the rest of the day.

- **Always set `PSI_API_KEY`.** Without one you share a tiny anonymous quota that is usually already exhausted.
- Budget explicitly: a 10-iteration loop with a 10-run baseline and a 10-run re-measure per iteration is **~200 units**. Know your daily cap before you start.
- `PSI_CONCURRENCY` (default 2) controls how many calls are in flight. Higher is not faster overall — PSI is server-side bound, and you risk rate limiting. Leave it at 2.
- **Re-filter with `--reportId`, never re-run.** Changing a filter is free:
  ```bash
  npm run psi -- --reportId <id> --metric tbt --group diagnostic
  ```
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

### 5.3 `POST /insights` — run and filter in one call

```bash
curl -X POST http://127.0.0.1:3939/insights \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","runs":10,"stat":"median","strategy":"mobile",
       "filters":{"group":["opportunity","diagnostic"],"maxScore":0.9,"metric":["tbt"],"limit":5}}'
```

Returns the same shape as 5.2, with `headline` and `targets` from a fresh 10-run report.

### 5.4 `GET /health`

```json
{ "status": "ok", "uptimeSeconds": 42, "apiKeyConfigured": true, "cacheEntries": 1, "activeJobs": 0 }
```

### 5.5 CLI — baseline, then a free re-filter

```bash
# costs 10 units
npm run psi -- https://www.guvi.co/ --runs 10 --stat median --strategy mobile
```

```
https://www.guvi.co/  [mobile]
score 27/100  (median of 10/10 runs)
LCP 16070ms!  TBT 2127ms!  CLS 0.000   FCP 7332ms!  SI 13287ms!
spread: score stddev 2.1 · values 27, 26, 24, 28, 29, 27, 31, 25, 28, 30
BELOW TARGET  score -63 lcp +13570 tbt +1927 fcp +5532 speedIndex +9887

INSIGHTS (6 of 32)
  SAVING   ID                        GROUP        METRIC   ITEMS
  6550ms   cache-insight             diagnostic   lcp,fcp  99
  1960ms   unused-javascript         opportunity  lcp,fcp  22
  1200ms   image-delivery-insight    diagnostic   lcp,fcp  5
  750ms    render-blocking-insight   diagnostic   lcp,fcp  1
  150ms    unused-css-rules          opportunity  lcp,fcp  3
  -        lcp-discovery-insight     diagnostic   lcp      2

reportId 2026-09-29T05-45-30Z-mobile
```

```bash
# costs nothing - same stored report, TBT focus, flaky hidden, JSON out
npm run --silent psi -- --reportId 2026-09-29T05-45-30Z-mobile \
  --group opportunity,diagnostic --maxScore 0.9 --metric tbt --noFlaky --json
```

> Use `npm run --silent psi --` for anything you pipe or parse. Plain `npm run psi` prints npm's `> psi-api@1.0.0 psi` banner to **stdout**, which corrupts `--json` output. Human-readable output does not need it.

Useful flags: `--strategy desktop`, `--stat mean`, `--limit N`, `--search "third-party"`,
`--minSavingsMs 500`, `--id lcp-discovery-insight,image-delivery-insight`, `--no-save`, `--help`.
Exit code is `0` on success and `1` on error.

---

## 6. Quick reference

```bash
cd psi-api
npm run psi -- <url> --runs 10 --stat median --strategy mobile   # baseline
npm run psi -- --reportId <id> --metric lcp --sortBy savingsMs   # free re-filter
npm run --silent psi -- --reportId <id> --metric tbt --noFlaky --json  # machine output
npm test                                                          # the tool's own tests
```

```bash
# server mode, if you want the HTTP API
npm run dev                     # http://127.0.0.1:3939
curl http://127.0.0.1:3939/health
```

**Checklist before you say you are done:**

- [ ] `sop-qwik.md` read in full this session
- [ ] Every change maps to an action the SOP allows
- [ ] One focused change, on a branch off `development`
- [ ] Commit message names the insight id, no AI attribution
- [ ] Built, linted, typechecked, deployed, and confirmed live
- [ ] Re-measured with 10 runs
- [ ] Improvement beat the baseline `stddev`, or the change was reverted
- [ ] `optimization-log.md` appended
- [ ] `psi-api/` untouched
- [ ] `config/targets.json` untouched
- [ ] Reported DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT (SOP §10.4)
