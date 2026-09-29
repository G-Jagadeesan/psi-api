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
| `PSI_CONCURRENCY` | `2` | Concurrent PSI calls (capped at 10). Each call costs quota. |
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
https://www.guvi.co/  [mobile]
score 58.0/100  (median of 10/10 runs)
LCP 3210ms!  TBT 90ms  CLS 0.020  FCP 1234ms  SI 3810ms
spread: score stddev 4.2 · values 55, 57, 58, 58, 59, 61, 52, 60, 58, 56
BELOW TARGET  score +1  lcp +710

INSIGHTS (3 of 19)
  SAVING   ID                                      GROUP        METRIC    ITEMS
  1200ms   uses-responsive-images                  opportunity  lcp       1
  640ms    render-blocking-resources               opportunity  fcp,lcp   2
  380ms    unused-javascript                       opportunity  lcp       1

reportId 2026-09-29T10-30-00Z-mobile
```

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
| `sortBy` | `savingsMs` (default), `savingsBytes`, `score`. |
| `order` | `desc` (default) or `asc`. |
| `party` | `any` (default), `first`, `third`. See below. |
| `limit` | Max results. |
| `includeFlaky` | `true` (default). `false` hides insights seen in <30% of runs. |

```bash
# the LCP work queue
curl "http://127.0.0.1:3939/report/$ID/insights?group=opportunity,diagnostic&maxScore=0.9&metric=lcp&sortBy=savingsMs"

# everything that could save at least 100ms, cheapest first
curl "http://127.0.0.1:3939/report/$ID/insights?minSavingsMs=100&order=asc"
```

The response carries the headline numbers and target verdict alongside the filtered list, so one call is usually enough:

```json
{
  "reportId": "2026-09-29T10-30-00Z-mobile",
  "headline": { "score": 58, "metrics": { "lcp": 3210, "tbt": 90 } },
  "targets": { "meetsTarget": false, "gaps": [ { "metric": "lcp", "actual": 3210, "target": 2500, "delta": 710, "meets": false } ] },
  "totalInsights": 19,
  "matched": 3,
  "insights": [ /* ... */ ]
}
```

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
| `--sortBy <savingsMs\|savingsBytes\|score>` | `savingsMs` | |
| `--order <asc\|desc>` | `desc` | |
| `--party <any\|first\|third>` | `any` | Whose cost counts. See below. |
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
```

Filters compose with `--reportId`, so narrowing a work queue after a 10-run baseline never costs another quota unit.

**Use `--party first` when building a work queue.** Without it the top of a savings sort is frequently third-party code you cannot fix in the repo.

Exit code is `0` on success, `1` on error — so `npm run --silent psi -- <url> --runs 3 || echo "failed"` works in a script.

---

## Aggregation

Every metric and the score are reported with all three statistics plus the raw values, so a caller can always see the shape of the distribution:

```json
{
  "headline": { "score": 58, "metrics": { "lcp": 3210 } },
  "score": {
    "mean": 57.6, "median": 58, "mode": 58,
    "min": 52, "max": 61, "stddev": 3.1, "count": 10,
    "values": [55, 57, 58, 58, 59, 61, 52, 60, 58, 56]
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
- Runs execute with bounded concurrency (`PSI_CONCURRENCY`, default 2). Some runs may fail; the run continues and the result reports `runsRequested` vs `runsSucceeded`. **If fewer than 60% of runs succeed the whole call fails** with `INSUFFICIENT_RUNS` rather than reporting a misleading number.

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
  "itemHosts": ["static.cloudflareinsights.com"]
}
```

Hosts come from `items[].url` and nested `items[].subItems.items[].url`. A host is **first party** if it equals the measured domain or is a subdomain of it — `media.example.com` counts as yours when you measured `www.example.com`, because you own the fix even though the bytes cross a CDN.

Use it as a filter:

```bash
# the work queue: only what editing this repo could plausibly fix
npm run psi -- <url> --group opportunity,diagnostic --maxScore 0.9 --party first

# what the tag managers are costing you, kept out of the queue above
npm run psi -- <url> --party third
```

- `party=first` drops any insight charged to a foreign host. It **keeps** insights whose cost could not be attributed to a URL at all — main-thread breakdowns, LCP phase breakdowns. Those are usually your own JavaScript, and hiding them would hide the largest category of real work.
- `party=third` is the inverse, for auditing third-party cost deliberately.
- An item loading from both your CDN and a vendor counts as first party: you own part of the cost and part of the fix.

`third-parties-insight` is treated as third party by definition, since every row in it is someone else's code.

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

Lighthouse reports estimated savings in several shapes depending on version and audit, so each is read in turn and the first that yields a number wins:

| Field | Used for |
| --- | --- |
| `details.overallSavingsMs` | Millisecond savings, when present. |
| `audit.metricSavings` | **Lighthouse 10.4+** drops `overallSavingsMs` and reports per-metric savings instead. The largest value is used. |
| `details.items[].wastedMs` | Last resort — summed. |
| `details.overallSavingsBytes` | Byte savings, when present. |
| `details.items[].wastedBytes` | Summed otherwise. |

This matters in practice: without the `metricSavings` fallback, a Lighthouse 13 report comes back with every insight showing `-` for savings and the sort order becomes meaningless. The `displayValue` string ("Est savings of 1.2 s") is also parsed as a last fallback.

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
  "gaps": [
    { "metric": "lcp", "actual": 3210, "target": 2500, "delta": 710, "meets": false },
    { "metric": "score", "actual": 58, "target": 90, "delta": -32, "meets": false }
  ]
}
```

`score` is the one metric where higher is better; everything else is a budget where lower is better. `meetsTarget` is `false` if **any** target metric is missed **or could not be measured** — an incomplete run never reports success.

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

The public `guvi-guvi` SOP sets the real bar: **Lighthouse 90+ minimum, 95+ best case, mobile and desktop.** The desktop thresholds above are the tighter interpretation of that; adjust both to match what you actually enforce.

---

## Development

```bash
npm test          # 173 unit tests, no network
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
| Report takes minutes | Each run is a real PSI call; 10 runs at concurrency 2 takes a while. | Use `?async=true`, or `runs=3` while iterating. |
| Every insight shows `-` savings | Unexpected for Lighthouse 10.4+; those versions report `metricSavings`. | Should not happen — `metricSavings` is read as a fallback. If it does, the response shape has changed and the tool needs a look. |
| `stddev 0.0`, every value identical | Either PSI served one cached report for all runs, or the page is pinned well inside the "good" band. | Read the warnings. If it says "same analysis timestamp", the runs were cached — re-measure. If there is no warning, the page is genuinely stable; check the metric values to see the real spread. |
| Site breaks when a query string is added | Cache busting appends `?psi_nonce=…` to the measured URL. | Rare, but real for strict routers. Use `cacheBust: false` in library code, or confirm the site is measured correctly. |

## Automation

See **[AGENT_GUIDE.md](./AGENT_GUIDE.md)** for how an autonomous agent should use this tool to drive a page to target in a measured, reversible loop.
