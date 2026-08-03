#!/usr/bin/env node
/**
 * Exercises the decision logic with no network access, using URL shapes taken
 * from the live store. Run with: node scripts/self-test.js
 */
import assert from 'node:assert/strict';

import {
  MEDIA_ORIGIN,
  MEDIA_STATUS,
  STATE_VERSION,
  SYNC_HEALTH,
  SYNC_OUTCOME,
} from '../src/constants/index.js';
import {
  buildAuditCsv,
  buildAuditSummary,
  buildDailyCsv,
  buildDailySummary,
  collectProblems,
  orderedProblemDetails,
} from '../src/utils/report.js';
import { diffCatalogue, findNearMiss, buildPrefixIndex } from '../src/utils/audit.js';
import { imageKey, isSameImage, orderedUnleashedImages } from '../src/utils/imageIdentity.js';
import {
  buildState,
  orderAlreadyCorrect,
  planMediaChanges,
  parseState,
  syncUnleashedProduct,
} from '../src/utils/sync.js';
import { buildQueryString, signQueryString, verifyWebhook } from '../src/utils/unleashed.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// Real pairing observed on for-discovery: Unleashed file, then the Shopify copy.
const UNLEASHED_URL = 'https://unlappcdn.syd.public.unl.sh/80f09d43-44ad-404a-ad55-02c99f9b7388.png';
const SHOPIFY_URL =
  'https://cdn.shopify.com/s/files/1/0431/5342/4537/files/80f09d43-44ad-404a-ad55-02c99f9b7388_8b9a1258-4642-4d45-b3b6-f2af015f7d05.png?v=1769662214';

test('imageKey strips query string and extension', () => {
  assert.equal(imageKey(SHOPIFY_URL).startsWith('80f09d43'), true);
  assert.equal(imageKey(SHOPIFY_URL).includes('?'), false);
  assert.equal(imageKey(SHOPIFY_URL).includes('.png'), false);
});

test('Shopify copy is recognised as the same image despite the dedup suffix', () => {
  assert.equal(isSameImage(SHOPIFY_URL, UNLEASHED_URL), true);
});

test('a different image is not matched', () => {
  const other = 'https://cdn.shopify.com/s/files/1/x/files/ade6ac5f-8e69-42d4-a4a7-c9cb3548ef83.png?v=1';
  assert.equal(isSameImage(other, UNLEASHED_URL), false);
});

test('exact filename match works (no dedup suffix)', () => {
  assert.equal(
    isSameImage('https://cdn.shopify.com/s/files/1/x/files/abc123.jpg?v=9', 'https://unl/abc123.jpg'),
    true,
  );
});

test('default image sorts first and the cap is applied', () => {
  const ordered = orderedUnleashedImages(
    [
      { Url: 'https://unl/a.png', IsDefault: false },
      { Url: 'https://unl/b.png', IsDefault: true },
      { Url: 'https://unl/c.png', IsDefault: false },
      { Url: 'https://unl/d.png', IsDefault: false },
      { Url: 'https://unl/e.png', IsDefault: false },
      { Url: 'https://unl/f.png', IsDefault: false },
    ],
    5,
  );
  assert.equal(ordered.length, 5);
  assert.equal(ordered[0].url, 'https://unl/b.png');
  assert.equal(ordered[1].url, 'https://unl/a.png');
  assert.equal(
    ordered.some((image) => image.url.endsWith('f.png')),
    false,
  );
});

test('blank and duplicate Unleashed URLs are dropped', () => {
  const ordered = orderedUnleashedImages(
    [{ Url: '' }, { Url: 'https://unl/a.png' }, { Url: 'https://unl/a.png' }, { Url: null }],
    5,
  );
  assert.equal(ordered.length, 1);
});

test('first run ADOPTS the image the Unleashed connector already pushed', () => {
  const plan = planMediaChanges({
    desired: [
      { url: UNLEASHED_URL, isDefault: true },
      { url: 'https://unl/second.png', isDefault: false },
    ],
    liveMedia: [
      { id: 'gid://shopify/MediaImage/1', status: MEDIA_STATUS.READY, image: { url: SHOPIFY_URL } },
    ],
    state: parseState(null),
  });

  assert.equal(plan.resolved.length, 1, 'the existing image should be adopted, not duplicated');
  assert.equal(plan.resolved[0].origin, MEDIA_ORIGIN.ADOPTED);
  assert.equal(plan.toUpload.length, 1);
  assert.equal(plan.toUpload[0].url, 'https://unl/second.png');
  assert.equal(plan.toDetach.length, 0);
});

