# Changelog

## 2026-08-05

### Fixed
- The sync no longer uploads a second copy of a picture already on the Shopify product under a different filename. Image identity was filename-only, and Unleashed's API returns just a GUID URL — never the human filename shown in its UI — so any photo someone had already uploaded to Shopify by hand looked like a new image. Reported on 9KDP663-1: three images in Unleashed, four in the shop. Replayed against live data, the run that created it now ends with three images instead of four.
- Variants sharing one photograph no longer show it once per Unleashed product code. Alloy and size are Shopify variant options, so several codes map to one product, and each held its own copy of the same file under its own GUID — on 9KBELY040* that was five codes each adding the identical 127,626-byte image, one picture filling the whole five-image page. Adoption now claims a sibling code's copy instead of adding another. Replayed against live data, the family goes from 4 uploads and 5 images to 0 uploads and 1 image.
- A product code that drops an image can no longer detach media a sibling code still points at. Sharing one media item between codes is new, and without the guard one variant losing interest would take the photograph off the page for every other variant using it.

### Added
- Content-based image identity in `imageFingerprint.js`. Shopify's media query already returns `originalSource.fileSize`, `image.width/height` and `thumbhash`, so the Shopify side costs no extra request; the Unleashed side is one 4 KB ranged GET whose `Content-Range` carries the file size and whose body carries the dimensions. No image is ever downloaded.
- Adoption by content: an untracked Unleashed image whose bytes and dimensions match media already on the page — whether uploaded by hand or placed by a sibling product code — is adopted rather than uploaded. Recorded as `adopted_by_content` and persisted to state, so it costs one probe once and nothing thereafter.
- `node scripts/sync-cli.js --duplicates [--csv path] [--apply]` — scans the store for the same picture appearing more than once on one product. Read-only unless `--apply`. It only ever detaches copies this sync owns, always leaves one copy in place, and never touches media added by hand. Detaching removes the reference; the file stays in Shopify's library.
- `MEDIA_ORIGIN.ADOPTED_BY_CONTENT`, `ADOPTED_ORIGINS`, `DUPLICATE_KIND` and the duplicate-scan paging constants.
- `iterateProductsWithMedia` on the Shopify client, and `buildDuplicateCsv` / `buildDuplicateSummary` on the reporter.
### Notes
- Backlog cleared, 2026-08-05. Across 3,375 products, 613 carried a duplicated picture — 60 a hand-uploaded copy alongside one this sync added, 571 sibling codes duplicating one photograph. All 1,197 wasted image slots were detached in one `--apply` run with no failures, and a re-scan reports zero duplicates remaining. 9KDP663-1 went from 4 images to 3, and the 9KBELY040* belcher from 5 identical images to 1. Dry runs confirm the affected codes re-adopt the surviving copy by content rather than re-uploading.
- The `UnlShopSync` custom app was granted `read_files` and `write_files`, which `fileUpdate` needs. Adding scopes to an installed legacy custom app did NOT rotate the Admin API token, so no credential update was required. Note the store also has a similarly named `Unleashed Sync` app that this service does not use.
- **Duplicates started reappearing within minutes of the cleanup — the second writer is Syncio, not Unleashed.** `Syncio Multi Store Sync` mirrors products into this store from another Shopify store, bringing their images under the source store's SKU-based filenames (`9KDR704YSIZEM_1.png`) while this service uploads the same pictures from Unleashed under GUID filenames. 2,656 of 3,375 products (79%) carry a `syncio-hidden` tag, and all three products that duplicated again within 25 minutes of the cleanup are Syncio-managed, each updated within seconds of the duplicate file appearing. Unleashed's own connector is NOT responsible: its `Default Image → Product Image` toggle is off, and it only ever covered a single default image, never the numbered `_1`/`_2` files seen here. Note Shopify logs no event and exposes no creator field for file uploads, so this was established from Syncio's product tags and update timestamps rather than direct attribution.

### Changed
- `--duplicates --apply` now stops on the first `ACCESS_DENIED` instead of retrying every remaining product. A missing scope is a property of the token, not of the product, so the first run printed the same error 613 times and buried the one line that mattered. It now reports which scope is missing and that nothing was changed.
- `syncUnleashedProduct` takes an injectable `fetchImpl`, so the one call that does not go through the Shopify client is testable like the rest.
- The fingerprint pass runs only when it can change the answer — an upload is pending AND the page holds measurable media this sync does not own. A fingerprint that cannot be taken falls back to uploading, so an unreachable CDN never costs a product its images.

## 2026-08-04

### Added
- The daily report now names the products behind every count — pending, unmatched, ambiguous, capped and failed — worst outcome first, with the number of images at stake, the Unleashed description and the reason. Previously only the totals were shown, so answering "which SKUs?" meant opening Application Insights.
- The full list attaches as `image-sync-detail.csv`, so a long day can be sorted and worked through in a spreadsheet rather than read off a truncated table.
- Sync results carry `imageCount` and `description`, so a report row can identify a product without a second Unleashed lookup.
- `DAILY_REPORTED_OUTCOMES`, `OUTCOME_LABEL`, `DAILY_INLINE_LIMIT` and `REPORT_NOTE_MAX_CHARS` constants.

### Changed
- Named products appear on healthy reports too, not just WARN and ALERT. An OK verdict routinely carries pending, unmatched and capped rows, and those are exactly the ones people ask about.
- Report rows are labelled in English (`pending`, `unmatched SKU`, `declined by the image cap`) instead of raw outcome values like `dry_run`, and carry every note rather than only the first — a capped product's cap note came second and was being dropped.

