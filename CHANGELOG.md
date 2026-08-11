# Changelog

## 2026-08-11

### Fixed
- Content adoption no longer gives up on a JPEG whose frame header sits past the first 4 KB. `IMAGE_PROBE_BYTES` was documented as clearing "even a long EXIF block"; it does not. The 9KDR251SIZE* eternity ring photographs carry an ICC profile that puts the dimensions beyond 16 KB, so `readImageSize` returned null, the fingerprint with it, and adoption fell through to uploading — every sibling product code adding its own copy of one photograph. `fetchImageFingerprint` now re-probes at `IMAGE_PROBE_BYTES_MAX` (64 KB) when, and only when, the first read finds a file it cannot measure. Caught by the cleanup below: a fresh duplicate appeared within 90 minutes of the store being verified clean, on code deployed an hour earlier. `9KDR251SIZEN` now adopts by content instead of uploading.
- Replacing a product's image in Unleashed no longer strands the old one in Shopify forever. With `DELETE_REMOVED_MEDIA` off the old media is deliberately left on the page, but `buildState` rewrote this product code's entries from the new image list alone, so the ownership record was dropped while the picture stayed. It then looked hand-added — and this sync never removes media it did not add — putting it permanently beyond both `DELETE_REMOVED_MEDIA` and `--duplicates --apply`. Reported by Christina on 18KDP240/9KDP240, whose old low-quality default had already become unowned this way.

### Added
- `IMAGE_PROBE_BYTES_MAX`, and an escalating second probe in `fetchImageFingerprint`. The common case still costs one 4 KB request; only an image whose dimensions are not in it pays for a second. An image unmeasurable even at 64 KB still falls back to uploading, so an odd file can never cost a product its pictures — but it now says so in the log rather than failing silently.
- `retained` on `buildState`. Media this code owns that Unleashed dropped but which is still on the page — deletion disabled, or the detach threw — keeps its entry, recorded as no longer default. Both call sites pass it: the early-return path retains everything, the main path retains only what the detach did not actually remove, so a thrown detach cannot lose the record either.

### Notes
- **Production had been running the 4 Aug build.** The package behind `WEBSITE_RUN_FROM_PACKAGE` was `20260804011604`, so none of the 5 Aug work — content-based adoption, sibling sharing, duplicate reporting, `weeklyDuplicateAudit` — was ever live, and the deployed function list was missing that function entirely. Filename-only matching is why 18KDP240 and 9KDP240 each uploaded their own copy of one photograph an hour apart on 10 Aug. Replaying the 07:40 decision against the repo adopts the sibling's copy instead: 0 uploads.
- That also explains most of "duplicates started reappearing within minutes" from 5 Aug. Against a clean re-scan on 5 Aug, 99 products had re-accumulated a duplicated picture and 154 removable copies in six days. 86 are `all_managed` — two sync-uploaded copies, i.e. this bug — and 13 `mixed`, which remain the unidentified second writer's.
- `--duplicates` is capped by `DUPLICATE_SCAN_BUDGET_MS` (7 min) and a first pass today stopped at 46 products. Its 46 were an exact subset of the 99 the next pass saw, so the cap — not new damage — accounts for the difference. The summary does say when it truncated; that line was lost to a `tail` on the way past. **A single figure from `--duplicates` is a floor until the summary is read in full and shows no truncation.**
- Deployed 2026-08-11 00:32 UTC, package `20260811000742-08bcd12e…`. `az functionapp deployment source config-zip` cannot be used on this app: SCM basic publishing credentials are disabled (`basicPublishingCredentialsPolicies/scm` → `allow: false`), so the Kudu ZipDeploy endpoint returns 401 and Azure records no deployment at all. The working path is the one `func` itself uses — upload the package to the `function-releases` container, then point `WEBSITE_RUN_FROM_PACKAGE` at it with a read SAS. `scripts/deploy.sh` shipped in the 4 Aug package but is not in the repo; it assumed Core Tools. Confirmed live by the host logging `6 functions loaded` where the old package had 5.
- The old low-resolution default image was detached from both reported products — `36674331082905` (YG, 1000x729, uploaded 3 Jul) and `35719963246745` (WG, 1000x729, uploaded 29 Jan). Both predate this service and no state entry claimed them, so neither `DELETE_REMOVED_MEDIA` nor `--duplicates --apply` would ever have removed them; this was a deliberate one-off. The high-resolution Unleashed image is now each product's default.