test('media added by hand in Shopify is never detached or claimed', () => {
  const plan = planMediaChanges({
    desired: [{ url: UNLEASHED_URL, isDefault: true }],
    liveMedia: [
      { id: 'gid://shopify/MediaImage/1', status: MEDIA_STATUS.READY, image: { url: SHOPIFY_URL } },
      {
        id: 'gid://shopify/MediaImage/2',
        status: MEDIA_STATUS.READY,
        image: { url: 'https://cdn.shopify.com/s/files/1/x/files/lifestyle-shot-by-hand.jpg?v=2' },
      },
    ],
    state: parseState(null),
  });

  assert.equal(plan.toDetach.length, 0);
  assert.equal(plan.unmanagedMedia.length, 1);
  assert.equal(plan.unmanagedMedia[0].id, 'gid://shopify/MediaImage/2');
});

test('an image dropped in Unleashed is only detachable if this service added it', () => {
  const state = {
    version: STATE_VERSION,
    syncedAt: '2026-07-01T00:00:00.000Z',
    managed: [
      { url: UNLEASHED_URL, mediaId: 'gid://shopify/MediaImage/1', origin: MEDIA_ORIGIN.SYNCED },
      { url: 'https://unl/gone.png', mediaId: 'gid://shopify/MediaImage/9', origin: MEDIA_ORIGIN.SYNCED },
    ],
  };
  const plan = planMediaChanges({
    desired: [{ url: UNLEASHED_URL, isDefault: true }],
    liveMedia: [
      { id: 'gid://shopify/MediaImage/1', status: MEDIA_STATUS.READY, image: { url: SHOPIFY_URL } },
      { id: 'gid://shopify/MediaImage/9', status: MEDIA_STATUS.READY, image: { url: 'https://cdn/gone.png' } },
    ],
    state,
  });

  assert.equal(plan.toDetach.length, 1);
  assert.equal(plan.toDetach[0].mediaId, 'gid://shopify/MediaImage/9');
  assert.equal(plan.toUpload.length, 0);
});

test('state pointing at media deleted in Shopify is treated as stale, and re-uploads', () => {
  const state = {
    version: STATE_VERSION,
    managed: [{ url: UNLEASHED_URL, mediaId: 'gid://shopify/MediaImage/deleted' }],
  };
  const plan = planMediaChanges({ desired: [{ url: UNLEASHED_URL, isDefault: true }], liveMedia: [], state });

  assert.equal(plan.toUpload.length, 1);
  assert.equal(plan.toDetach.length, 0);
});

test('a settled product needs no work', () => {
  const state = {
    version: STATE_VERSION,
    managed: [{ url: UNLEASHED_URL, mediaId: 'gid://shopify/MediaImage/1', origin: MEDIA_ORIGIN.SYNCED }],
  };
  const plan = planMediaChanges({
    desired: [{ url: UNLEASHED_URL, isDefault: true }],
    liveMedia: [{ id: 'gid://shopify/MediaImage/1', status: MEDIA_STATUS.READY, image: { url: SHOPIFY_URL } }],
    state,
  });

  assert.equal(plan.toUpload.length, 0);
  assert.equal(plan.toDetach.length, 0);
  assert.equal(plan.resolved.length, 1);
});

test('malformed state metafield degrades to empty rather than throwing', () => {
  assert.deepEqual(parseState({ value: 'not json' }).managed, []);
  assert.deepEqual(parseState({ value: '{"managed":"nope"}' }).managed, []);
  assert.deepEqual(parseState(null).managed, []);
});

test('FAILED media is surfaced', () => {
  const state = {
    version: STATE_VERSION,
    managed: [{ url: UNLEASHED_URL, mediaId: 'gid://shopify/MediaImage/1' }],
  };
  const plan = planMediaChanges({
    desired: [{ url: UNLEASHED_URL, isDefault: true }],
    liveMedia: [
      {
        id: 'gid://shopify/MediaImage/1',
        status: MEDIA_STATUS.FAILED,
        mediaErrors: [{ code: 'INVALID_IMAGE_FILE_SIZE', message: 'too big' }],
        image: { url: SHOPIFY_URL },
      },
    ],
    state,
  });
  assert.equal(plan.failedMedia.length, 1);
});

