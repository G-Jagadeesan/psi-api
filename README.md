# psi-api

A small, deterministic wrapper around the [Google PageSpeed Insights](https://developers.google.com/speed/docs/insights/v5/get-started) v5 API.

It exists to answer two questions reliably:

1. **How fast is this page, really?** One PSI run is noisy. This tool runs N times, aggregates, and reports the median alongside mean/mode plus the standard deviation so you can tell a real improvement from measurement drift.
2. **What should I fix first?** Every Lighthouse audit is normalized into a filterable insight with estimated savings, so you can ask for exactly the failures that hurt LCP or TBT, sorted by cost.

It is usable three ways — an HTTP API, a CLI, or the same functions as a library — and it keeps raw runs on disk so a report can be re-filtered later without spending more quota.

> This folder is self-contained. It has its own `package.json` and its own git repo, and it does not depend on, or affect, the Qwik app in `../qwik-guvi`.

---

## Setup

```bash
cd psi-api
npm install
cp .env.example .env    # then paste your key
npm test
npm run dev              # http://127.0.0.1:3939
```

### Getting a PSI API key

Without a key, PSI falls back to a shared anonymous quota that is **frequently already exhausted** — in practice you get `HTTP 429 Quota exceeded` before your first run finishes. Get a key:

1. Create a project in the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **PageSpeed Insights API** for it.
3. Create an API key (APIs & Services → Credentials → Create credentials → API key).
4. Put it in `psi-api/.env`:

   ```
   PSI_API_KEY=AIza...
   ```

`.env` is gitignored. Never commit the key.

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PSI_API_KEY` | *(unset)* | Google PSI key. Optional but strongly recommended. |
| `PORT` | `3939` | HTTP port. |
| `HOST` | `127.0.0.1` | Bind address. |
| `PSI_CONCURRENCY` | `10` | Concurrent PSI calls per report (capped at 10). Quota is per run, not per concurrent call. Use `2` without an API key. |
| `PSI_FIRST_PARTY_HOSTS` | *(unset)* | Extra domains the measured site owns, comma-separated (`guvi.in,guvi.co`). Without this, a CDN on a sister host is filed as third-party. |
| `LOG_LEVEL` | `info` | Pino log level for the server. |
| `PSI_DATA_DIR` | `./data` | Where reports are written. |

---

## Quick start

```bash
# CLI, 10 runs, median headline, human-readable
npm run psi -- https://example.com/

# JSON, only the opportunities that are actually failing
npm run --silent psi -- https://example.com --group opportunity,diagnostic --maxScore 0.9 --json
```

> `--silent` matters for anything machine-parsed. `npm run` writes its own `> psi-api@1.0.0 psi` banner to **stdout**, which breaks `npm run psi -- ... --json | jq`. Use `npm run --silent psi --` whenever the output is piped or parsed.

> The URL has to be reachable **from Google's public cloud**, not just from your machine. `https://www.guvi.co/` and `https://www.guin.com/` both currently return `FAILED_DOCUMENT_REQUEST` on every run for that reason, so neither is usable as a measurement target until it is publicly reachable.

```
run 6/10  score 95
run 5/10  score 95
run 2/10  score 95
...
run 3/10  score 95

https://qwik-guvi-perf-fix.codingpuppet.com/zen-class/
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

  — in SAVING means Lighthouse gave no estimate, which is not zero.
  OURS is how much of the cost your own code is responsible for.

saved as reportId 2026-09-30T08-04-23Z-mobile
```

Every part of this is explained in [Reading the output](#reading-the-output).

---

## HTTP API

All responses are JSON. Errors are always `{ "error": { "code", "message" } }` with a matching status code.

### `POST /report` (or `GET /report?...`)

Runs PSI and returns the aggregated report. **This costs `runs` quota units and takes a while** — for anything above ~3 runs, prefer `?async=true`.

| Param | Default | Notes |
| --- | --- | --- |
| `url` | *required* | Must be public `http`/`https`. |
| `strategy` | `mobile` | `mobile` or `desktop`. |
| `runs` | `10` | 1–25. |
| `stat` | `median` | `mean`, `median` or `mode`. Headline statistic. |
| `force` | `false` | Skip the 10-minute cache. |
| `async` | `false` | Return `{ jobId }` immediately instead of waiting. |

```bash
# single fast check
curl "http://127.0.0.1:3939/report?url=https://example.com&runs=3"

# full 10-run report, as JSON body
curl -X POST http://127.0.0.1:3939/report \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","runs":10,"stat":"median","strategy":"mobile"}'

# don't block on a long run
curl -X POST http://127.0.0.1:3939/report \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","runs":10,"async":true}'
# -> {"jobId":"job_m1a2b3_7","status":"queued"}

curl http://127.0.0.1:3939/jobs/job_m1a2b3_7
```

Responses for the same `url` + `strategy` + `runs` + `stat` are cached in memory for 10 minutes; a cache hit is returned with `"cached": true`. Use `force=true` to measure again immediately.

### `GET /report/:reportId`

Re-reads a stored report from disk. No quota cost.

```bash
curl http://127.0.0.1:3939/report/2026-09-29T10-30-00Z-mobile
```

### `GET /report/:reportId/insights`

Filters a stored report. Every parameter is optional and they all combine.

| Param | Meaning |
| --- | --- |
| `group` | `opportunity`, `diagnostic`, `passed`, `informative`. Comma-separated. |
| `minSavingsMs` / `minSavingsBytes` | Minimum estimated saving. |
| `maxScore` | Only audits scoring at or below this, e.g. `0.9` for failing/weak. |
| `metric` | `lcp`, `tbt`, `cls`, `fcp`, `speedIndex`, `tti`, `ttfb`, `inp`. Comma-separated. |
| `search` | Case-insensitive substring of audit id or title. |
| `id` | Exact audit ids, comma-separated. |
| `hasItems` | `true` = only audits carrying a `details.items` list. |
| `sortBy` | `savingsMs` (default), `savingsBytes`, `score`, `firstPartyShare`. |
| `order` | `desc` (default) or `asc`. |
| `party` | `any` (default), `first`, `third`. See below. |
| `minFirstPartyRatio` | `0`–`1`. Keep only insights whose `firstPartyShare` is at least this. |
| `limit` | Max results. |
| `includeFlaky` | `true` (default). `false` hides insights seen in <30% of runs. |

```bash
# the LCP work queue
curl "http://127.0.0.1:3939/report/$ID/insights?group=opportunity,diagnostic&maxScore=0.9&metric=lcp&sortBy=savingsMs"

# everything that could save at least 100ms, cheapest first
curl "http://127.0.0.1:3939/report/$ID/insights?minSavingsMs=100&order=asc"

# mostly your own cost, ranked by how much of it is yours
curl "http://127.0.0.1:3939/report/$ID/insights?minFirstPartyRatio=0.5&sortBy=firstPartyShare"
```

The response carries the headline numbers and target verdict alongside the filtered list, so one call is usually enough:

```json
{
  "reportId": "2026-09-29T10-30-00Z-mobile",
  "headline": { "score": 58, "metrics": { "lcp": 3210, "tbt": 90 } },
  "targets": {
    "meetsTarget": false,
    "medianPass": true,
    "gaps": [ { "metric": "lcp", "actual": 3210, "target": 2500, "delta": 710, "passRate": 0.8, "overBudgetRuns": 2, "runsMeasured": 10, "p75": 3400, "p95": 3900, "meets": false } ],
    "blockedBy": []
  },
  "lcp": { "isText": true, "phases": {}, "bottleneck": "render" },
  "distributions": { "score": { "bimodal": false } },
  "totalInsights": 19,
  "matched": 3,
  "insights": [ /* ... */ ]
}
```

### `GET /report/:reportId/diagnosis`

The ranked work queue. Where `/insights` answers "what did Lighthouse find", this answers "what should I work on": it orders findings by how they bear on the metrics that are actually failing, attaches the playbook route for each, and reports the things that would otherwise be over-read.

```bash
curl "http://127.0.0.1:3939/report/$ID/diagnosis?party=first"
```

| Field | |
| --- | --- |
| `priorityOrder` | Failing gaps, worst relative overshoot first. |
| `primary` | The single metric to work on. |
| `ranked` | The queue: each finding with its `sop` route, `affectsFailing`, `firstPartyShare`, `thirdPartyOnly` and a plain-English `reason`. |
| `unreliable` | Metrics whose median is inside budget but whose runs are not — the false-PASS case. |
| `blocked` | Budgets the server round trip makes unreachable. |
| `cautions` | Everything that changes how the numbers should be read. |
| `exhausted` | `true` when the failing metrics have no first-party work left against them. Stop and escalate. |

`npm run psi -- --reportId <id> --diagnose` renders the same queue as text, through the same code path.

### `POST /insights`

One call that runs (or reuses) a report and applies filters to it — the HTTP equivalent of the CLI.

```bash
curl -X POST http://127.0.0.1:3939/insights \
  -H 'content-type: application/json' \
  -d '{
        "url": "https://example.com",
        "runs": 10,
        "stat": "median",
        "strategy": "mobile",
        "filters": { "group": ["opportunity", "diagnostic"], "maxScore": 0.9, "sortBy": "savingsMs", "limit": 5 }
      }'
```

### `GET /health`

```bash
curl http://127.0.0.1:3939/health
# {"status":"ok","uptimeSeconds":42,"apiKeyConfigured":true,"cacheEntries":0,"activeJobs":0}
```

---

## CLI

```bash
npm run psi -- <url> [options]
```

Runs the same core code as the server, so no server is needed.

| Option | Default | |
| --- | --- | --- |
| `--reportId <id>` | — | Re-filter a **stored** report. Costs no quota and runs no PSI calls. |
| `--reanalyze` | off | Rebuild stored report(s) from their own retained runs with today's rules. Costs no quota. Combine with `--reportId`, or omit it to sweep everything in `data/`. |
| `--runs <n>` | `10` | 1–25. |
| `--stat <mean\|median\|mode>` | `median` | Headline statistic. |
| `--strategy <mobile\|desktop>` | `mobile` | |
| `--group <list>` | — | `opportunity,diagnostic,passed,informative`. |
| `--minSavingsMs <n>` | — | |
| `--minSavingsBytes <n>` | — | |
| `--maxScore <n>` | — | e.g. `--maxScore 0.9`. |
| `--metric <list>` | — | `lcp,tbt,cls,fcp,speedIndex,tti,ttfb,inp`. |
| `--search <text>` | — | Matches audit id or title. |
| `--id <list>` | — | Exact ids. |
| `--hasItems` / `--noItems` | — | Require / forbid a details item list. |
| `--sortBy <savingsMs\|savingsBytes\|score\|firstPartyShare>` | `savingsMs` | |
| `--order <asc\|desc>` | `desc` | |
| `--party <any\|first\|third>` | `any` | Whose cost counts. See below. |
| `--minFirstPartyRatio <n>` | — | Keep only insights that are at least this fraction yours. |
| `--diagnose` | off | Print the ranked work queue, the LCP element, image checks, and the cautions. |
| `--items <list>` | — | Print every row of these insight ids (URLs, elements, snippets). |
| `--requests [start\|size]` | — | Print every request the median run made. Honours `--party` and `--limit`. |
| `--limit <n>` | — | |
| `--noFlaky` | — | Hide insights seen in <30% of runs. |
| `--json` | off | Machine-readable output. |
| `--no-save` | off | Don't write to `data/`. |

```bash
npm run psi -- https://example.com --runs 3
npm run psi -- https://example.com --group opportunity --metric lcp --sortBy savingsMs --limit 5
npm run psi -- https://example.com --search "third-party" --json

# refine a report you already paid for - free, no PSI calls
npm run psi -- --reportId 2026-09-29T10-30-00Z-mobile --metric tbt --noFlaky

# the ranked work queue for a report you already paid for - also free
npm run psi -- --reportId 2026-09-29T10-30-00Z-mobile --diagnose --party first

# the rows of one insight, and the request table
npm run psi -- --reportId 2026-09-29T10-30-00Z-mobile --items image-delivery-insight
npm run psi -- --reportId 2026-09-29T10-30-00Z-mobile --requests size --limit 20

# upgrade stored reports written by older aggregation rules - free
npm run psi -- --reanalyze --no-save
```

Filters compose with `--reportId`, so narrowing a work queue after a 10-run baseline never costs another quota unit.

**Use `--diagnose --party first` when building a work queue.** `--diagnose` ranks findings by how they bear on the metrics that are actually failing, instead of leaving you to infer that from a flat savings sort.

### Reading the output

The default view, top to bottom. The sample in [Quick start](#quick-start) shows each part.

**Progress lines** (stderr, only when PSI is actually run). One `run N/10  score S` line per run as it finishes. Runs execute concurrently (`PSI_CONCURRENCY`), so they arrive out of order — the number is the run's slot, not its finishing position. A failed run prints `run N/10  FAILED  <reason>`, and a retry prints `retry: <reason> (<delay>ms)`. Warnings such as the [PSI cache](#psi-caches-per-url) warning are printed after the last run.

**Header.** The measured URL (without the cache-busting nonce), then `strategy · Lighthouse version · <stat> of <succeeded>/<requested> runs · date`, then the [measured under](#the-measured-under-line) line.

**SCORE.** The headline score (the chosen `--stat`, median by default), its target, then the spread across runs: `p25`, `p75`, `p95`, `range` (min–max) and `stddev`. The score is green at 90+, yellow at 50–89 and red below 50, matching Lighthouse's own bands. When the score is [bimodal](#bimodality) a yellow line under it describes the two groups.

**VERDICT.** `N of M targets failing` counts every target in `config/targets.json` for the strategy — the score plus the five metrics in the table. A target fails when fewer than 90% of runs hold it, not only when the median misses (see [A budget is graded on the tail](#a-budget-is-graded-on-the-tail-not-the-median)). The word is `FAIL` only when **more than half** the targets fail, so `PASS  2 of 6 targets failing` is a mostly-healthy page that still has work to do; `meetsTarget` in the JSON is the strict all-targets verdict. The line under it names up to four failing targets, worst relative overshoot first, with how many runs held each. Two optional yellow lines can follow: one when every median is in target but the tail is not, and `not fixable from here: …` for a [budget the frontend cannot meet](#budgets-the-frontend-cannot-meet).

**Metric table.** One row per graded metric (FCP, LCP, Speed index, TBT, CLS). The score has no row; it is on the SCORE line.

| Column | Meaning |
| --- | --- |
| `METRIC` | Red when the median is over its target. |
| `MEDIAN` | The headline statistic for this metric (median unless `--stat` says otherwise). |
| `TARGET` | The budget from `config/targets.json`. |
| `VERDICT` | Where the median sits: `+Nms over` (red) or `in target` (green). Judged on the median only — the tail is the last column. |
| `% OF TARGET` | Median as a share of the budget. `100%` is exactly on it; red when over. |
| bar | The same share, drawn. The bar spans 0–200% of the target in 16 cells, so the marker sits in the same column on every row. `┃` is a target not reached, `×` is a target passed. The glyph carries the verdict without colour, for output pasted where ANSI is stripped. Values past 200% are clamped. |
| `RUNS IN TARGET` | How many individual runs held the budget. Green when the target passes (90%+ of runs); yellow when at least 70% of runs held it, or when the median is in target but too many runs missed; red otherwise. |

**FINDINGS.** Every normalized Lighthouse audit that survives the filters (all of them by default, including the metric audits such as `first-contentful-paint`, which carry no saving). `N shown` becomes `N of M shown` when filters or `--limit` hide some.

| Column | Meaning |
| --- | --- |
| `EST. SAVING` | Lighthouse's estimated saving in ms, or in bytes (`84KB`) when it gave only a byte figure. `—` means no estimate, which is [not the same as zero](#no-estimate-is-not-zero). |
| `INSIGHT` | The audit id. A yellow `(flaky)` suffix means it appeared in under 30% of runs. |
| `AFFECTS` | The metrics Lighthouse says the audit bears on. `—` when it names none. |
| `OURS` | The share of the cost on [first-party](#first-party-vs-third-party) hosts: green `100%`, yellow when mixed, dim `0%` when wholly third party, `—` when Lighthouse gave no URLs to attribute. |
| `SEEN` | Runs the audit appeared in, out of successful runs. |

Rows are sorted by `--sortBy` (default `savingsMs`, largest first). Ties and rows with no value for the sort field sort to the end in id order — so a finding priced only in bytes, like `unused-javascript` above, sits among the `—` rows under the default sort. Use `--sortBy savingsBytes` to rank those.

If any runs failed, a yellow `N run(s) failed:` block lists up to three of them. The last line is the `reportId` to pass to `--reportId` for free re-filtering.

`--diagnose` replaces FINDINGS with the ranked work queue, the LCP element, IMAGE CHECKS, and the cautions described under [`GET /report/:reportId/diagnosis`](#get-reportreportiddiagnosis); the metric table there shows only failing targets. `--items` and `--requests` print the rows of named insights and the median run's request table. Colour is on when stdout is a terminal; `NO_COLOR` turns it off and `FORCE_COLOR=1` forces it on.

### `--reanalyze`: rebuilding stored reports for free

A stored `report.json` is a frozen snapshot of whatever the aggregation rules produced on the day it was written, so improving those rules does nothing for the history. `--reanalyze` re-derives each report from its own stored runs, which costs no PSI quota:

```
RE-ANALYZED 27 stored report(s), 25 with a changed conclusion, 68 cost figure(s) recovered, 373 phantom zero(es) corrected
  2026-09-30T03-50-24Z-mobile       changed (not saved)
      render-blocking-insight: was 0, actually 601ms (from items)
      16 finding(s) claimed 0ms where Lighthouse gave no estimate
  2026-09-30T03-53-46Z-mobile       changed (not saved)
      failing: [fcp lcp] -> [fcp lcp speedIndex tbt]
```

It reports two different corrections separately. A **recovered** figure is a real cost that a previous zero-rollup bug had been hiding. A **phantom zero** is a stored `0` that claimed an estimate of zero where Lighthouse gave none — corrected to `null`, and not counted as a win.

A rebuild only ever *fills in* a missing savings figure. A figure Lighthouse already supplied is never overwritten, because it may have come from a rollup that does not survive normalization and cannot be reconstructed — replacing a precise number with a row-derived approximation would be a downgrade. `runs.json` is left untouched so a rebuild can always be redone.

Exit code is `0` on success, `1` on error — so `npm run --silent psi -- <url> --runs 3 || echo "failed"` works in a script.

---

## Aggregation

Every metric and the score are reported with all three statistics plus the raw values, so a caller can always see the shape of the distribution:

```json
{
  "headline": { "score": 58, "metrics": { "lcp": 3210 } },
  "score": {
    "mean": 57.6, "median": 58, "mode": 58,
    "min": 52, "max": 61, "stddev": 3.1, "p25": 55.25, "p75": 59.25, "p95": 60.45, "count": 10,
    "values": [55, 57, 58, 58, 59, 61, 52, 60, 58, 56]
  },
  "distributions": {
    "score": { "bimodal": true, "lanes": [ { "min": 52, "max": 58, "mean": 56.1, "count": 5 }, { "min": 59, "max": 61, "mean": 60, "count": 5 } ] },
    "lcp":   { "bimodal": false }
  },
  "stats": {
    "mean":   { "score": 57.6, "metrics": { "lcp": 3244 } },
    "median": { "score": 58,   "metrics": { "lcp": 3210 } },
    "mode":   { "score": 58,   "metrics": { "lcp": 3200 } }
  }
}
```

- **`median` is the default headline.** Lighthouse is skewed by occasional slow runs; the median is far more stable run to run and is what you should compare against when deciding whether a change helped.
- **`mean`** is pulled around by outliers. Useful only alongside `stddev` when you specifically care about the average user cost.
- **`mode`** is the most frequently observed bucket. Read it as "what this page typically scores", not as a precise figure.
- **`stddev` is the sample standard deviation (n−1)** and doubles as the noise band: an improvement smaller than roughly one `stddev` is not distinguishable from run-to-run variance.
- **`p25` / `p75` / `p95`** are the tail percentiles (`PERCENTILE.INC`). A budget describes real sessions rather than the middle of a distribution, so the p75 is often the number that predicts what a user actually sees. They are the right thing to compare when deciding whether a change helped.
- **`distributions.<metric>` reports bimodality.** If `bimodal` is `true`, the samples split into two genuinely different states and the median sits in one of them by run count, not because the page reliably performs there. See below.
- Runs execute with bounded concurrency (`PSI_CONCURRENCY`, default 10, so a 10-run report goes out in one round and takes about as long as its slowest run). The limit is per report: two reports running at once put twice as many calls in flight. Compare reports only against baselines taken at the same concurrency, since a burst of simultaneous loads can raise the origin's TTFB. Some runs may fail; the run continues and the result reports `runsRequested` vs `runsSucceeded`. **If fewer than 60% of runs succeed the whole call fails** with `INSUFFICIENT_RUNS` rather than reporting a misleading number.

#### Bimodality

A page whose score splits into two clusters has no single meaningful `stddev` — averaging the lanes produces a spread that describes neither. The tool splits the samples at the point that minimises within-lane spread (Otsu's method in 1D) and reports `bimodal: true` only when all three hold:

- both lanes hold at least **20%** of the samples,
- there are at least **6** samples in total,
- the lane means are far enough apart to be more than jitter (`separation` ≥ 4 — a uniform spread measures about 3.2, a real two-lane split about 8.0).

A single bad run among nine good ones is therefore reported as ordinary spread, not as a second mode. When `bimodal` is `true`, compare within a lane, and work out which lane your change moved before accepting it.

### The LCP element, not just the LCP number

An aggregated report carries `lcp`, read from the run closest to the median:

```json
"lcp": {
  "isText": true,
  "phases": { "ttfb": 578.17, "renderDelay": 1083.34 },
  "totalMs": 1662,
  "dominantPhase": "renderDelay",
  "bottleneck": "render"
}
```

Two facts decide which playbook applies, and neither is visible in the LCP number alone:

- **`isText`** — if the LCP element is a text node there is no image to prioritise, lazy-load or resize, so `lcp-discovery-insight`, `prioritize-lcp-image-insight` and `lcp-lazy-loaded-insight` do not apply. On a real deployment of this project the LCP element is a `<div>` of body copy, and `lcp-discovery-insight` is `notApplicable`. There is deliberately no load phase in that case, because there is no resource to load — the absence is the finding.
- **`bottleneck`** — `loadDelay`/`loadTime` means fetch earlier; `renderDelay` means something is blocking paint, usually CSS; `ttfb` means the server is the constraint and no component change will help.

### The "measured under" line

Every report header carries a line recording the conditions the run was taken under:

```
measured under moto g power (2022) · CPU index 928 (higher = slower) · en-US · performance only
```

PSI chooses the device, throttle and CPU server-side — the caller cannot request them — so the only way to know what a stored number means is to record what the response said about it. The line captures the device (parsed from the network user agent), the CPU benchmark index, locale and categories.

Two reports are only comparable when measured under the same conditions. A score that moves with the CPU index has not improved.

Throttling is deliberately absent: PSI does not echo it, and inferring "Slow 4G" from the form factor would be a guess printed as a measurement.

Reports stored before this was recorded show `Lighthouse 13.5.0, device not recorded` or `not recorded`. They are still usable, but their conditions cannot be verified.

### PSI caches per URL

**The single most important thing to know about multi-run measurement.** PSI caches results per URL: asking for the same URL twice in a row returns *one* Lighthouse run, not two. Measured directly against the live API — five back-to-back calls returned one identical `analysisUTCTimestamp`.

Left alone, `runs=10` silently becomes *one* measurement counted ten times. `stddev` comes out `0.0`, every value is identical, and the median is a single sample wearing ten hats. That defeats the entire reason this tool exists.

So every run requests a unique param on the target URL:

```
https://example.com/          <- the report records this
https://example.com/?psi_nonce=k3f9a2   <- what is actually requested
```

- `report.url` and the `data/<host>/` path stay clean; only the wire request carries the nonce.
- A single fixed nonce would not help — the cache is keyed on the whole URL, so the value has to differ per run.
- Pass `cacheBust: false` to `runPsiCall` to disable it, e.g. if a site rejects unknown query parameters.

**The tool also checks.** After a report it compares the upstream analysis timestamps and warns if the runs collapsed:

```
warning: All 10 runs returned the same analysis timestamp, so PSI served one cached
report instead of re-measuring. The median and stddev here are not independent
samples and must not be used to judge a change.
```

#### `stddev: 0.0` is not always a bug

Two different things produce zero variance, and they mean opposite things:

| Cause | What you see | Meaning |
| --- | --- | --- |
| **PSI cache** (fixed) | Identical *metric values*, and the cache warning fires | The measurement is fake. Do not trust it. |
| **A pinned page** | Identical scores, but metrics wobble slightly | Real. A page far inside the "good" band — or scoring 100 — legitimately scores the same every time. |

`https://example.com/` returns `stddev 0.0` for a legitimate reason: it is so far above the thresholds that every run rounds to 100. Its LCP still moves (754 / 771 / 783 ms across three runs). **Check the metrics and the warning, not just the score, before concluding anything.**

### First-party vs third party

Sorting by savings alone will send you after other people's code. On a real deployment of this project the top actionable findings by estimated saving were **both `static.cloudflareinsights.com`** — Cloudflare's own analytics beacon on Cloudflare's own hosting. No amount of editing the app source fixes either one, and they outrank every genuine finding.

So every insight now carries ownership:

```json
{
  "id": "cache-insight",
  "savingsMs": 150,
  "firstPartyItems": 0,
  "thirdPartyItems": 1,
  "firstPartyShare": 0,
  "itemHosts": ["static.cloudflareinsights.com"]
}
```

`firstPartyShare` is `0`–`1`, or `null` when the cost could not be attributed to a host at all. It is the share of *items*, not of bytes — an item is the unit Lighthouse's own audits report in.

Hosts come from `items[].url` and nested `items[].subItems.items[].url`. A host is **first party** if it equals the measured domain, is a subdomain of it, or is listed in `PSI_FIRST_PARTY_HOSTS`. `media.example.com` counts as yours when you measured `www.example.com`; `static.guvi.in` counts as yours when `PSI_FIRST_PARTY_HOSTS=guvi.in`. Without that list, a CDN on a sister domain is filed as third-party cost.

Use it as a filter:

```bash
# the work queue: only what editing this repo could plausibly fix
npm run psi -- <url> --group opportunity,diagnostic --maxScore 0.9 --party first

# stricter: require at least half the cost to be yours
npm run psi -- <url> --minFirstPartyRatio 0.5 --sortBy firstPartyShare

# what the tag managers are costing you, kept out of the queue above
npm run psi -- <url> --party third
```

- `party=first` drops an insight only when **all** of its cost is somebody else's (`thirdPartyItems > 0 && firstPartyItems === 0`). It **keeps** insights whose cost could not be attributed to a URL at all — main-thread breakdowns, LCP phase breakdowns. Those are usually your own JavaScript, and hiding them would hide the largest category of real work.
- A **mixed** finding is kept, because you own part of the fix. The previous behaviour dropped any insight with a single foreign-host row, which discarded real cost: on a real deployment of this project `unused-css-rules` held 43,098 bytes of the site's own dead CSS — 94% of the finding — plus one gstatic reCAPTCHA stylesheet, and the entire finding vanished from the queue because of that one row.
- `party=third` is the inverse, for auditing third-party cost deliberately.
- `minFirstPartyRatio` is the explicit middle ground, for when a small first-party share is not enough to justify the work.

`third-parties-insight` lists every entity other than the measured host. A row is third party unless **every** resource in it sits on a domain the site owns (`PSI_FIRST_PARTY_HOSTS`). `--diagnose` still reports wholly-third-party findings so they can be logged as "not actionable in repo", but demotes them to the bottom of the queue. Rows on owned hosts are routed as image or script work.

For each resource under `subItems`, we attach:

- `resourceType` — `Script`, `Image`, `Stylesheet`, `Font`, etc., read from Lighthouse's own network request log.
- `node` — selector and snippet, **when Lighthouse already flagged that resource in an element-level audit** (render-blocking scripts, mis-sized images). If Lighthouse never recorded a selector, this field is absent and you must grep for the URL yourself.

The grep gate applies:

```bash
grep -rn "static.guvi.in" qwik-guvi/src/
```

returns the component that builds those URLs so you can trace where they are referenced and decide whether to lazy-load or replace.

### "No estimate" is not "zero"

`savingsMs` and `savingsBytes` are always present, and are `null` when Lighthouse gave no estimate. They used to be `0` or absent, interchangeably, which conflated two different facts:

- `0` — this audit says the gain is nothing.
- `null` — this audit does not say. Common for checklist-style insights.

The distinction matters when choosing what to work on. `lcp-discovery-insight` reports a real failure (`fetchpriority=high` missing) with no time estimate; reported as `0` it sorted to the bottom of every work queue, indistinguishable from a genuinely worthless audit. It now sorts last *as unknown*, and can be surfaced deliberately:

```bash
npm run psi -- <url> --group diagnostic --maxScore 0.9 --sortBy score --order asc
```

Byte savings are rounded to whole bytes, and `itemsTotal` is always reported — previously it only appeared when more than 25 items were trimmed, so the row count was unanswerable for every smaller insight.

### The cache-busting param never appears in output

Runs are cache-busted with a unique `?psi_nonce=…` (see below), and Lighthouse echoes the URL it was given back in several places — including `lighthouseResult.finalUrl`, item URLs, third-party iframe fragments, and CrUX `initial_url`. All of it is stripped before anything is reported, so a saved report never claims the site was loaded with a parameter it never saw in production.

### Mode bucketing rules

Continuous values have to be bucketed before "most frequent" means anything. Widths:

| Value | Bucket width |
| --- | --- |
| `score` | 1 point |
| `lcp`, `fcp`, `tbt`, `speedIndex`, `tti`, `ttfb`, `inp` | 100 ms |
| `cls` | 0.01 |
| `savingsMs` | 100 ms |
| `savingsBytes` | 1024 B |

The most frequent bucket wins. **If two or more buckets tie for most frequent, the median is used instead** — a tie means the distribution is flat, and the median describes it better than an arbitrary winner. `mode` returns the bucket value, not a re-measured statistic.

### Insights

Insights are merged across runs by audit id:

- `appearedInRuns` / `runsSucceeded` — how consistently it showed up.
- `flaky: true` — it appeared in **fewer than 30%** of successful runs. Deprioritize these; they are usually an intermittent third party, not a stable problem.
- `savingsMs` / `savingsBytes` / `score` — aggregated with the chosen `stat`.
- `stats` — all three statistics for each of those, so you can see whether savings are consistent.
- `items` — taken from the run whose score was closest to the median, because that is the run the headline number describes. Truncated to the top 25, with `itemsTotal` giving the original length.

### How savings are read

Lighthouse reports estimated savings in several shapes depending on version and audit, so each is read in turn and the **first non-zero** one wins:

| Field | Used for |
| --- | --- |
| `details.overallSavingsMs` | Millisecond savings — Lighthouse's own rollup, the most authoritative figure available. |
| `audit.metricSavings` | **Lighthouse 10.4+** drops `overallSavingsMs` and reports per-metric savings instead. The largest value is used. |
| `details.items[].wastedMs` | Summed. |
| `displayValue` ("Est savings of 1.2 s") | Parsed last. Requires the word "saving" *and* an explicit unit, so a string like "Main thread work: 1.1 s" cannot be mistaken for a saving. |
| `details.overallSavingsBytes` | Byte savings — Lighthouse's own rollup. |
| `details.items[].wastedBytes` | Summed. |
| `displayValue` | Parsed last, for bytes. |

The source actually used is reported as `savingsSource`: `overall`, `metricSavings`, `items`, `displayValue`, or `none`.

Two details here are deliberate and worth not undoing:

- **"First non-zero", not "largest".** A rounded display string must never inflate an exact structured figure. `unused-css-rules` reports `overallSavingsBytes: 58008` and a display string of "Est savings of 58 KiB"; taking the largest would report 59392. Order of *precision* is the rule, not order of magnitude.
- **Zero means "no estimate", not "no gain".** Lighthouse 13 writes `overallSavingsMs: 0` for audits that carry a real cost, and treating that `0` as an answer short-circuited the fallback chain before the per-row sum was ever reached. On a real deployment of this project the three largest findings all reported `0ms` because of it:

| insight | reported | actually | from |
| --- | --- | --- | --- |
| `render-blocking-insight` | `0ms` | 601 ms | `items` |
| `unused-javascript` | `0ms` | 206 KiB | `displayValue` |
| `image-delivery-insight` | `0ms` | 33 KiB | `displayValue` |

The highest `savingsMs` reported anywhere before the fix was 150 ms.

---

## Insight groups

Every Lighthouse audit is sorted into exactly one group. Precedence, in order:

| Group | Rule |
| --- | --- |
| `notApplicable` | Lighthouse scored the audit out of scope. Not selectable via the `group` filter. |
| `passed` | A real score of **0.9 or better**. |
| `informative` | Display mode says there is nothing to act on (`informative`, `manual`). |
| `opportunity` | Lighthouse typed the details as an opportunity (`details.type === "opportunity"`). |
| `diagnostic` | Everything else worth reporting. |

Two deliberate choices:

- **A passing audit is `passed` even if its details are typed as an opportunity.** If it scored 0.9 there is nothing left to win, and reporting it as an opportunity would send you after a non-issue.
- **Modern `-insight` audits (Lighthouse 10.4+) are `diagnostic`.** These are emitted with `scoreDisplayMode: "informative"` and a null score but carry real `metricSavings` and item lists. Filing them as merely informative would hide the most valuable findings from the `group=opportunity,diagnostic` filter that optimization work depends on.

The audit list is derived from the response itself — the performance category's `auditRefs` plus any `-insight` audit — so a new Lighthouse release is picked up without a code change. Audits in the `hidden` group are skipped, since Lighthouse itself does not surface them. Metrics are still read from hidden audits.

---

## Targets

`config/targets.json` holds the pass/fail thresholds, per strategy:

```json
{
  "mobile":  { "score": 90, "lcp": 2500, "tbt": 200, "cls": 0.1, "fcp": 1800, "speedIndex": 3400 },
  "desktop": { "score": 90, "lcp": 1800, "tbt": 150, "cls": 0.1, "fcp": 1200, "speedIndex": 2400 }
}
```

Every aggregated report includes:

```json
"targets": {
  "strategy": "mobile",
  "targets": { "score": 90, "lcp": 2500, "...": 0 },
  "meetsTarget": false,
  "medianPass": true,
  "gaps": [
    {
      "metric": "tbt", "actual": 117.5, "target": 200, "delta": -82.5,
      "passRate": 0.8, "overBudgetRuns": 2, "runsMeasured": 10,
      "p75": 122, "p95": 423, "meets": false
    }
  ],
  "blockedBy": []
}
```

`score` is the one metric where higher is better; everything else is a budget where lower is better. `meetsTarget` is `false` if **any** target metric is missed **or could not be measured** — an incomplete run never reports success.

### A budget is graded on the tail, not the median

A budget describes real sessions, not the middle of a distribution. Each gap is therefore graded on **how often individual runs land inside it**, and a gap fails when fewer than 90% of runs do (`DEFAULT_MIN_PASS_RATE`).

This catches a real false-pass. In one report, per-run TBT was `110, 118, 270, 86, 118, 116, 423, 122, 107.5, 117` against a 200 ms budget. The median is 117.5, so a median-only check reports a comfortable pass — while 2 of 10 runs busted the budget at 270 ms and 423 ms, and those over-budget runs are exactly what users experience and what drags the score down. The gap reports `meets: false`, `passRate: 0.8`, and the report carries `medianPass: true` so both verdicts are visible.

The pass-rate fields are **omitted entirely** when there is no per-run series to grade, so a single-run report or a hand-built aggregate keeps the original median-only behaviour. Pass-rate fields are also optional on the `Gap` type for the same reason.

`medianPass` on the comparison answers "would this have passed on the median alone?", and `diagnosis.unreliable` names the metrics where the median and the tail disagree.

### Budgets the frontend cannot meet

`blockedBy` reports a budget that the server round trip alone already exceeds, so no component change can reach it. It applies **only** to elapsed-time metrics (`fcp`, `lcp`, `speedIndex`, `tti`) and **only** when the median is over budget:

- TBT, INP and CLS are not bounded by TTFB. TBT accumulates main-thread blocking time, INP measures interaction latency, and CLS is unitless — applying a millisecond floor to them concludes things about two unrelated quantities.
- A metric that clears its budget on the median and misses on a couple of runs is variance to stabilise, not a structural ceiling. Calling that unreachable would excuse skipping work that genuinely can be done.

`worstGap` names the failing metric with the largest overshoot **relative to its own budget**, so a 400 ms LCP miss on a 2500 ms budget outranks a 3-point score miss on a 90-point target.

---

## Storage

Reports land in `data/<host>/<reportId>/`:

```
data/
  www.guvi.co/
    2026-09-29T10-30-00Z-mobile/
      report.json     # the aggregated report (what /report returns)
      runs.json       # every normalized run, for re-analysis
```

`<reportId>` is `<ISO timestamp>-<strategy>`, which sorts chronologically. `data/` and `.env` are gitignored.

`report.json` is a snapshot of whatever the aggregation rules produced on the day it was written, so improving those rules does nothing for history. `runs.json` keeps the per-run detail — metrics, insights, items, display strings — which is what `--reanalyze` rebuilds from at no quota cost. A rebuild **only fills in** a missing savings figure: one that Lighthouse already supplied is never overwritten, because it may have come from a rollup that does not survive normalization and cannot be reconstructed. `runs.json` is never rewritten, so a rebuild can always be redone.

The public `guvi-guvi` SOP sets the real bar: **Lighthouse 90+ minimum, 95+ best case, mobile and desktop.** The desktop thresholds above are the tighter interpretation of that; adjust both to match what you actually enforce.

---

## Development

```bash
npm test          # unit tests, no network
npm run typecheck # tsc over src and tests
npm run dev       # watch mode
npm run build     # emit dist/
```

Tests use a saved PSI fixture in `tests/fixtures/` and a mocked `fetch`; **no test touches the network.** Retry and backoff behaviour is verified by injecting the fetch, sleep and random functions.

To regenerate the fixture: `node scripts/make-fixture.js`.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `429 Quota exceeded` on every run | No API key, or the key's daily quota is spent. | Set `PSI_API_KEY`. |
| `INSUFFICIENT_RUNS` | Fewer than 60% of runs returned data. | Check the `errors` array; usually quota or timeouts. |
| `FAILED_DOCUMENT_REQUEST` on **every** run | Lighthouse loads the page from Google's public cloud and could not reach it — the host is down, blocking Google, or not publicly reachable. | Open the URL in a browser, then check it resolves publicly. A URL that works locally can still fail here. This is not a tool bug and retrying will not help. |
| Score `0` with a tiny `fetchTime` | The URL is `localhost`/private, so Lighthouse measured an error page. | Measure a deployed public URL. The tool warns about this up front. |
| Report takes minutes | Each run is a real PSI call, and a report waits for its slowest run. | Check `PSI_CONCURRENCY` is not set low in `.env`. Use `?async=true`, or `runs=3` while iterating. |
| Every insight shows `-` savings | Unexpected for Lighthouse 10.4+; those versions report `metricSavings`. | Should not happen — `metricSavings` is read as a fallback. If it does, the response shape has changed and the tool needs a look. |
| `stddev 0.0`, every value identical | Either PSI served one cached report for all runs, or the page is pinned well inside the "good" band. | Read the warnings. If it says "same analysis timestamp", the runs were cached — re-measure. If there is no warning, the page is genuinely stable; check the metric values to see the real spread. |
| Site breaks when a query string is added | Cache busting appends `?psi_nonce=…` to the measured URL. | Rare, but real for strict routers. Use `cacheBust: false` in library code, or confirm the site is measured correctly. |

## Automation

See **[AGENT_GUIDE.md](./AGENT_GUIDE.md)** for how an autonomous agent should use this tool to drive a page to target in a measured, reversible loop.

That loop requires a staging deploy per change, and the deploy rules matter as much as the measuring:

- Open a **staging PR for the page** being optimized, wait a flat 10 minutes, then poll that PR once a minute until the build reaches a terminal conclusion.
- **Never push to a branch while its staging build is running.** The staging server is shared — a mid-build push cancels the in-flight build and can leave the site serving a half-applied deploy, breaking it for everyone. Freeze the branch until the run concludes; a *failed* build is terminal, so pushing a fix after one is fine.
- Confirm the new build hash is actually being served before measuring. A measurement against a stale edge is a false negative, and it will make you revert a change that worked.
