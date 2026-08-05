# unleashed-media-sync

Syncs up to **5 product images** from Unleashed into Shopify **product media**, without
clobbering images added by hand in Shopify.

Unleashed's built-in Shopify connector syncs only the *default* image and replaces product
media when it runs, which wipes images uploaded directly into Shopify. This service replaces
that behaviour for images.

## Emergency stop

If anything looks wrong, put the sync into dry-run mode. It keeps running and keeps reporting,
but stops writing to Shopify. Takes effect within a few seconds — the app restarts on a settings
change — and needs no redeploy.

```bash
az functionapp config appsettings set -g searay-func-rg -n searay-unleashed-sync \
  --settings DRY_RUN=true -o none
```

Resume with the same command and `DRY_RUN=false`.

This does **not** undo anything already synced. To remove an image the sync added, delete it
from the product in Shopify admin; the sync will not put it back unless that product's entry is
also cleared from its `custom.unleashed_media` metafield.

## Why this is a separate service

Nothing here belongs in the theme repo (`Shopify/searay-theme-live`) — it never renders. It is
also deliberately **not** inside the existing `searay-email-func` Function App: that app serves
the live backorder email path, an Azure Function App has a single runtime stack, and a polling
job that hammers two external APIs shouldn't share a process with checkout-adjacent email.

It is **not** a Shopify App Store app either. It is server-to-server against one store, so a
Shopify **custom app** token is all it needs — no OAuth, no App Bridge, no embedded admin UI.

## How it decides what to do

For each Unleashed product:

1. `Images[]` is ordered **default first**, then Unleashed's own order, capped at `MAX_SYNCED_IMAGES`.
2. The Unleashed `ProductCode` is matched to a Shopify product via **variant SKU** (exact match,
   re-checked client-side because Shopify's search is fuzzy).
3. Existing state is read from the product metafield `custom.unleashed_media` — the record of
   **which media this service owns**.
4. Each Unleashed image resolves to one of:
   - **tracked** — already synced, nothing to do;
   - **adopted** — untracked, but existing Shopify media has the same filename, so it is claimed
     rather than duplicated (this is what stops the first run doubling up the image Unleashed's
     own connector already pushed — Shopify keeps the original basename and appends `_<uuid>`);
   - **adopted by content** — untracked, and the filename does not match, but the bytes do. This
     is the only way to recognise a photo somebody uploaded to Shopify by hand, or a sibling
     variant's copy of the same photograph: Unleashed's API returns just `{ Url, IsDefault }` with
     a GUID URL, and never the human filename its own UI shows, so the names can never agree. See
     [Content identity](#content-identity);
   - **upload** — appended via `productUpdate`, one image per call so each new media id can be
     mapped back to its Unleashed URL.
5. State is written back to the metafield.

### Content identity

Shopify re-hosts every image, so URLs can never be compared and the filename is normally all that
survives. That is enough for anything Unleashed's own connector pushed, and useless for the two
cases that produced every duplicate in this store:

- a photo a person uploaded into Shopify directly — it keeps its human name, and the Unleashed
  GUID never matches it (reported on **9KDP663-1**: three images in Unleashed, four in the shop);
- **variants sharing one photograph**. Alloy and size are Shopify variant options, so several
  Unleashed codes map to one Shopify product, and each holds its own copy of the same file under
  its own GUID. On **9KBELY040\*** that meant five codes each adding the identical 127,626-byte
  image — one picture filling the entire five-image page.

So when an upload is pending **and** the page holds media this product code does not already own,
both sides are fingerprinted and compared by **exact byte count plus exact pixel dimensions**:

| side | source | cost |
| --- | --- | --- |
| Shopify | `originalSource.fileSize`, `image.width/height` — already in the media query | nothing |
| Unleashed | one ranged GET of the first 4 KB; `Content-Range` gives the size, the body gives the dimensions | ~4 KB |

No image is ever downloaded, and the result is written to state as `adopted_by_content`, so it
costs one probe once and nothing on later runs. Byte count alone would be too weak and dimensions
alone far too weak — this catalogue is full of 1080x1080 product shots, and a dimensions-only
sweep flagged whole photoshoots as duplicates of each other. If a fingerprint cannot be taken the
image is uploaded exactly as before, so an unreachable CDN never costs a product its images.

Because a sibling's copy can now be claimed, **one media item can be referenced by several product
codes' state entries**. Removal accounts for that: a code that drops an image never detaches media
another code still points at, or the photograph would vanish for every variant still using it.

### Finding duplicates that already exist

```bash
node scripts/sync-cli.js --duplicates --csv reports/duplicates.csv   # read-only
node scripts/sync-cli.js --duplicates --apply                        # detaches
```

Detection is exact and free: Shopify returns `thumbhash`, its own perceptual digest, alongside the
file size, so two media holding the same picture are identifiable without downloading anything.
Each duplicate group is classified by what can safely be done:

- **mixed** — one hand-uploaded copy plus one this sync added. `--apply` detaches the copy the sync
  added and keeps the other, which the next run re-adopts by content.
- **all managed** — sibling Unleashed codes each holding their own copy of one photograph.
  `--apply` keeps the first copy and detaches the rest; those codes re-adopt the survivor.
- **all unmanaged** — uploaded by hand more than once. Reported only; this sync did not create
  them and does not remove media it never added.

Nothing is deleted — `fileUpdate` removes the reference, and the file stays in Shopify's library.

### Guarantees

- **Media this service did not add is never removed, detached or replaced.** Only entries in
  `custom.unleashed_media` are ever candidates for removal.
- Removal additionally requires `DELETE_REMOVED_MEDIA=true` (**off by default**). When off, an
  image dropped in Unleashed stays in Shopify and is reported.
- Removal **detaches** the file from the product (`fileUpdate` + `referencesToRemove`); it does
  not delete the file from Files.
- Reordering is **skipped** when the product has any media this service didn't add, so a hero
  image someone deliberately positioned is never pushed down.
- Re-running is safe. Every decision is a diff against live Shopify state, so duplicate webhook
  deliveries and overlapping reconcile windows are no-ops.

### Many Unleashed products → one Shopify product

On this store, alloy and size are Shopify **variant options**, so several Unleashed
products routinely resolve to a single Shopify product. Confirmed live: `18K101-3`, `-4`,
`-5`, `-6`, `-7` and `-10` all resolve to `gid://shopify/Product/8225786200217`.

Those siblings therefore **share one `custom.unleashed_media` metafield**, so every entry
records the `productCode` that created it:

```json
{ "version": 1, "syncedAt": "…", "managed": [
  { "url": "https://unlappcdn…/d40d…png", "mediaId": "gid://shopify/MediaImage/368…",
    "origin": "synced", "isDefault": true, "productCode": "18KBA15858X48" }
]}
```

Consequences, all enforced in `planMediaChanges`:

- An image is **resolved** against entries from any product code — if a sibling already put
  that file on the product, it is reused rather than uploaded twice.
- Only entries owned by the **current** product code are detach candidates. Without this,
  syncing `-4` would detach `-3`'s image and the siblings would destroy each other's images
  on alternate runs.
- Writing state **preserves** sibling entries instead of overwriting them.
- Reordering is skipped when a sibling owns media here, otherwise each sibling would shove
  its own images to the front on every run.

**Open question for the business:** `MAX_SYNCED_IMAGES` is 5 *per Unleashed product code*.
A Shopify product grouping 6 Unleashed products can therefore accumulate up to 30 media.
If the intent is 5 per *Shopify product*, that needs a different rule — see Known limits.

## Setup

### 1. Unleashed API credentials

Unleashed → **Integration → Unleashed API Access** → API ID and API Key.
→ `UNLEASHED_API_ID`, `UNLEASHED_API_KEY`

### 2. Shopify custom app

Shopify admin → **Settings → Apps and sales channels → Develop apps → Create an app**.
Admin API scopes required:

| Scope | Used for |
|---|---|
| `read_products`, `write_products` | find product by SKU, append media, reorder, write the state metafield |
| `read_files`, `write_files` | detach media from a product (`fileUpdate`) |

Install the app, reveal the **Admin API access token** (`shpat_…`) → `SHOPIFY_ADMIN_TOKEN`.

> `write_files` is easy to miss, because everything the sync does day to day runs on
> `write_products` alone — only removal needs it. Without it `--duplicates --apply` and
> `DELETE_REMOVED_MEDIA=true` fail with `ACCESS_DENIED` on `fileUpdate` and change nothing.
> Check what the live token actually has before assuming:
>
> ```bash
> curl -s -X POST "https://$SHOPIFY_STORE_DOMAIN/admin/api/2026-07/graphql.json" \
>   -H "X-Shopify-Access-Token: $SHOPIFY_ADMIN_TOKEN" -H 'Content-Type: application/json' \
>   -d '{"query":"{ currentAppInstallation { accessScopes { handle } } }"}'
> ```
>
> Adding a scope to an installed custom app means **reinstalling it and reissuing the token**,
> so remember to update `SHOPIFY_ADMIN_TOKEN` in both `local.settings.json` and the Azure app
> settings.

### 3. Turn off image sync in Unleashed's own connector

**Required, or the two will fight.** Unleashed → **eCommerce Hub → Shopify → Configure →
Product Synchronization → Advanced Settings** → turn the product **image** toggle off. Leave the
rest of product sync alone.

### 4. Local run

```bash
cp local.settings.json.example local.settings.json   # then fill in the secrets
npm install

node scripts/self-test.js                            # offline logic checks, no credentials needed

node scripts/sync-cli.js --sku 9KCH37145CM --dry-run # prove one product, write nothing
node scripts/sync-cli.js --sku 9KCH37145CM           # then for real
node scripts/sync-cli.js --since 2026-07-01 --limit 25
node scripts/sync-cli.js --all                       # whole catalogue backfill
```

`local.settings.json` is gitignored. Never commit a token.

### 5. Deploy to Azure

```bash
brew install azure-cli azure-functions-core-tools@4
az login

RG=searay-func-rg
APP=searay-unleashed-sync
STORAGE=searayunleashedsync          # 3-24 chars, lowercase alphanumeric only

az storage account create -n $STORAGE -g $RG --sku Standard_LRS
az functionapp create -g $RG -n $APP \
  --storage-account $STORAGE \
  --consumption-plan-location australiaeast \
  --runtime node --runtime-version 22 --functions-version 4 --os-type Linux

az functionapp config appsettings set -g $RG -n $APP --settings \
  UNLEASHED_API_ID="…" UNLEASHED_API_KEY="…" \
  SHOPIFY_STORE_DOMAIN="for-discovery.myshopify.com" SHOPIFY_ADMIN_TOKEN="shpat_…" \
  MAX_SYNCED_IMAGES=5 DELETE_REMOVED_MEDIA=false REORDER_MEDIA=true DRY_RUN=false

func azure functionapp publish $APP
```

Secrets belong in app settings (or Key Vault references) — never in the repo, and never in
anything the theme renders.

### 6. Register the webhook (after deploying)

```bash
node scripts/register-webhook.js \
  https://searay-unleashed-sync.azurewebsites.net/api/unleashed/product-webhook
```

Copy the returned `signatureKey` — **shown once** — into the app setting
`UNLEASHED_WEBHOOK_SIGNATURE_KEY`. Until it is set, the endpoint rejects every delivery.

## Endpoints and schedule

| Function | Trigger | Purpose |
|---|---|---|
| `unleashedWebhook` | `POST /api/unleashed/product-webhook` (anonymous, HMAC-verified) | near-real-time sync on `product.created` / `product.updated` |
| `reconcileMedia` | timer, every 10 min | re-reads the last `RECONCILE_LOOKBACK_MINUTES` — covers dropped deliveries and downtime |
| `backfillMedia` | `GET|POST /api/unleashed/backfill` (function key) | operator runs: `?sku=`, `?since=YYYY-MM-DD`, `?all=true`, `&limit=`, `&dryRun=true` |
| `dailyReport` | timer, 22:00 UTC (08:00 AEST) | verifies the last day's changes and emails a health summary |
| `weeklyAudit` | timer, Sun 22:30 UTC (Mon 08:30 AEST) | whole-catalogue audit: products whose images can never reach the site |

### Why the daily report exists

A broken sync looks exactly like a quiet day: no errors, no output, nothing on
the storefront. Every bug found during the first backfill produced a
clean-looking result while doing the wrong thing.

So the daily job re-checks the last 24 hours **in dry-run mode**. The webhook and
the 10-minute timer should already have handled all of it, so anything still
pending is evidence the live sync is failing or falling behind. `dryRun` is
forced on in that function regardless of the app setting — a reporting job must
never become a second writer.

| Signal | Verdict |
|---|---|
| any product errored | **alert** |
| pending > `PENDING_WARN_THRESHOLD` | **warn** — live sync is behind or broken |
| no Unleashed changes in 24h **and** none in `ZERO_ACTIVITY_PROBE_DAYS` days | **alert** — the sync has stopped seeing Unleashed |
| no changes in 24h but some within the probe window | OK — a quiet day, stated as such |
| unmatched SKUs, capped images | reported, never alerts — these are steady-state facts, and a daily alert on them trains everyone to ignore the report |

Every count in that email is backed by a named list. Under the summary table the
report names each product behind the pending, unmatched, ambiguous, capped and
failed counts — worst outcome first, with the number of images at stake, the
Unleashed description, and why the sync reached that conclusion. The first 40
rows appear in the email body (`DAILY_INLINE_LIMIT`); the complete list rides
along as `image-sync-detail.csv`.

This happens on a **healthy** report too. An OK verdict routinely carries a few
pending, unmatched and capped products, and printing only the counts meant the
answer to "which SKUs?" was in Application Insights, which is not where anyone
was going to look.

The two-window check on activity is the point. A silent 24 hours is ordinary —
weekends, holidays, a week nobody edits products — so alerting on it alone would
fire most weekends and be filtered to trash before a real outage arrived. A
catalogue this size going a **full week** without one modification is not
ordinary, and that is what actually distinguishes quiet from broken.

### Why the weekly audit exists

195 Unleashed products hold photographs that no shopper can ever see, because no
Shopify variant carries their product code as a SKU. The daily report cannot
find them: it only looks at the last 24 hours, so a product mismatched months ago
never comes back round. Left alone the list quietly rots.

The audit is a **set difference**, not a sync pass: it reads every Shopify
variant SKU once (~25 requests) and diffs the whole Unleashed catalogue in
memory. Asking Shopify per product would be thousands of requests and could not
finish inside a function timeout.

It separates the two cases, because they need different people:

- **likely SKU typos** (18 of them) — a near-identical Shopify SKU exists, e.g.
  `18KDSC10` against `18KDSC10W`, `9KC240-1` against `9KC240`. A one-character
  data fix; the email names the suggestion.
- **genuinely absent from Shopify** — the product needs creating, or it is not
  meant to be online at all.

The full list rides along as `unmatched-skus.csv` so it can be worked through in
a spreadsheet rather than retyped out of an email. Only products that actually
hold images are counted — a product with no photos has nothing stranded.

This one **warns rather than alerts**, every week, until the count reaches zero.
That is deliberate: it is a worklist, and carrying the count in the subject line
makes progress visible without opening anything.

Run it on demand with `node scripts/sync-cli.js --audit --csv reports/x.csv`.

### Email delivery

Reports go out through **Resend**, the same sender `searay-email-func` already
uses for backorder notifications, so there is one verified sending domain rather
than two. Set `RESEND_API_KEY` (a send-only key), `EMAIL_FROM` and `EMAIL_TO`.

Without a key the summary still reaches Application Insights — email is how the
report finds people, not the only place it exists, and a mail outage never
breaks the sync.

**Known limit:** this catches a sync that runs and misbehaves, and now also one
that has stopped seeing Unleashed. It still cannot catch a Function App that
stops running altogether — no run, no email, and nothing can alert on silence
from inside the thing that went silent. An availability alert in Application
Insights would close that last gap.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request:

1. every module parses (`node --check`)
2. the 49 offline tests — no credentials, so CI never touches the live store
3. each Function module imports and registers cleanly, which unit tests don't cover
4. a credential guard: fails if a `shpat_`-style token or `local.settings.json`
   is ever committed. The repo is public, so a leaked key would be live the
   instant it is pushed.

The webhook route is anonymous on purpose: authenticity comes from the HMAC signature over
`{timestamp}.{body}`, which — unlike a key in the URL — cannot leak via logs or referrers.
Deliveries older than 5 minutes are rejected.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `MAX_SYNCED_IMAGES` | `5` | ceiling on images pushed per Unleashed product |
| `MAX_MEDIA_PER_PRODUCT` | `5` | ceiling on TOTAL images on one Shopify product, counting media the sync did not add. Uploads beyond it are skipped and reported; nothing is ever removed to make room |
| `DELETE_REMOVED_MEDIA` | `false` | detach media this service added once Unleashed no longer lists it |
| `REORDER_MEDIA` | `true` | order synced media default-first (skipped if manual media is present) |
| `DRY_RUN` | `false` | log the plan, change nothing |
| `RECONCILE_LOOKBACK_MINUTES` | `60` | timer window |
| `RECONCILE_MAX_PAGES` | `25` | page cap per run, a runaway guard. The catalogue is ~33 pages at the default `pageSize=200`, so raise it for a whole-catalogue pass; when the cap truncates a run it is logged, never silent |
| `RESEND_API_KEY` | — | send-only Resend key, shared with `searay-email-func`. Unset means reports log only |
| `EMAIL_FROM` | `Searay Image Sync <no-reply@searay.net.au>` | must be on a domain verified in Resend |
| `EMAIL_TO` | `info@`, `christina.l@`, `thongz0819@live.com` | comma-separated; changing recipients needs no redeploy |
| `DAILY_LOOKBACK_HOURS` | `24` | daily verification window |
| `PENDING_WARN_THRESHOLD` | `5` | pending products tolerated before the daily report warns |
| `ZERO_ACTIVITY_PROBE_DAYS` | `7` | how far back a silent day is checked before it counts as a fault |

## Suggested rollout

1. `node scripts/self-test.js`, then `--sku <one product> --dry-run`, then for real. Check the
   product in Shopify admin.
2. `--since <today> --limit 25` to watch a small batch behave.
3. `--all` for the catalogue backfill, `DELETE_REMOVED_MEDIA=false` throughout.
4. Deploy, register the webhook, confirm the timer in Application Insights.
5. Only then consider `DELETE_REMOVED_MEDIA=true`, once the `custom.unleashed_media` metafields
   are populated and trusted.

## Known limits

- **The 5-image cap is per Unleashed product code, not per Shopify product.** Where several
  Unleashed products share one Shopify product, the media count multiplies. Enforcing a true
  per-Shopify-product ceiling would need a rule for which codes win the slots.
- **Pre-existing images that no longer match are not cleaned up.** If an image was replaced in
  Unleashed after the old connector pushed it, the old file has a different filename, so it is
  neither adopted nor removed — it stays as unmanaged media. It must be deleted by hand in
  Shopify if unwanted.
- **Content adoption cannot stop a SECOND writer from duplicating.** It stops this service adding a
  copy of a picture already on the page. It cannot stop another integration adding its copy
  *afterwards* — whoever writes second creates the duplicate.

  As of 2026-08-05 that second writer is **`Syncio Multi Store Sync`**, which mirrors products into
  this store from another Shopify store and brings their images under the source store's SKU-based
  filenames (`9KDR704YSIZEM_1.png`), while this service uploads the same pictures from Unleashed
  under GUID filenames. 79% of the catalogue (2,656 of 3,375 products) is Syncio-managed, tagged
  `syncio-hidden`. Until image sync is disabled on the Syncio connection, duplicates reappear on
  whichever products Syncio touches after this service has run, and `--duplicates --apply` is a
  treadmill rather than a fix.

  Unleashed's own connector is not the cause — its `Default Image → Product Image` toggle is off,
  and it only ever covered one default image, never the numbered `_1`/`_2` files.

  > Shopify logs no event and exposes no creator field for file uploads, so a second writer can only
  > be identified indirectly — by app tags on the product (`syncio-hidden`) and by `updatedAt`
  > landing within seconds of the file's `createdAt`. Timing alone proves nothing: this service's
  > own backfills are bursty and look equally "human".
- **Duplicates already in Shopify are not repaired by the sync itself.** Content adoption stops new
  ones; the copies added before it existed are cleared with `--duplicates --apply`.
- **Two Unleashed images of one product that are byte-identical still both upload.** Deduplication
  happens against what is on the Shopify page, not within a single product's own `Images[]`.
- **Unmatched SKUs are reported, not fixed.** If no Shopify variant carries the Unleashed
  product code, the product is skipped with outcome `unmatched`. A code resolving to more than
  one Shopify product is skipped as `ambiguous`.
- Media stuck in Shopify's `FAILED` state is reported and left alone; delete it in Shopify to
  retry rather than having the sync loop on it.
- No cross-invocation deduplication of webhook events. It isn't needed — the sync is
  diff-based — but two deliveries for one product landing in the same second could both upload.
  The reconcile pass reports any duplicate that results.
- `modifiedSince` reflects **any** product change, not image changes specifically; Unleashed
  offers no image-level event. Products without images are skipped before Shopify is touched.