// --- many Unleashed products sharing one Shopify product -------------------
// Real case on this store: 18K101-3, -4, -5, -6, -7, -10 all resolve to
// gid://shopify/Product/8225786200217, because alloy/size are variant options.

const SIBLING_STATE = {
  version: STATE_VERSION,
  managed: [
    {
      url: 'https://unl/img-for-code-A.png',
      mediaId: 'gid://shopify/MediaImage/A',
      origin: MEDIA_ORIGIN.SYNCED,
      productCode: '18K101-3',
    },
  ],
};
const SIBLING_LIVE = [
  {
    id: 'gid://shopify/MediaImage/A',
    status: MEDIA_STATUS.READY,
    image: { url: 'https://cdn.shopify.com/s/files/1/x/files/img-for-code-A.png?v=1' },
  },
];

test("a sibling product code's image is NEVER detached", () => {
  const plan = planMediaChanges({
    desired: [{ url: 'https://unl/img-for-code-B.png', isDefault: true }],
    liveMedia: SIBLING_LIVE,
    state: SIBLING_STATE,
    productCode: '18K101-4',
  });

  assert.equal(plan.toDetach.length, 0, "must not detach 18K101-3's image while syncing -4");
  assert.equal(plan.toUpload.length, 1);
  assert.equal(plan.siblingManaged.length, 1);
});

test('reorder is suppressed when a sibling product owns media here', () => {
  const plan = planMediaChanges({
    desired: [{ url: 'https://unl/img-for-code-B.png', isDefault: true }],
    liveMedia: SIBLING_LIVE,
    state: SIBLING_STATE,
    productCode: '18K101-4',
  });
  // siblingManaged non-empty is what syncUnleashedProduct gates reordering on.
  assert.ok(plan.siblingManaged.length > 0);
});

test("writing state preserves sibling product codes' entries", () => {
  const next = buildState({
    productCode: '18K101-4',
    entries: [
      {
        url: 'https://unl/img-for-code-B.png',
        mediaId: 'gid://shopify/MediaImage/B',
        origin: MEDIA_ORIGIN.SYNCED,
        isDefault: true,
      },
    ],
    previousManaged: SIBLING_STATE.managed,
    liveMediaIds: new Set(['gid://shopify/MediaImage/A', 'gid://shopify/MediaImage/B']),
  });

  const codes = next.managed.map((entry) => entry.productCode).sort();
  assert.deepEqual(codes, ['18K101-3', '18K101-4'], 'both codes must survive the write');
  assert.equal(next.managed.length, 2);
});

test('an image already placed by a sibling is reused, not uploaded twice', () => {
  // Both Unleashed products point at the same image URL.
  const shared = 'https://unl/img-for-code-A.png';
  const plan = planMediaChanges({
    desired: [{ url: shared, isDefault: true }],
    liveMedia: SIBLING_LIVE,
    state: SIBLING_STATE,
    productCode: '18K101-4',
  });

  assert.equal(plan.toUpload.length, 0, 'should reuse the sibling-placed media');
  assert.equal(plan.resolved.length, 1);
  assert.equal(plan.toDetach.length, 0);
});

test('stale sibling entries are dropped from state when their media is gone', () => {
  const next = buildState({
    productCode: '18K101-4',
    entries: [],
    previousManaged: SIBLING_STATE.managed,
    liveMediaIds: new Set(['gid://shopify/MediaImage/B']), // A was deleted in Shopify
  });
  assert.equal(next.managed.length, 0);
});

// --- page cap: "5 per unleashed product, cap each web page at 5 as well" ------

const CAP_LIVE = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `gid://shopify/MediaImage/live${i}`,
    status: MEDIA_STATUS.READY,
    image: { url: `https://cdn.shopify.com/s/files/1/x/files/existing-${i}.png?v=1` },
  }));

const CAP_DESIRED = [
  { url: 'https://unl/new-default.png', isDefault: true },
  { url: 'https://unl/new-second.png', isDefault: false },
  { url: 'https://unl/new-third.png', isDefault: false },
];

test('page cap limits total images on the Shopify product', () => {
  const plan = planMediaChanges({
    desired: CAP_DESIRED,
    liveMedia: CAP_LIVE(3),
    state: parseState(null),
    productCode: 'X',
    maxMediaPerProduct: 5,
  });
  assert.equal(plan.toUpload.length, 2, '3 already there + 2 new = 5');
  assert.equal(plan.skippedForCap.length, 1);
});

