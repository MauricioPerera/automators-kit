# CSV Report Queue

Combines [`core/csv.js`](../../core/csv.js) with
[`core/queue.js`](../../core/queue.js): a sales CSV is aggregated into a
summary report inside a background job — `reports:submit` returns a job
id immediately instead of blocking the request while a (potentially
large) CSV is parsed and aggregated. The "kick off + poll" pattern
([`examples/job-queue`](../job-queue/)) applied to CSV analytics/ETL
specifically, distinct from
[`examples/csv-bulk-import`](../csv-bulk-import/)'s **synchronous**
CSV-to-CMS-entries import: that example persists every row as a real
entry and blocks the request until all of them are created; this one
only cares about a **summary** (total, per-category breakdown, top
category) — a common, separate real-world CSV use case (bulk analytics,
not bulk import) where a large file makes the synchronous approach
genuinely painful (a slow request, or a request timeout).

## Run it

```bash
bun examples/csv-report-queue/setup.js
```

```bash
curl -X POST http://localhost:3038/api/shell/exec -H "Content-Type: application/json" \
  -d '{"cmd":"reports:submit --csv \"product,category,amount\nWidget,tools,10\nGadget,tools,20\nDesk,furniture,150\n\""}'
curl -X POST http://localhost:3038/api/shell/exec -H "Content-Type: application/json" -d '{"cmd":"reports:status --id <jobId from above>"}'
```

## Verified live: submit returns instantly, the real aggregate arrives via polling

```json
// reports:submit -- immediate
{"jobId":"...","status":"pending"}
```
```json
// reports:status, polled shortly after -- the real report
{"status":"completed","result":{
  "rowsProcessed":3,"rowsSkipped":0,"total":180,
  "byCategory":{"tools":30,"furniture":150},
  "topCategory":{"category":"furniture","amount":150}
}}
```

Rows with an unparseable `amount` are skipped and counted in
`rowsSkipped`, not silently included in the total or crashing the job.