## 2026-08-03

### Fixed
- Unleashed rejects percent-encoded colons in the signed query string with a bare HTTP 403, so every request carrying `modifiedSince` was failing while parameter-free requests succeeded. The reconcile timer had been dead — the webhook path masked it, since it looks products up by Guid. Colons are now sent raw. Found within minutes of the new daily report going live, by the report itself.

### Added
- `weeklyAudit` timer (Sun 22:30 UTC / Mon 08:30 AEST): whole-catalogue audit of Unleashed products that hold images but have no matching Shopify SKU — photographed stock no shopper can ever see. The daily report cannot find these because it only looks at the last 24 hours. First run: 195 products, 18 of them likely SKU typos with a suggested match, 2 SKUs on more than one Shopify product.
- The full unmatched list attaches as `unmatched-skus.csv`, and `scripts/sync-cli.js --audit [--csv <path>]` runs the same audit on demand.
- Zero-activity alert: a day with no Unleashed changes is re-checked against `ZERO_ACTIVITY_PROBE_DAYS` (7). Silent for a day is a quiet day; silent for a week means the sync has stopped seeing Unleashed.
- `shopify.listAllVariantSkus()` and `unleashed.countProductsModifiedSince()`.

### Changed
- Reports are delivered by email through Resend — the sender `searay-email-func` already uses — instead of Slack. Recipients come from `EMAIL_TO` and change without a redeploy. Report bodies are now plain text plus table-based HTML that survives Outlook, with all Unleashed free text escaped.

### Removed
- `SLACK_WEBHOOK_URL` and the Slack delivery path.

## 2026-07-31 (evening)

### Added
- `dailyReport` timer function (22:00 UTC / 08:00 AEST): re-verifies the last 24 hours in dry-run mode and reports health. Anything still pending means the live sync failed or fell behind — otherwise invisible, since a broken sync looks like a quiet day. `dryRun` is forced on so the reporting job can never become a second writer.
- Health verdict rules: any failure alerts, pending beyond `PENDING_WARN_THRESHOLD` warns, unmatched and capped counts are reported but never alert.
- Optional Slack delivery via `SLACK_WEBHOOK_URL`; without it the summary still reaches Application Insights, and a delivery failure never breaks the sync.
- GitHub Actions CI: module parse check, the offline test suite, a Functions-host load check for every trigger, and a guard that fails if a Shopify token or `local.settings.json` is ever committed.

## 2026-07-31 (later)

### Added
- `MAX_MEDIA_PER_PRODUCT` (default 5) — ceiling on total images on one Shopify product, counting media the sync did not add. Agreed with Christina: "5 per unleashed product, cap each web page at 5 as well".
- Images beyond the cap are skipped and reported per product in the run result and logs, never dropped silently. Because images are ordered default-first, the default image is the one that survives the cut.
- `mediaOnPage` in the sync result, so reports show how full a product already was.

## 2026-07-31

### Added
- Deployed to Azure Function App `searay-unleashed-sync` (resource group `searay-func-rg`, australiaeast, Linux consumption, Node 22) with storage account `searayunleashedsync`.
- Registered the Unleashed webhook subscription `51295e09-4053-4d02-a618-a25f2ff01bec` for `product.created` / `product.updated`.
- `scripts/deploy.sh` — idempotent create-and-publish, resolving the Core Tools binary rather than assuming it is on PATH.
- `scripts/push-settings.py` — pushes app settings via a temp file so values never reach the process list or terminal.
- `scripts/import-token.py` — copies an existing Shopify token from the legacy C# sync projects without displaying it.
- `RECONCILE_MAX_PAGES` is now configurable; the default of 25 would have silently truncated a whole-catalogue pass at ~33 pages.

### Changed
- `DRY_RUN=true` in the deployed app pending a decision on the per-page image ceiling. The reconcile timer runs and reports but changes nothing.
- `scripts/register-webhook.js` writes the returned `signatureKey` straight into `local.settings.json` instead of printing it, and refuses to create a duplicate subscription for a URL that already has one.

## 2026-07-30

### Fixed
- Scoped media ownership per Unleashed product code, since several Unleashed products share one Shopify product when alloy/size are variant options. Previously siblings overwrote each other's state, and with deletion enabled would have detached each other's images on alternate runs.
- Suppressed reordering when a sibling Unleashed product owns media on the same Shopify product.
- Stopped re-issuing a reorder mutation on every pass when the media order was already correct.

### Added
- Unleashed → Shopify product media sync service (Azure Functions v4, Node).
- `unleashedWebhook` HTTP trigger with HMAC-SHA256 verification of `{timestamp}.{body}` and a 5-minute freshness window.
- `reconcileMedia` timer trigger running every 10 minutes over an overlapping `modifiedSince` window.
- `backfillMedia` HTTP trigger (function key) supporting `?sku=`, `?since=`, `?all=true`, `&limit=`, `&dryRun=true`.
- Adoption of existing Shopify media by filename so the image Unleashed's built-in connector already pushed is claimed instead of duplicated.
- Ownership tracking in the `custom.unleashed_media` product metafield; only tracked media is ever removable.
- `scripts/sync-cli.js` for local runs and `scripts/register-webhook.js` for subscription setup.
- `scripts/self-test.js` covering image identity, plan decisions, request signing and webhook verification.