test('the default image is the one that survives the cap', () => {
  const plan = planMediaChanges({
    desired: CAP_DESIRED,
    liveMedia: CAP_LIVE(4),
    state: parseState(null),
    productCode: 'X',
    maxMediaPerProduct: 5,
  });
  assert.equal(plan.toUpload.length, 1);
  assert.equal(plan.toUpload[0].url, 'https://unl/new-default.png');
  assert.equal(plan.skippedForCap.length, 2);
});

test('a full page accepts nothing, and still removes nothing', () => {
  const plan = planMediaChanges({
    desired: CAP_DESIRED,
    liveMedia: CAP_LIVE(5),
    state: parseState(null),
    productCode: 'X',
    maxMediaPerProduct: 5,
  });
  assert.equal(plan.toUpload.length, 0);
  assert.equal(plan.skippedForCap.length, 3);
  assert.equal(plan.toDetach.length, 0, 'the cap must never cause a removal');
});

test('an over-full page (hand-added images) is left alone, not trimmed', () => {
  const plan = planMediaChanges({
    desired: CAP_DESIRED,
    liveMedia: CAP_LIVE(8),
    state: parseState(null),
    productCode: 'X',
    maxMediaPerProduct: 5,
  });
  assert.equal(plan.toUpload.length, 0);
  assert.equal(plan.toDetach.length, 0);
  assert.equal(plan.unmanagedMedia.length, 8);
});

test('adopted images occupy cap slots without consuming an upload', () => {
  // The page already holds this product's Unleashed image under a Shopify name.
  const plan = planMediaChanges({
    desired: [{ url: UNLEASHED_URL, isDefault: true }, ...CAP_DESIRED.slice(0, 2)],
    liveMedia: [
      { id: 'gid://shopify/MediaImage/1', status: MEDIA_STATUS.READY, image: { url: SHOPIFY_URL } },
      ...CAP_LIVE(3),
    ],
    state: parseState(null),
    productCode: 'X',
    maxMediaPerProduct: 5,
  });
  assert.equal(plan.resolved.length, 1, 'existing image adopted, not re-uploaded');
  assert.equal(plan.toUpload.length, 1, '4 on the page leaves room for exactly 1');
  assert.equal(plan.skippedForCap.length, 1);
});

test('no cap supplied means no cap applied', () => {
  const plan = planMediaChanges({
    desired: CAP_DESIRED,
    liveMedia: CAP_LIVE(20),
    state: parseState(null),
    productCode: 'X',
  });
  assert.equal(plan.toUpload.length, 3);
  assert.equal(plan.skippedForCap.length, 0);
});

test('a product blocked entirely by the cap reports as CAPPED, never as unchanged', async () => {
  // Reports drop `unchanged` rows as noise. If a fully-capped product reported
  // `unchanged`, every skipped image would vanish from the run summary and a
  // truncated backfill would look clean — which is exactly what happened on the
  // first live backfill before this was fixed.
  const shopify = {
    findProductsBySku: async () => ({
      products: [{ id: 'gid://shopify/Product/1', title: 'Full Product' }],
      variantIds: [],
    }),
    getProduct: async () => ({
      id: 'gid://shopify/Product/1',
      title: 'Full Product',
      media: CAP_LIVE(5),
      stateMetafield: null,
    }),
    appendImage: async () => assert.fail('must not upload when the page is full'),
    detachMedia: async () => assert.fail('the cap must never cause a removal'),
    reorderMedia: async () => assert.fail('must not reorder a capped product'),
    saveState: async () => [],
  };

  const result = await syncUnleashedProduct({
    unleashedProduct: {
      ProductCode: 'CAPPED-1',
      Guid: 'g',
      Images: [{ Url: 'https://unl/wants-in.png', IsDefault: true }],
    },
    shopify,
    config: {
      maxSyncedImages: 5,
      maxMediaPerProduct: 5,
      deleteRemovedMedia: false,
      reorderMedia: true,
      dryRun: false,
    },
    log: { info() {}, warn() {}, error() {} },
  });

  assert.equal(result.outcome, SYNC_OUTCOME.CAPPED);
  assert.equal(result.skippedForCap.length, 1);
  assert.equal(result.added.length, 0);
  assert.ok(
    result.notes.some((n) => n.includes('page cap reached')),
    'the skipped image must be explained in the notes',
  );
});