- Backlog cleared again, 2026-08-11. `--duplicates --apply` detached 154 copies across 99 products with no failures, and a full read-only re-scan of all 3,378 products afterwards reports zero duplicates and no truncation. The eight products that lost the most copies were checked individually and all still carry images. Both reported products are down to a single image — the high-resolution Unleashed one — where each had three.
- Across a 120-image sample of the Unleashed catalogue, 110 were measurable from the 4 KB probe, 9 needed the 64 KB re-probe and 1 could not be measured at either size. Every PNG (44) was fine; 10 of 76 JPEGs were not. So roughly 7% of images were silently unfingerprintable and duplicated once per sibling product code — a steady drip, not a one-off. The one image unreadable at 64 KB still falls back to uploading and will still duplicate; it is logged now rather than silent.
- Final state: a read-only scan of all 3,399 products after both fixes were deployed reports zero duplicates, with no truncation. Unlike 5 Aug, the fixes that stop these being recreated are now actually deployed, so this cleanup should hold. `weeklyDuplicateAudit` (Mondays 09:00 AEST) is live for the first time and will say so if it does not.

## 2026-08-05 (later)

### Added
- Duplicate surveillance in the daily verification report. `syncUnleashedProduct` already fetches a product's media and ownership state, so `findDuplicateGroups` runs on data it is already holding — no extra API call. The count, the products, and both filenames of each duplicated picture ride in the existing email, with `image-sync-duplicates.csv` attached. Seeing `9c5255af-….png` beside `9KDR704YSIZEM_1.png` makes a second writer self-evident without opening Shopify.
- `weeklyDuplicateAudit` — Monday 09:00 AEST whole-store census, deliberately its own function rather than part of `weeklyAudit`. `host.json` caps an invocation at 10 minutes, that audit already spends a couple, and a sweep killed by the host sends NO email — the exact silent failure this watch exists to prevent.
- `auditDuplicates` now stops on its own `DUPLICATE_SCAN_BUDGET_MS` (7 min) and survives a mid-sweep throttle, reporting a partial result flagged as a lower bound instead of losing every finding to one thrown page.
- `summariseDuplicateGroups` and `isForeignDuplicate`, shared by both reports so their arithmetic cannot drift apart. `src/utils/state.js` holds `parseState`/`buildState`, which is what lets the sync use the duplicate scanner without the two importing each other.

### Changed
- Only **foreign** duplicates — a copy no state entry owns — move the daily verdict, and it is WARN, never ALERT. A product whose Unleashed images include two byte-identical files uploads both, producing a duplicate on every run forever; warning daily on that self-inflicted steady state is how a report earns an inbox filter. Those are still counted and listed.
- The daily duplicate count is stated as a floor over the products checked, never as a store-wide total: a second writer can touch products Unleashed has not changed, which the daily pass never visits. Without that wording the weekly census reporting a larger number would read as a bug.
- Duplicate findings are carried separately from `details`, which drops `unchanged` results — and a duplicate almost always sits on a product whose images are otherwise correct, so riding on `details` would have discarded most of them.
- Duplicate findings are keyed by Shopify product id, so sibling Unleashed codes resolving to one product (18K101-3, -4, -5 …) report their shared duplicate once rather than once per code.
- `DUPLICATE_SCAN_MEDIA_SIZE` 50 → 20. Four times the page cap, and the sweep is throttle-bound, so this roughly halves its wall-clock.

### Notes
- Verified live: the daily incremental pass found exactly the same 3 products / 5 pictures / 6 wasted slots as the full-store sweep. One of them, 9KDR715YSIZEM, is already `capped` — its duplicates have consumed the 5-image page cap and are blocking a real image.

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
- **Duplicates started reappearing within minutes of the cleanup — a second writer is active, and it has NOT been identified.** Byte-identical copies of Unleashed photographs keep appearing under their human filenames (`9KDR704YSIZEM_1.png`) beside the GUID-named copies this service uploads, owned by no state entry. Ruled out: Unleashed's own connector (image toggle off, and it only ever did the single default image, never numbered `_1`/`_2` files); `Syncio Multi Store Sync` (`for-discovery` is a **Source-only** store in Syncio — it pushes out to Speirs Jewellers and Quarter Carat and is not a destination, so Syncio never writes into it; the `syncio-hidden` tag on 79% of products marks its own source catalogue); and the legacy C# syncs (no image handling in the code). The likeliest remaining explanation is photographs uploaded into Shopify by hand — the filenames are exactly the ones the team uses in Unleashed, and `9KDR650Y-1SIZEO12.png` was uploaded for a SKU that does not exist in Unleashed at all. Shopify logs no event and exposes no creator field for file uploads, not even for this service's own, so this cannot be settled from the API; it needs someone who knows the team's workflow.

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