test('an already-correct order is not reordered again', () => {
  assert.equal(orderAlreadyCorrect(['a', 'b', 'c'], ['a', 'b']), true);
  assert.equal(orderAlreadyCorrect(['a', 'b'], ['a', 'b']), true);
  assert.equal(orderAlreadyCorrect(['a', 'b'], []), true);
  assert.equal(orderAlreadyCorrect(['b', 'a'], ['a', 'b']), false);
  assert.equal(orderAlreadyCorrect(['a'], ['a', 'b']), false, 'a freshly appended image needs a move');
});

// --- daily report health verdict ---------------------------------------------

const summaryOf = (byOutcome, extra = {}) =>
  buildDailySummary({
    report: { scanned: 100, withImages: 60, byOutcome, details: [], ...extra },
    pendingWarnThreshold: 5,
    lookbackHours: 24,
  });

test('a quiet day is healthy', () => {
  const s = summaryOf({ unchanged: 60 });
  assert.equal(s.health, SYNC_HEALTH.OK);
  assert.equal(s.counts.pending, 0);
});

test('any failure is an alert', () => {
  const s = summaryOf({ unchanged: 59, failed: 1 });
  assert.equal(s.health, SYNC_HEALTH.ALERT);
});

test('pending work beyond the threshold warns — the silent-failure signal', () => {
  assert.equal(summaryOf({ dry_run: 6 }).health, SYNC_HEALTH.WARN);
  assert.equal(summaryOf({ dry_run: 5 }).health, SYNC_HEALTH.OK, 'at the threshold is tolerated');
});

test('failures outrank pending work rather than being masked by it', () => {
  const s = summaryOf({ dry_run: 99, failed: 2 });
  assert.equal(s.health, SYNC_HEALTH.ALERT, 'must not be downgraded to warn');
  assert.equal(s.reasons.length, 2, 'both problems reported');
});

test('unmatched and capped are reported but never alert', () => {
  // These are steady-state facts about the data. Alerting daily on them would
  // train everyone to ignore the report.
  const s = summaryOf({ unchanged: 40, unmatched: 185, capped: 273 });
  assert.equal(s.health, SYNC_HEALTH.OK);
  assert.equal(s.counts.unmatched, 185);
  assert.equal(s.counts.capped, 273);
  assert.ok(s.text.includes('185'));
});

test('a truncated check says so, so counts are not read as complete', () => {
  const s = summaryOf({ unchanged: 10 }, { truncated: true });
  assert.ok(s.text.includes('lower bound'));
});

test('problem products are named, capped in length', () => {
  const report = {
    details: Array.from({ length: 12 }, (_, i) => ({
      productCode: `CODE-${i}`,
      outcome: SYNC_OUTCOME.DRY_RUN,
      notes: ['would upload 1'],
    })),
  };
  const rows = collectProblems(report, 8);
  assert.equal(rows[0].productCode, 'CODE-0');
  assert.ok(rows.at(-1).productCode.includes('and 4 more'));
  assert.ok(rows.at(-1).productCode.includes('CSV'), 'says where the rest are');
  assert.deepEqual(collectProblems({ details: [] }), []);
});

// --- naming the SKUs behind the counts ----------------------------------------

const MIXED_DETAILS = [
  {
    productCode: 'CAPPED-1',
    outcome: SYNC_OUTCOME.CAPPED,
    imageCount: 7,
    description: 'Belcher Chain',
    notes: ['Unleashed holds 7 images; syncing the first 5 (cap 5).', 'page cap reached (5/5)'],
  },
  {
    productCode: 'NOSKU-1',
    outcome: SYNC_OUTCOME.UNMATCHED,
    imageCount: 2,
    description: 'Signet Ring',
    notes: ['No Shopify variant carries this product code'],
  },
  {
    productCode: 'PENDING-1',
    outcome: SYNC_OUTCOME.DRY_RUN,
    imageCount: 3,
    description: 'Curb Bracelet',
    notes: ['would upload 1, detach 0, adopt 0, reorder: false'],
  },
  { productCode: 'BROKEN-1', outcome: SYNC_OUTCOME.FAILED, notes: ['boom'] },
];

test('a healthy report still names its pending, unmatched and capped SKUs', () => {
  // The whole point of the change: an OK verdict with 2 pending and 5 unmatched
  // used to print the counts and nothing else, so "which SKUs?" went to the logs.
  const s = summaryOf(
    { unchanged: 40, dry_run: 1, unmatched: 1, capped: 1 },
    { details: MIXED_DETAILS.filter((d) => d.outcome !== SYNC_OUTCOME.FAILED) },
  );
  assert.equal(s.health, SYNC_HEALTH.OK);
  for (const code of ['PENDING-1', 'NOSKU-1', 'CAPPED-1']) {
    assert.ok(s.text.includes(code), `${code} named in the text body`);
    assert.ok(s.html.includes(code), `${code} named in the HTML body`);
  }
});

test('rows are worst first, and labelled in English rather than enum values', () => {
  const rows = collectProblems({ details: MIXED_DETAILS });
  assert.deepEqual(
    rows.map((row) => row.productCode),
    ['BROKEN-1', 'PENDING-1', 'NOSKU-1', 'CAPPED-1'],
  );
  assert.deepEqual(
    rows.map((row) => row.outcome),
    ['failed', 'pending', 'unmatched SKU', 'declined by the image cap'],
  );
  assert.ok(!rows.some((row) => row.outcome.includes('dry_run')));
});

test('a row says how many images are at stake and what the product is', () => {
  const [capped] = collectProblems({ details: [MIXED_DETAILS[0]] });
  assert.ok(capped.note.includes('7 image(s)'));
  assert.ok(capped.note.includes('Belcher Chain'));
  // Every note, not just the first — the cap note is second on a capped product.
  assert.ok(capped.note.includes('page cap reached'), 'the reason survives');
});

test('a long note stops at a word boundary, and the CSV keeps the whole thing', () => {
  const detail = {
    productCode: 'LONG-1',
    outcome: SYNC_OUTCOME.UNMATCHED,
    imageCount: 1,
    description: 'Pendant '.repeat(60).trim(),
    notes: ['No Shopify variant carries this product code'],
  };
  const [row] = collectProblems({ details: [detail] });
  assert.ok(row.note.endsWith('…'));
  assert.ok(!row.note.includes('Penda…'), 'no half-word before the ellipsis');
  assert.ok(row.note.length <= 201);
  // The CSV is the complete record; only the email body is a summary.
  assert.ok(buildDailyCsv({ details: [detail] }).includes(detail.description));
});

test('the detail CSV carries every listed product, not just the inline ones', () => {
  const details = Array.from({ length: 60 }, (_, i) => ({
    productCode: `CODE-${i}`,
    outcome: SYNC_OUTCOME.UNMATCHED,
    imageCount: 1,
    description: 'Ring, 9ct',
    notes: ['No Shopify variant carries this product code'],
  }));
  const csv = buildDailyCsv({ details });
  assert.equal(csv.split('\n').length, 61, 'header plus every row');
  assert.ok(csv.includes('CODE-59'), 'beyond the inline limit');
  assert.equal(orderedProblemDetails({ details }).length, 60);
  assert.equal(collectProblems({ details }).length, 41, 'inline list stays capped');
});

test('CSV free text with commas survives quoting, and unchanged rows stay out', () => {
  const csv = buildDailyCsv({
    details: [
      { productCode: 'A', outcome: SYNC_OUTCOME.UNMATCHED, description: 'Ring, 9ct, "wide"' },
      { productCode: 'B', outcome: SYNC_OUTCOME.UNCHANGED, description: 'noise' },
    ],
  });
  assert.ok(csv.includes('"Ring, 9ct, ""wide"""'));
  assert.ok(!csv.includes('noise'), 'settled products are not a worklist');
});

// --- zero activity: quiet day vs dead sync -----------------------------------

const zeroActivity = (activity) =>
  buildDailySummary({
    report: { scanned: 0, withImages: 0, byOutcome: {}, details: [] },
    pendingWarnThreshold: 5,
    lookbackHours: 24,
    activity,
  });

test('a silent 24h with changes earlier in the week is a quiet day, not an alert', () => {
  // Weekends and holidays are silent. Alerting on them would fire most weeks and
  // be filtered to trash long before a real outage arrived.
  const s = zeroActivity({ probeDays: 7, probeCount: 42 });
  assert.equal(s.health, SYNC_HEALTH.OK);
  assert.ok(s.text.includes('quiet day'));
});

test('a silent week is an alert — the sync has stopped seeing Unleashed', () => {
  const s = zeroActivity({ probeDays: 7, probeCount: 0 });
  assert.equal(s.health, SYNC_HEALTH.ALERT);
  assert.ok(s.subject.includes('no Unleashed activity in 7 days'));
});

test('a failed activity probe still produces a report', () => {
  // The probe refines the verdict; losing it must not lose the report.
  const s = zeroActivity(null);
  assert.equal(s.health, SYNC_HEALTH.OK);
  assert.ok(s.text.includes('No Unleashed changes'));
});

test('real failures still outrank a quiet day', () => {
  const s = buildDailySummary({
    report: { scanned: 0, withImages: 0, byOutcome: { failed: 3 }, details: [] },
    pendingWarnThreshold: 5,
    lookbackHours: 24,
    activity: { probeDays: 7, probeCount: 99 },
  });
  assert.equal(s.health, SYNC_HEALTH.ALERT);
});

// --- weekly catalogue audit ---------------------------------------------------

const skuMap = (entries) =>
  new Map(entries.map((sku) => [sku, { productId: `gid://${sku}`, title: sku, productCount: 1 }]));

test('a product with images and no Shopify SKU is unmatched', () => {
  const result = diffCatalogue({
    products: [
      { ProductCode: '9KABC10', ProductDescription: 'Chain', Images: [{ Url: 'a.jpg' }] },
      { ProductCode: '9KMATCH', ProductDescription: 'Ring', Images: [{ Url: 'b.jpg' }] },
    ],
    skus: skuMap(['9kmatch']),
  });

  assert.equal(result.matched, 1);
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.unmatched[0].productCode, '9KABC10');
  assert.equal(result.unmatched[0].imageCount, 1);
});

test('products without images are left out — nothing is stranded', () => {
  // They would bury the actionable list under stock that was never going to
  // show a photo.
  const result = diffCatalogue({
    products: [{ ProductCode: 'NOPHOTO', Images: [] }],
    skus: skuMap([]),
  });
  assert.equal(result.withImages, 0);
  assert.equal(result.unmatched.length, 0);
});

test('near-miss SKUs are suggested in both directions', () => {
  const index = buildPrefixIndex(['18kdsc10w', '9ktfy05542cm', 'unrelated']);
  // Shopify has a suffix Unleashed lacks.
  assert.equal(findNearMiss('18kdsc10', index), '18kdsc10w');
  assert.equal(findNearMiss('9ktfy055', index), '9ktfy05542cm');
  // Unleashed has a suffix Shopify lacks.
  assert.equal(findNearMiss('unrelatedxx', index), 'unrelated');
  assert.equal(findNearMiss('zzzzzzzz', index), null);
});

test('likely typos sort above products genuinely absent from Shopify', () => {
  const result = diffCatalogue({
    products: [
      { ProductCode: 'ABSENT99', Images: [{ Url: 'a' }, { Url: 'b' }] },
      { ProductCode: '18KDSC10', Images: [{ Url: 'c' }] },
    ],
    skus: skuMap(['18kdsc10w']),
  });

  assert.equal(result.unmatched[0].productCode, '18KDSC10', 'the one-character fix comes first');
  assert.equal(result.unmatched[0].suggestion, '18kdsc10w');
  assert.equal(result.unmatched[1].suggestion, '');
});

test('a SKU on two Shopify products is reported as a duplicate', () => {
  const skus = new Map([['dupe1', { productId: 'gid://1', title: 'A', productCount: 2 }]]);
  const result = diffCatalogue({
    products: [{ ProductCode: 'DUPE1', Images: [{ Url: 'a' }] }],
    skus,
  });
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].productCount, 2);
});

test('the audit email carries the count in the subject and a CSV of the backlog', () => {
  const audit = {
    scanned: 6565,
    withImages: 2700,
    matched: 2515,
    skuCount: 5000,
    unmatched: [
      { productCode: '18KDSC10', description: 'Chain, 50cm', imageCount: 2, suggestion: '18kdsc10w' },
      { productCode: 'ABSENT99', description: 'Ring "special", 9ct', imageCount: 1, suggestion: '' },
    ],
    duplicates: [],
  };
  const summary = buildAuditSummary({ audit });

  assert.equal(summary.health, SYNC_HEALTH.WARN, 'a worklist warns, it is not an incident');
  assert.ok(summary.subject.includes('2 product(s)'), 'the count is visible without opening it');

  const csv = buildAuditCsv(audit);
  const rows = csv.split('\n');
  assert.equal(rows[0], 'product_code,images,likely_shopify_sku,description');
  assert.ok(rows[1].includes('18kdsc10w'));
  // A comma and a quote in a description must not break the columns.
  assert.ok(rows[2].includes('"Ring ""special"", 9ct"'));
});

test('a clean audit is OK and says there is nothing to action', () => {
  const summary = buildAuditSummary({
    audit: { scanned: 10, withImages: 5, matched: 5, skuCount: 5, unmatched: [], duplicates: [] },
  });
  assert.equal(summary.health, SYNC_HEALTH.OK);
  assert.ok(summary.text.includes('Nothing to action'));
});

test('report bodies carry no Slack markup now that delivery is email', () => {
  const s = zeroActivity({ probeDays: 7, probeCount: 5 });
  assert.ok(!s.text.includes(':white_check_mark:'));
  assert.ok(!/\*[A-Za-z]/.test(s.text), 'no leftover *bold* markers');
  assert.ok(s.html.includes('<table'), 'HTML body is table-based for Outlook');
});

test('free text from Unleashed is escaped before it reaches the HTML body', () => {
  const summary = buildAuditSummary({
    audit: {
      scanned: 1,
      withImages: 1,
      matched: 0,
      skuCount: 0,
      duplicates: [],
      unmatched: [
        { productCode: '<img src=x onerror=alert(1)>', description: 'a & b', imageCount: 1, suggestion: '' },
      ],
    },
  });
  assert.ok(!summary.html.includes('<img src=x'));
  assert.ok(summary.html.includes('&lt;img'));
  assert.ok(summary.html.includes('a &amp; b'));
});

test('timestamps keep raw colons — %3A is rejected by Unleashed with a bare 403', () => {
  // Regression guard on a live outage: URLSearchParams encodes ':' as '%3A',
  // and Unleashed 403s the signed query string when it does. Every
  // `modifiedSince` call failed while parameter-free calls succeeded, so the
  // reconcile timer was dead while the webhook path looked fine.
  const qs = buildQueryString({ pageSize: 1, modifiedSince: '2026-08-02T00:00:00' });
  assert.ok(!qs.includes('%3A'), 'colons must not be percent-encoded');
  assert.equal(qs, 'pageSize=1&modifiedSince=2026-08-02T00:00:00');

  // Everything else stays encoded — only the colon is special-cased.
  assert.equal(buildQueryString({ q: 'a b&c' }), 'q=a+b%26c');
  // Empty and absent values are dropped, so they never reach the signature.
  assert.equal(buildQueryString({ a: 1, b: undefined, c: '' }), 'a=1');
});

test('Unleashed request signature is HMAC-SHA256 of the query string, base64', () => {
  // Regression guard on our own output. The algorithm itself (UTF-8 key, HMAC-SHA256
  // over the query string with no leading '?', base64) mirrors the C# sample in
  // Unleashed's auth docs; a live call is the real confirmation.
  assert.equal(
    signQueryString('customerCode=ACME', 'secret-key'),
    'adEw/1gTNmqdfSRLMqUNj7dJyDYodHUeekxdpTcf0dg=',
  );
  // No query string signs the empty string.
  assert.equal(signQueryString('', 'secret-key').length > 0, true);
});

test('webhook signature verification accepts a correct delivery', () => {
  const key = 'whsec-test';
  const body = JSON.stringify({ eventType: 'product.updated', data: { productGuid: 'abc' } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signQueryString(`${timestamp}.${body}`, key);

  assert.equal(
    verifyWebhook({ rawBody: body, signature, timestamp, signatureKey: key }).valid,
    true,
  );
});

test('webhook verification rejects a tampered body, bad key and stale timestamp', () => {
  const key = 'whsec-test';
  const body = JSON.stringify({ eventType: 'product.updated' });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signQueryString(`${timestamp}.${body}`, key);

  assert.equal(
    verifyWebhook({ rawBody: `${body} `, signature, timestamp, signatureKey: key }).valid,
    false,
  );
  assert.equal(
    verifyWebhook({ rawBody: body, signature, timestamp, signatureKey: 'wrong' }).valid,
    false,
  );

  const stale = String(Math.floor(Date.now() / 1000) - 3600);
  assert.equal(
    verifyWebhook({
      rawBody: body,
      signature: signQueryString(`${stale}.${body}`, key),
      timestamp: stale,
      signatureKey: key,
    }).valid,
    false,
  );
  assert.equal(verifyWebhook({ rawBody: body, signature: '', timestamp, signatureKey: key }).valid, false);
});

let failures = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

console.log(`\n${tests.length - failures}/${tests.length} passed`);
process.exit(failures === 0 ? 0 : 1);
