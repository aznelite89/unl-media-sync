#!/usr/bin/env node
/**
 * Exercises the decision logic with no network access, using URL shapes taken
 * from the live store. Run with: node scripts/self-test.js
 */
import assert from 'node:assert/strict';

import {
  DAILY_REPORTED_OUTCOMES,
  DUPLICATE_KIND,
  EMPTY_IMAGES_CORROBORATION_MIN,
  EMPTY_IMAGES_MAX_PER_RUN,
  MEDIA_ORIGIN,
  MEDIA_STATUS,
  REPORT_SKIP_REASON,
  STATE_VERSION,
  SYNC_HEALTH,
  SYNC_OUTCOME,
  WEBSITE_IMAGE_STATUS,
} from '../src/constants/index.js';
import {
  buildAuditCsv,
  buildAuditSummary,
  buildDailyCsv,
  buildDailySummary,
  buildDuplicateCsv,
  buildDuplicateSummary,
  buildMissingImagesCsv,
  buildMissingImagesSummary,
  collectProblems,
  describeWindow,
  orderedProblemDetails,
} from '../src/utils/report.js';
import { diffCatalogue, findNearMiss, buildPrefixIndex } from '../src/utils/audit.js';
import { auditMissingImages, findMissingImages } from '../src/utils/missingImages.js';
import { isDailyEmailDue, isWeeklyReportDay, sendReport } from '../src/utils/notify.js';
import {
  findDuplicateGroups,
  isForeignDuplicate,
  planDuplicateCleanup,
  summariseDuplicateGroups,
  auditDuplicates,
} from '../src/utils/duplicates.js';
import { reconcile } from '../src/utils/reconcile.js';
import { imageKey, isSameImage, orderedUnleashedImages } from '../src/utils/imageIdentity.js';
import {
  contentKey,
  fetchImageFingerprint,
  isSameContent,
  readImageSize,
  shopifyFingerprint,
  totalBytesOf,
} from '../src/utils/imageFingerprint.js';
import {
  buildState,
  orderAlreadyCorrect,
  planMediaChanges,
  parseState,
  syncUnleashedProduct,
} from '../src/utils/sync.js';
import { buildQueryString, signQueryString, verifyWebhook } from '../src/utils/unleashed.js';
import { NOTES_OUTCOME, SHOPIFY_ORDER_CREATOR } from '../src/constants/index.js';
import { forceRestore, guardNotes } from '../src/utils/customerNotes.js';
import {
  NOTES_ACTION,
  parseSnapshot,
  parseUnleashedDate,
  planNotes,
  sameNotes,
} from '../src/utils/customerNotesPlan.js';
import { createMemoryNotesStore } from '../src/utils/customerNotesStore.js';
import { NEW_ARRIVAL_OUTCOME, NEW_ARRIVAL_TAG } from '../src/constants/index.js';
import {
  newArrivalCutoff,
  newestFirst,
  planNewArrivals,
  recentCodes,
  reorderMoves,
} from '../src/utils/newArrivalsPlan.js';
import { syncNewArrivals } from '../src/utils/newArrivals.js';
import { SPECIAL_CATEGORY, WEEKLY_SPECIAL_TAG } from '../src/constants/index.js';
import {
  designFamily,
  landedDates,
  planWeeklySpecials,
  relatedKey,
  specialCategory,
  weeklyShuffle,
} from '../src/utils/weeklySpecialsPlan.js';
import { syncWeeklySpecials } from '../src/utils/weeklySpecials.js';
import { buildWeeklySpecialsCsv, buildWeeklySpecialsSummary } from '../src/utils/report.js';

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

// --- replaced images must not be stranded ------------------------------------
//
// 18KDP240/9KDP240: the Unleashed photo was swapped, the old Shopify image was
// left in place because DELETE_REMOVED_MEDIA is off, and its state entry was
// rewritten away. It became unowned — and the sync never removes media it does
// not own, so it could never be cleaned up afterwards.

const REPLACED_STATE = {
  version: STATE_VERSION,
  managed: [
    {
      url: 'https://unl/old-photo.png',
      mediaId: 'gid://shopify/MediaImage/OLD',
      origin: MEDIA_ORIGIN.SYNCED,
      isDefault: true,
      productCode: '18KDP240',
    },
  ],
};

test('an image Unleashed dropped keeps its ownership record while it is still on the page', () => {
  const plan = planMediaChanges({
    desired: [{ url: 'https://unl/new-photo.png', isDefault: true }],
    liveMedia: [
      {
        id: 'gid://shopify/MediaImage/OLD',
        status: MEDIA_STATUS.READY,
        image: { url: 'https://cdn.shopify.com/s/files/1/x/files/old-photo.png?v=1' },
      },
    ],
    state: REPLACED_STATE,
    productCode: '18KDP240',
  });
  assert.equal(plan.toDetach.length, 1, 'the replaced image is a detach candidate');

  // DELETE_REMOVED_MEDIA off: nothing was detached, so nothing may be forgotten.
  const next = buildState({
    productCode: '18KDP240',
    entries: [
      {
        url: 'https://unl/new-photo.png',
        mediaId: 'gid://shopify/MediaImage/NEW',
        origin: MEDIA_ORIGIN.SYNCED,
        isDefault: true,
      },
    ],
    previousManaged: REPLACED_STATE.managed,
    liveMediaIds: new Set(['gid://shopify/MediaImage/OLD', 'gid://shopify/MediaImage/NEW']),
    retained: plan.toDetach,
  });

  const ids = next.managed.map((entry) => entry.mediaId).sort();
  assert.deepEqual(ids, ['gid://shopify/MediaImage/NEW', 'gid://shopify/MediaImage/OLD']);
  const old = next.managed.find((entry) => entry.mediaId === 'gid://shopify/MediaImage/OLD');
  assert.equal(old.productCode, '18KDP240', 'the old image stays owned by the code that added it');
  assert.equal(old.isDefault, false, 'an image Unleashed dropped is nobody’s default');
});

test('a retained entry is dropped once its media really is gone from Shopify', () => {
  const next = buildState({
    productCode: '18KDP240',
    entries: [],
    previousManaged: REPLACED_STATE.managed,
    liveMediaIds: new Set(), // detached successfully, or removed by hand
    retained: REPLACED_STATE.managed,
  });
  assert.equal(next.managed.length, 0);
});

test('a retained entry never duplicates one this run just wrote', () => {
  const next = buildState({
    productCode: '18KDP240',
    entries: [
      {
        url: 'https://unl/new-photo.png',
        mediaId: 'gid://shopify/MediaImage/OLD',
        origin: MEDIA_ORIGIN.ADOPTED_BY_CONTENT,
        isDefault: true,
      },
    ],
    previousManaged: REPLACED_STATE.managed,
    liveMediaIds: new Set(['gid://shopify/MediaImage/OLD']),
    retained: REPLACED_STATE.managed,
  });
  assert.equal(next.managed.length, 1, 'one media item, one entry');
  assert.equal(next.managed[0].isDefault, true);
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

// A product whose Unleashed image list lost one entry and kept another. The
// kept image is what keeps this out of the `no_images` early return, which is a
// separate case with its own hazard — see the note in `syncUnleashedProduct`.
const RETAINED_OLD = 'gid://shopify/MediaImage/OLD';
const RETAINED_KEEP = 'gid://shopify/MediaImage/KEEP';

const RETAINED_MEDIA = [
  {
    id: RETAINED_OLD,
    status: MEDIA_STATUS.READY,
    image: { url: 'https://cdn.shopify.com/s/files/1/x/files/old-photo.png?v=1' },
  },
  {
    id: RETAINED_KEEP,
    status: MEDIA_STATUS.READY,
    image: { url: 'https://cdn.shopify.com/s/files/1/x/files/keep-photo.png?v=1' },
  },
];

const RETAINED_STATE = {
  version: STATE_VERSION,
  managed: [
    {
      url: 'https://unl/old-photo.png',
      mediaId: RETAINED_OLD,
      origin: MEDIA_ORIGIN.SYNCED,
      isDefault: false,
      productCode: 'DELETED-1',
    },
    {
      url: 'https://unl/keep-photo.png',
      mediaId: RETAINED_KEEP,
      origin: MEDIA_ORIGIN.SYNCED,
      isDefault: true,
      productCode: 'DELETED-1',
    },
  ],
};

/** Unleashed after somebody deleted `old-photo` and left `keep-photo` alone. */
const RETAINED_PRODUCT = {
  ProductCode: 'DELETED-1',
  Guid: 'g',
  Images: [{ Url: 'https://unl/keep-photo.png', IsDefault: true }],
};

const retainedShopify = (overrides = {}) => ({
  findProductsBySku: async () => ({
    products: [{ id: 'gid://shopify/Product/1', title: 'P' }],
    variantIds: [],
  }),
  getProduct: async () => ({
    id: 'gid://shopify/Product/1',
    title: 'P',
    media: RETAINED_MEDIA,
    stateMetafield: { value: JSON.stringify(RETAINED_STATE) },
  }),
  appendImage: async () => assert.fail('the kept image is already tracked'),
  detachMedia: async () => [],
  reorderMedia: async () => null,
  saveState: async () => [],
  ...overrides,
});

const RETAINED_CONFIG = (deleteRemovedMedia) => ({
  maxSyncedImages: 5,
  maxMediaPerProduct: 5,
  deleteRemovedMedia,
  reorderMedia: true,
  dryRun: false,
});

test('an image deleted in Unleashed and left on the page reports as RETAINED, never as unchanged', async () => {
  // The gap this closes: with removal off the sync has no work to do, so the
  // product reported `unchanged` — which `details` drops as noise — and the note
  // explaining that a deleted image is still live reached nobody. Someone had to
  // notice it on the website instead.
  const result = await syncUnleashedProduct({
    unleashedProduct: RETAINED_PRODUCT,
    shopify: retainedShopify({
      detachMedia: async () => assert.fail('removal is off'),
    }),
    config: RETAINED_CONFIG(false),
    log: { info() {}, warn() {}, error() {} },
  });

  assert.equal(result.outcome, SYNC_OUTCOME.RETAINED);
  assert.deepEqual(result.retained, [RETAINED_OLD]);
  assert.deepEqual(result.detached, []);
  assert.ok(
    result.notes.some((n) => n.includes('no longer in Unleashed')),
    'the report row must explain itself',
  );
  assert.ok(DAILY_REPORTED_OUTCOMES.includes(result.outcome), 'and must survive the report filter');
});

test('a detach that throws reports as RETAINED, not as a clean sync', async () => {
  // Removal on and the write refused — ACCESS_DENIED when the token is missing
  // `write_files` is the case that matters. `synced` is filtered out of the
  // daily report exactly as `unchanged` is, so this would have looked fine.
  const result = await syncUnleashedProduct({
    unleashedProduct: RETAINED_PRODUCT,
    shopify: retainedShopify({
      detachMedia: async () => {
        throw new Error('ACCESS_DENIED');
      },
    }),
    config: RETAINED_CONFIG(true),
    log: { info() {}, warn() {}, error() {} },
  });

  assert.equal(result.outcome, SYNC_OUTCOME.RETAINED);
  assert.deepEqual(result.detached, [], 'nothing came off');
  assert.deepEqual(result.retained, [RETAINED_OLD]);
});

test('a detach that succeeds is a plain sync, with nothing retained', async () => {
  let detached = null;
  const result = await syncUnleashedProduct({
    unleashedProduct: RETAINED_PRODUCT,
    shopify: retainedShopify({
      detachMedia: async ({ mediaIds }) => {
        detached = mediaIds;
        return [];
      },
    }),
    config: RETAINED_CONFIG(true),
    log: { info() {}, warn() {}, error() {} },
  });

  assert.deepEqual(detached, [RETAINED_OLD], 'only the dropped image');
  assert.equal(result.outcome, SYNC_OUTCOME.SYNCED);
  assert.deepEqual(result.retained, []);
});

// --- the last image ----------------------------------------------------------
//
// Deleting the last image a product has is the one deletion the sync used to be
// blind to: it returned `no_images` before its first Shopify call, so the
// picture stayed on the website however removal was configured. Acting on an
// empty `Images[]` is only safe once the run has shown the feed is sound.

const LAST_IMAGE_STATE = {
  version: STATE_VERSION,
  managed: [
    {
      url: 'https://unl/only-photo.png',
      mediaId: RETAINED_OLD,
      origin: MEDIA_ORIGIN.SYNCED,
      isDefault: true,
      productCode: 'LAST-1',
    },
  ],
};

const lastImageShopify = (detachedOut) => ({
  findProductsBySku: async () => ({
    products: [{ id: 'gid://shopify/Product/1', title: 'P' }],
    variantIds: [],
  }),
  getProduct: async () => ({
    id: 'gid://shopify/Product/1',
    title: 'P',
    media: [RETAINED_MEDIA[0]],
    stateMetafield: { value: JSON.stringify(LAST_IMAGE_STATE) },
  }),
  appendImage: async () => assert.fail('there is nothing to upload'),
  detachMedia: async ({ mediaIds }) => {
    detachedOut.push(...mediaIds);
    return [];
  },
  reorderMedia: async () => null,
  saveState: async () => [],
});

const LAST_IMAGE_PRODUCT = { ProductCode: 'LAST-1', Guid: 'g', Images: [] };

test('an uncorroborated empty image list is never acted on', async () => {
  // The safe default, and the whole reason this is not just a deleted branch:
  // an Unleashed fault that strips Images[] must not cost a product its photos.
  const detached = [];
  const result = await syncUnleashedProduct({
    unleashedProduct: LAST_IMAGE_PRODUCT,
    shopify: lastImageShopify(detached),
    config: RETAINED_CONFIG(true),
    log: { info() {}, warn() {}, error() {} },
  });

  assert.equal(result.outcome, SYNC_OUTCOME.NO_IMAGES);
  assert.deepEqual(detached, [], 'nothing came off on an unconfirmed empty list');
});

test('a corroborated empty image list removes the last image', async () => {
  const detached = [];
  const result = await syncUnleashedProduct({
    unleashedProduct: LAST_IMAGE_PRODUCT,
    shopify: lastImageShopify(detached),
    config: RETAINED_CONFIG(true),
    log: { info() {}, warn() {}, error() {} },
    emptyImagesConfirmed: true,
  });

  assert.deepEqual(detached, [RETAINED_OLD]);
  assert.equal(result.outcome, SYNC_OUTCOME.SYNCED);
  assert.deepEqual(result.retained, []);
});

test('a corroborated empty image list still respects DELETE_REMOVED_MEDIA', async () => {
  // Confirmation says the empty list is real. It does not say removal is on.
  const detached = [];
  const result = await syncUnleashedProduct({
    unleashedProduct: LAST_IMAGE_PRODUCT,
    shopify: lastImageShopify(detached),
    config: RETAINED_CONFIG(false),
    log: { info() {}, warn() {}, error() {} },
    emptyImagesConfirmed: true,
  });

  assert.deepEqual(detached, [], 'removal is off');
  assert.equal(result.outcome, SYNC_OUTCOME.RETAINED, 'and now it says so');
  assert.deepEqual(result.retained, [RETAINED_OLD]);
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

// --- content identity: the same picture under two different filenames --------
// Taken from the live duplicate that prompted this. Unleashed served the photo
// as a GUID; someone had already uploaded the identical file to Shopify by hand
// as "9KDP663 & 9KDP663-1_Comparison.png". Unleashed's API never exposes that
// name, so only the bytes could connect the two.

const COMPARISON_BYTES = 866082;
const COMPARISON_THUMBHASH = 'KhgODwL42ah3h4h2iHh3eId3WANFRXAD';
const COMPARISON_UNLEASHED =
  'https://unlappcdn.unleashedsoftware.com/037a/9c5255af-e6c0-4627-80a4-869e3e81c78b/9c5255af-e6c0-4627-80a4-869e3e81c78b.png';

const mediaNode = ({ id, filename, bytes, width = 1080, height = 1080, thumbhash = null }) => ({
  id,
  status: MEDIA_STATUS.READY,
  mimeType: 'image/png',
  originalSource: { fileSize: bytes },
  image: {
    url: `https://cdn.shopify.com/s/files/1/x/files/${filename}?v=1`,
    width,
    height,
    thumbhash,
  },
});

const HAND_UPLOADED = mediaNode({
  id: 'gid://shopify/MediaImage/hand',
  filename: '9KDP663_9KDP663-1_Comparison.png',
  bytes: COMPARISON_BYTES,
  thumbhash: COMPARISON_THUMBHASH,
});

const pngHeader = (width, height) => {
  const buffer = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
};

const jpegHeader = (width, height) => {
  const buffer = Buffer.alloc(48);
  // SOI, then an APP0 segment the walk must step over to reach the frame header.
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).copy(buffer, 0);
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]).copy(buffer, 20);
  buffer.writeUInt16BE(height, 25);
  buffer.writeUInt16BE(width, 27);
  return buffer;
};

test('image dimensions are read from a PNG header alone', () => {
  assert.deepEqual(readImageSize(pngHeader(1080, 1350)), { width: 1080, height: 1350 });
});

test('image dimensions are read from a JPEG behind a leading segment', () => {
  assert.deepEqual(readImageSize(jpegHeader(1500, 1094)), { width: 1500, height: 1094 });
});

test('unrecognisable bytes yield no size rather than a wrong one', () => {
  assert.equal(readImageSize(Buffer.alloc(32)), null);
  assert.equal(readImageSize(Buffer.alloc(4)), null);
});

// --- a frame header past the first probe -------------------------------------
//
// The 9KDR251SIZE* eternity ring photographs carry an ICC profile that puts the
// JPEG frame header beyond 16 KB. The 4 KB probe read no dimensions, so the
// fingerprint came back null, adoption fell through, and each sibling code
// uploaded its own copy of one photograph.

/** A JPEG whose frame header sits behind an APP2 block of `padding` bytes. */
const jpegBehindLargeSegment = (width, height, padding) => {
  const app2 = Buffer.alloc(2 + padding);
  app2[0] = 0xff;
  app2[1] = 0xe2;
  app2.writeUInt16BE(padding, 2);

  const sof = Buffer.alloc(2 + 11);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(11, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);

  return Buffer.concat([Buffer.from([0xff, 0xd8]), app2, sof, Buffer.from([0xff, 0xd9])]);
};

/** Serves ranged reads of `file`, counting requests. */
const rangeServer = (file) => {
  const ranges = [];
  const fetchImpl = async (_url, options) => {
    const end = Number(/bytes=0-(\d+)/.exec(options.headers.Range)[1]);
    const slice = file.subarray(0, Math.min(end + 1, file.length));
    ranges.push(end + 1);
    return {
      ok: true,
      status: 206,
      headers: {
        get: (name) =>
          name.toLowerCase() === 'content-range'
            ? `bytes 0-${slice.length - 1}/${file.length}`
            : null,
      },
      arrayBuffer: async () => slice,
    };
  };
  return { fetchImpl, ranges };
};

test('a JPEG frame header past the first probe is still fingerprinted', async () => {
  const file = jpegBehindLargeSegment(1500, 1500, 20000);
  const { fetchImpl, ranges } = rangeServer(file);

  const fingerprint = await fetchImageFingerprint('https://unl/ring.jpg', { fetchImpl });

  assert.deepEqual(fingerprint, { bytes: file.length, width: 1500, height: 1500 });
  assert.equal(ranges.length, 2, 'should escalate to a second, larger probe');
  assert.ok(ranges[1] > ranges[0]);
});

test('an image readable from the first probe costs exactly one request', async () => {
  const { fetchImpl, ranges } = rangeServer(pngHeader(1080, 1350));

  const fingerprint = await fetchImageFingerprint('https://unl/pendant.png', { fetchImpl });

  assert.equal(fingerprint.width, 1080);
  assert.equal(ranges.length, 1, 'the common case must not pay for a second request');
});

test('an image whose dimensions are unreadable at any size yields no fingerprint', async () => {
  const { fetchImpl } = rangeServer(Buffer.alloc(50_000, 0x7f));
  assert.equal(await fetchImageFingerprint('https://unl/junk.bin', { fetchImpl }), null);
});

test('the total file size comes off the Content-Range of a ranged reply', () => {
  const response = {
    status: 206,
    headers: { get: (name) => (name === 'content-range' ? 'bytes 0-4095/866082' : null) },
  };
  assert.equal(totalBytesOf(response, Buffer.alloc(4096)), COMPARISON_BYTES);
});

test('a CDN that ignores the range still yields a size', () => {
  const response = { status: 200, headers: { get: () => null } };
  assert.equal(totalBytesOf(response, Buffer.alloc(1234)), 1234);
});

test('content matching needs bytes AND both dimensions to agree', () => {
  const base = { bytes: COMPARISON_BYTES, width: 1080, height: 1080 };
  assert.equal(isSameContent(base, { ...base }), true);
  assert.equal(isSameContent(base, { ...base, bytes: COMPARISON_BYTES + 1 }), false);
  assert.equal(isSameContent(base, { ...base, width: 1254 }), false);
  assert.equal(isSameContent(base, { ...base, height: 1350 }), false);
});

test('an unmeasurable image never matches anything', () => {
  const base = { bytes: COMPARISON_BYTES, width: 1080, height: 1080 };
  assert.equal(isSameContent(base, null), false);
  assert.equal(isSameContent(null, base), false);
  assert.equal(shopifyFingerprint({ id: 'x', image: { url: 'a.png' } }), null, 'no size, no fingerprint');
  assert.equal(shopifyFingerprint({ originalSource: { fileSize: 10 } }), null, 'no dimensions');
});

test('a hand-uploaded copy is ADOPTED by content, not duplicated', () => {
  const plan = planMediaChanges({
    desired: [{ url: COMPARISON_UNLEASHED, isDefault: false }],
    liveMedia: [HAND_UPLOADED],
    state: parseState(null),
    productCode: '9KDP663-1',
    fingerprints: new Map([
      [imageKey(COMPARISON_UNLEASHED), { bytes: COMPARISON_BYTES, width: 1080, height: 1080 }],
    ]),
  });

  assert.equal(plan.toUpload.length, 0, 'the picture is already on the page');
  assert.equal(plan.resolved.length, 1);
  assert.equal(plan.resolved[0].origin, MEDIA_ORIGIN.ADOPTED_BY_CONTENT);
  assert.equal(plan.resolved[0].mediaId, HAND_UPLOADED.id);
  assert.equal(plan.toDetach.length, 0);
});

test('without a fingerprint the filename mismatch still uploads — the old bug, reproduced', () => {
  const plan = planMediaChanges({
    desired: [{ url: COMPARISON_UNLEASHED, isDefault: false }],
    liveMedia: [HAND_UPLOADED],
    state: parseState(null),
    productCode: '9KDP663-1',
  });
  assert.equal(plan.toUpload.length, 1, 'filenames alone cannot connect a GUID to a human name');
});

test('a different picture of the same size is NOT adopted', () => {
  // Whole photoshoots in this store share dimensions; only the bytes separate them.
  const plan = planMediaChanges({
    desired: [{ url: COMPARISON_UNLEASHED, isDefault: false }],
    liveMedia: [
      mediaNode({
        id: 'gid://shopify/MediaImage/other',
        filename: 'a-different-shot.png',
        bytes: COMPARISON_BYTES + 4096,
      }),
    ],
    state: parseState(null),
    productCode: '9KDP663-1',
    fingerprints: new Map([
      [imageKey(COMPARISON_UNLEASHED), { bytes: COMPARISON_BYTES, width: 1080, height: 1080 }],
    ]),
  });
  assert.equal(plan.toUpload.length, 1);
  assert.equal(plan.resolved.length, 0);
});

// Christina, 2026-08-05, on 9KBELY04055CM: "this is an example of product
// variants that have the same product image. We want to ensure that if the
// products have the same hash then they do not show twice."
//
// Five Unleashed codes for one belcher chain, each holding the identical
// 127626-byte file under its own GUID. Name matching saw five different images
// and every code uploaded its own, filling the whole five-image page with one
// picture.

const BELCHER_BYTES = 127626;
const BELCHER_CODES = [
  '9KBELY04019CM',
  '9KBELY04042CM',
  '9KBELY04045CM',
  '9KBELY04050CM',
  '9KBELY04055CM',
];
const belcherUrl = (code) => `https://unlappcdn.unleashedsoftware.com/037a/guid-for-${code}.png`;
const belcherFingerprint = (code) =>
  new Map([[imageKey(belcherUrl(code)), { bytes: BELCHER_BYTES, width: 1080, height: 1080 }]]);

const FIRST_BELCHER_MEDIA = mediaNode({
  id: 'gid://shopify/MediaImage/belcher',
  filename: 'guid-for-9KBELY04019CM.png',
  bytes: BELCHER_BYTES,
});
const FIRST_BELCHER_STATE = {
  version: STATE_VERSION,
  managed: [
    {
      url: belcherUrl(BELCHER_CODES[0]),
      mediaId: FIRST_BELCHER_MEDIA.id,
      origin: MEDIA_ORIGIN.SYNCED,
      productCode: BELCHER_CODES[0],
    },
  ],
};

test('a sibling variant reuses the photo already on the page instead of adding its own', () => {
  const plan = planMediaChanges({
    desired: [{ url: belcherUrl('9KBELY04055CM'), isDefault: true }],
    liveMedia: [FIRST_BELCHER_MEDIA],
    state: FIRST_BELCHER_STATE,
    productCode: '9KBELY04055CM',
    fingerprints: belcherFingerprint('9KBELY04055CM'),
  });

  assert.equal(plan.toUpload.length, 0, 'the picture is already on the page');
  assert.equal(plan.resolved[0].mediaId, FIRST_BELCHER_MEDIA.id);
  assert.equal(plan.resolved[0].origin, MEDIA_ORIGIN.ADOPTED_BY_CONTENT);
  assert.equal(plan.toDetach.length, 0, "the owning sibling's media is never taken away");
});

test('all five belcher variants land on one media item, not five', () => {
  const mediaIds = new Set();
  for (const code of BELCHER_CODES.slice(1)) {
    const plan = planMediaChanges({
      desired: [{ url: belcherUrl(code), isDefault: true }],
      liveMedia: [FIRST_BELCHER_MEDIA],
      state: FIRST_BELCHER_STATE,
      productCode: code,
      fingerprints: belcherFingerprint(code),
    });
    assert.equal(plan.toUpload.length, 0, `${code} must not add a sixth copy`);
    mediaIds.add(plan.resolved[0].mediaId);
  }
  assert.deepEqual([...mediaIds], [FIRST_BELCHER_MEDIA.id]);
});

test('a variant that drops its image cannot detach a photo a sibling still uses', () => {
  // The hazard created by sharing one media item across codes: without the
  // guard, -55CM dropping its image would pull the picture off the page for the
  // four other variants still pointing at it.
  const shared = {
    version: STATE_VERSION,
    managed: [
      ...FIRST_BELCHER_STATE.managed,
      {
        url: belcherUrl('9KBELY04055CM'),
        mediaId: FIRST_BELCHER_MEDIA.id,
        origin: MEDIA_ORIGIN.ADOPTED_BY_CONTENT,
        productCode: '9KBELY04055CM',
      },
    ],
  };

  const plan = planMediaChanges({
    desired: [{ url: 'https://unl/a-completely-different-photo.png', isDefault: true }],
    liveMedia: [FIRST_BELCHER_MEDIA],
    state: shared,
    productCode: '9KBELY04055CM',
  });

  assert.equal(plan.toDetach.length, 0, 'shared media must survive one code losing interest');
  assert.equal(plan.toUpload.length, 1);
});

test('a variant still detaches media no sibling is using', () => {
  const plan = planMediaChanges({
    desired: [{ url: 'https://unl/a-completely-different-photo.png', isDefault: true }],
    liveMedia: [FIRST_BELCHER_MEDIA],
    state: FIRST_BELCHER_STATE,
    productCode: BELCHER_CODES[0],
  });
  assert.equal(plan.toDetach.length, 1, 'sole owner, so removal is still on the table');
});

test('end to end: the duplicate upload is avoided and the adoption is persisted', async () => {
  let saved = null;
  const shopify = {
    findProductsBySku: async () => ({
      products: [{ id: 'gid://shopify/Product/8597492629657', title: 'Diamond Cross Pendant' }],
      variantIds: [],
    }),
    getProduct: async () => ({
      id: 'gid://shopify/Product/8597492629657',
      title: 'Diamond Cross Pendant',
      media: [HAND_UPLOADED],
      stateMetafield: null,
    }),
    appendImage: async () => assert.fail('must not upload a picture already on the page'),
    detachMedia: async () => assert.fail('nothing should be removed'),
    reorderMedia: async () => null,
    saveState: async ({ state }) => {
      saved = state;
      return [];
    },
  };

  const result = await syncUnleashedProduct({
    unleashedProduct: {
      ProductCode: '9KDP663-1',
      Guid: 'g',
      Images: [{ Url: COMPARISON_UNLEASHED, IsDefault: true }],
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
    fetchImpl: async () => ({
      ok: true,
      status: 206,
      headers: { get: (name) => (name === 'content-range' ? `bytes 0-4095/${COMPARISON_BYTES}` : null) },
      arrayBuffer: async () => pngHeader(1080, 1080),
    }),
  });

  assert.equal(result.added.length, 0, 'no duplicate uploaded');
  assert.deepEqual(result.adoptedByContent, [HAND_UPLOADED.id]);
  assert.deepEqual(result.adopted, [HAND_UPLOADED.id]);
  assert.ok(
    result.notes.some((note) => note.includes('different filename')),
    'the adoption must be explained in the report',
  );
  assert.equal(saved?.managed?.[0]?.mediaId, HAND_UPLOADED.id);
  assert.equal(
    saved?.managed?.[0]?.origin,
    MEDIA_ORIGIN.ADOPTED_BY_CONTENT,
    'so later runs skip the fingerprint fetch entirely',
  );
});

test('a fingerprint that cannot be taken falls back to uploading', async () => {
  let uploaded = 0;
  const shopify = {
    findProductsBySku: async () => ({
      products: [{ id: 'gid://shopify/Product/1', title: 'P' }],
      variantIds: [],
    }),
    getProduct: async () => ({
      id: 'gid://shopify/Product/1',
      title: 'P',
      media: [HAND_UPLOADED],
      stateMetafield: null,
    }),
    appendImage: async () => {
      uploaded += 1;
      return { media: { id: 'gid://shopify/MediaImage/new' }, allMedia: [] };
    },
    detachMedia: async () => [],
    reorderMedia: async () => null,
    saveState: async () => [],
  };

  const result = await syncUnleashedProduct({
    unleashedProduct: {
      ProductCode: 'X',
      Guid: 'g',
      Images: [{ Url: COMPARISON_UNLEASHED, IsDefault: true }],
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
    fetchImpl: async () => {
      throw new Error('CDN unreachable');
    },
  });

  assert.equal(uploaded, 1, 'an unreachable CDN must not cost the product its image');
  assert.equal(result.outcome, SYNC_OUTCOME.SYNCED);
});

// --- duplicates already on the page ------------------------------------------

const SYNC_OWNED = mediaNode({
  id: 'gid://shopify/MediaImage/ours',
  filename: '9c5255af-e6c0-4627-80a4-869e3e81c78b.png',
  bytes: COMPARISON_BYTES,
  thumbhash: COMPARISON_THUMBHASH,
});

const STATE_OWNING_OURS = {
  version: STATE_VERSION,
  managed: [
    {
      url: COMPARISON_UNLEASHED,
      mediaId: SYNC_OWNED.id,
      origin: MEDIA_ORIGIN.SYNCED,
      productCode: '9KDP663-1',
    },
  ],
};

test('two copies of one picture are found by thumbhash, size and dimensions', () => {
  const groups = findDuplicateGroups({
    media: [HAND_UPLOADED, SYNC_OWNED],
    state: STATE_OWNING_OURS,
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, DUPLICATE_KIND.MIXED);
  assert.equal(groups[0].copies.length, 2);
});

test('distinct pictures are not grouped', () => {
  const groups = findDuplicateGroups({
    media: [
      HAND_UPLOADED,
      mediaNode({ id: 'gid://shopify/MediaImage/b', filename: 'b.png', bytes: 12345 }),
    ],
    state: parseState(null),
  });
  assert.equal(groups.length, 0);
});

test('cleanup drops the copy the sync added and keeps the one already there', () => {
  const groups = findDuplicateGroups({
    media: [HAND_UPLOADED, SYNC_OWNED],
    state: STATE_OWNING_OURS,
  });
  const removals = planDuplicateCleanup(groups);
  assert.equal(removals.length, 1);
  assert.equal(removals[0].mediaId, SYNC_OWNED.id, 'ours goes');
  assert.equal(removals[0].keptMediaId, HAND_UPLOADED.id, 'theirs stays, and is re-adopted next run');
});

test('duplicates nobody owns are reported but never touched', () => {
  const groups = findDuplicateGroups({
    media: [
      HAND_UPLOADED,
      mediaNode({
        id: 'gid://shopify/MediaImage/hand2',
        filename: 'Comparison_copy.png',
        bytes: COMPARISON_BYTES,
        thumbhash: COMPARISON_THUMBHASH,
      }),
    ],
    state: parseState(null),
  });
  assert.equal(groups[0].kind, DUPLICATE_KIND.ALL_UNMANAGED);
  assert.equal(planDuplicateCleanup(groups).length, 0, 'this sync did not create these');
});

test('sibling-owned duplicates collapse to one copy, the rest detached', () => {
  // The 9KBELY040* shape: one photo, five codes, five copies of it on the page.
  const copies = BELCHER_CODES.map((code, index) =>
    mediaNode({
      id: `gid://shopify/MediaImage/belcher${index}`,
      filename: `guid-for-${code}.png`,
      bytes: BELCHER_BYTES,
      thumbhash: 'PggCBwD4F9iId4d8g3uIZ4h4etCHB30I',
    }),
  );
  const groups = findDuplicateGroups({
    media: copies,
    state: {
      version: STATE_VERSION,
      managed: BELCHER_CODES.map((code, index) => ({
        url: belcherUrl(code),
        mediaId: copies[index].id,
        origin: MEDIA_ORIGIN.SYNCED,
        productCode: code,
      })),
    },
  });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, DUPLICATE_KIND.ALL_MANAGED);

  const removals = planDuplicateCleanup(groups);
  assert.equal(removals.length, 4, 'five copies of one picture become one');
  assert.ok(
    removals.every((removal) => removal.keptMediaId === copies[0].id),
    'everything that goes points at the copy that stays',
  );
  assert.equal(
    removals.some((removal) => removal.mediaId === copies[0].id),
    false,
    'the survivor is never itself detached',
  );
});

test('a content key separates same-size pictures by their thumbhash', () => {
  const a = { bytes: COMPARISON_BYTES, width: 1080, height: 1080, thumbhash: COMPARISON_THUMBHASH };
  const b = { ...a, thumbhash: 'PggCBwD4F9iId4d8g3uIZ4h4etCHB30I' };
  assert.notEqual(contentKey(a), contentKey(b));
  assert.equal(contentKey(a), contentKey({ ...a }));
});

// --- duplicate surveillance: catching a second writer without being asked ----

test('only duplicates involving a copy we do not own count as foreign', () => {
  // An all-managed group is self-inflicted: two byte-identical Unleashed images
  // on one product both upload, every run, forever. Alerting on that is how a
  // daily report gets filtered to trash.
  assert.equal(isForeignDuplicate({ kind: DUPLICATE_KIND.MIXED }), true);
  assert.equal(isForeignDuplicate({ kind: DUPLICATE_KIND.ALL_UNMANAGED }), true);
  assert.equal(isForeignDuplicate({ kind: DUPLICATE_KIND.ALL_MANAGED }), false);
});

test('an empty duplicate summary is all zeroes, never undefined', () => {
  // The daily row must be able to print `0` — an absent row is indistinguishable
  // from "this check was never deployed".
  const summary = summariseDuplicateGroups([]);
  assert.deepEqual(
    { ...summary, byKind: undefined },
    {
      productsAffected: 0,
      groups: 0,
      wastedSlots: 0,
      foreignGroups: 0,
      repairable: 0,
      byKind: undefined,
    },
  );
});

test('duplicate totals count wasted slots, not copies', () => {
  const groups = findDuplicateGroups({ media: [HAND_UPLOADED, SYNC_OWNED], state: STATE_OWNING_OURS });
  const summary = summariseDuplicateGroups([
    { groups, removals: planDuplicateCleanup(groups) },
  ]);
  assert.equal(summary.groups, 1);
  assert.equal(summary.wastedSlots, 1, 'two copies of one picture waste one slot');
  assert.equal(summary.foreignGroups, 1);
  assert.equal(summary.repairable, 1);
});

const duplicateShopifyStub = (media, stateValue) => ({
  findProductsBySku: async () => ({
    products: [{ id: 'gid://shopify/Product/1', title: 'Dup Product' }],
    variantIds: [],
  }),
  getProduct: async () => ({
    id: 'gid://shopify/Product/1',
    title: 'Dup Product',
    media,
    stateMetafield: stateValue ? { value: JSON.stringify(stateValue) } : null,
  }),
  appendImage: async () => ({ media: { id: 'gid://shopify/MediaImage/new' }, allMedia: [] }),
  detachMedia: async () => assert.fail('a sync pass must never detach media'),
  reorderMedia: async () => null,
  saveState: async () => [],
});

const DUP_CONFIG = {
  maxSyncedImages: 5,
  maxMediaPerProduct: 5,
  deleteRemovedMedia: false,
  reorderMedia: true,
  dryRun: true,
};

test('a duplicate on the page is reported by the sync, and nothing is detached', async () => {
  const result = await syncUnleashedProduct({
    unleashedProduct: {
      ProductCode: '9KDP663-1',
      Guid: 'g',
      Images: [{ Url: COMPARISON_UNLEASHED, IsDefault: true }],
    },
    shopify: duplicateShopifyStub([HAND_UPLOADED, SYNC_OWNED], STATE_OWNING_OURS),
    config: DUP_CONFIG,
    log: { info() {}, warn() {}, error() {} },
  });

  assert.equal(result.duplicates?.groups.length, 1);
  assert.equal(result.duplicates.productId, 'gid://shopify/Product/1');
  assert.equal(result.duplicates.removals.length, 1, 'counted as repairable, but not repaired');
  assert.ok(result.notes.some((note) => note.includes('more than once')));
});

test('a clean product reports no duplicates at all', async () => {
  const result = await syncUnleashedProduct({
    unleashedProduct: {
      ProductCode: 'CLEAN',
      Guid: 'g',
      Images: [{ Url: COMPARISON_UNLEASHED, IsDefault: true }],
    },
    shopify: duplicateShopifyStub([SYNC_OWNED], STATE_OWNING_OURS),
    config: DUP_CONFIG,
    log: { info() {}, warn() {}, error() {} },
  });
  assert.equal(result.duplicates, null);
});

/** Minimal Unleashed stub: one page of the given products. */
const unleashedStub = (items) => ({
  async *iterateProducts() {
    yield { items, pageNumber: 1, totalPages: 1 };
  },
});

test('sibling codes on one Shopify product report their duplicate once, not twice', async () => {
  // 18K101-3 and -4 are sizes of one ring and resolve to the same Shopify
  // product. Both see the same duplicate group on the same page.
  const report = await reconcile({
    unleashed: unleashedStub([
      { ProductCode: '18K101-3', Guid: 'a', Images: [{ Url: COMPARISON_UNLEASHED, IsDefault: true }] },
      { ProductCode: '18K101-4', Guid: 'b', Images: [{ Url: COMPARISON_UNLEASHED, IsDefault: true }] },
    ]),
    shopify: duplicateShopifyStub([HAND_UPLOADED, SYNC_OWNED], STATE_OWNING_OURS),
    config: DUP_CONFIG,
    log: { info() {}, warn() {}, error() {} },
  });

  assert.equal(report.duplicates.productsAffected, 1, 'one Shopify product, one finding');
  assert.equal(report.duplicates.groups, 1);
  assert.equal(report.duplicates.wastedSlots, 1, 'must not be double counted');
});

test('a duplicate on an UNCHANGED product still reaches the report', async () => {
  // `details` drops unchanged results as noise, and a duplicate almost always
  // sits on a product whose images are otherwise already correct — so riding on
  // `details` would have thrown away most findings.
  const report = await reconcile({
    unleashed: unleashedStub([
      { ProductCode: '9KDP663-1', Guid: 'a', Images: [{ Url: COMPARISON_UNLEASHED, IsDefault: true }] },
    ]),
    shopify: duplicateShopifyStub([HAND_UPLOADED, SYNC_OWNED], STATE_OWNING_OURS),
    config: { ...DUP_CONFIG, dryRun: false },
    log: { info() {}, warn() {}, error() {} },
  });

  assert.equal(report.details.length, 0, 'the product itself is unremarkable');
  assert.equal(report.duplicates.groups, 1, 'but its duplicate is still reported');
});

test('a run that saw plenty of images acts on the products that have none', async () => {
  // The corroboration: five other products came back carrying images, so the
  // feed is returning image data and LAST-1 is empty because somebody emptied it.
  const detached = [];
  const withImages = Array.from({ length: EMPTY_IMAGES_CORROBORATION_MIN }, (_, i) => ({
    ProductCode: `HAS-${i}`,
    Guid: `g${i}`,
    Images: [{ Url: 'https://unl/only-photo.png', IsDefault: true }],
  }));

  const report = await reconcile({
    unleashed: unleashedStub([...withImages, LAST_IMAGE_PRODUCT]),
    shopify: lastImageShopify(detached),
    config: RETAINED_CONFIG(true),
    log: { info() {}, warn() {}, error() {} },
  });

  assert.deepEqual(detached, [RETAINED_OLD], 'the last image came off');
  assert.equal(report.scanned, EMPTY_IMAGES_CORROBORATION_MIN + 1);
  assert.equal(report.withImages, EMPTY_IMAGES_CORROBORATION_MIN, 'counts images, not results');
});

test('a quiet window falls back to a catalogue probe rather than waiting forever', async () => {
  // A ten-minute window routinely holds nothing with photos, so the run's own
  // evidence is usually absent. Without this fallback a deleted last image would
  // sit on the site until the product aged out of the window and stopped being
  // visited at all — never removed, and never reported either.
  const detached = [];
  let probes = 0;
  const unleashed = {
    async *iterateProducts({ sinceIso } = {}) {
      if (sinceIso) {
        yield { items: [LAST_IMAGE_PRODUCT], pageNumber: 1, totalPages: 1 };
        return;
      }
      // The probe: unfiltered, and the catalogue plainly still has photographs.
      probes += 1;
      yield {
        items: Array.from({ length: EMPTY_IMAGES_CORROBORATION_MIN }, (_, i) => ({
          ProductCode: `ANY-${i}`,
          Images: [{ Url: 'https://unl/x.png', IsDefault: true }],
        })),
        pageNumber: 1,
        totalPages: 1,
      };
    },
  };

  await reconcile({
    sinceIso: '2026-08-21T00:00:00',
    unleashed,
    shopify: lastImageShopify(detached),
    config: RETAINED_CONFIG(true),
    log: { info() {}, warn() {}, error() {} },
  });

  assert.equal(probes, 1, 'exactly one probe, and only because the window was quiet');
  assert.deepEqual(detached, [RETAINED_OLD], 'the last image came off on the probe’s evidence');
});

test('a catalogue-wide pass caps its image-less lookups and says what it dropped', async () => {
  // `--all` walks thousands of products, most of them without photographs. Two
  // Shopify calls each would spend the whole function timeout confirming that
  // products with no pictures still have no pictures.
  const looked = [];
  const empties = Array.from({ length: EMPTY_IMAGES_MAX_PER_RUN + 25 }, (_, i) => ({
    ProductCode: `EMPTY-${i}`,
    Guid: `e${i}`,
    Images: [],
  }));
  const withImages = Array.from({ length: EMPTY_IMAGES_CORROBORATION_MIN }, (_, i) => ({
    ProductCode: `HAS-${i}`,
    Guid: `h${i}`,
    Images: [{ Url: 'https://unl/only-photo.png', IsDefault: true }],
  }));

  const warnings = [];
  await reconcile({
    unleashed: unleashedStub([...withImages, ...empties]),
    shopify: {
      ...lastImageShopify([]),
      findProductsBySku: async () => {
        looked.push(1);
        return { products: [], variantIds: [] };
      },
    },
    config: RETAINED_CONFIG(true),
    log: { info() {}, warn: (m) => warnings.push(m), error() {} },
  });

  assert.equal(
    looked.length,
    EMPTY_IMAGES_CORROBORATION_MIN + EMPTY_IMAGES_MAX_PER_RUN,
    'the products with images, plus the cap — not all 225 empties',
  );
  assert.ok(
    warnings.some((w) => w.includes('left for the next one')),
    'a run that stopped short must never look like a clean sweep',
  );
});

test('a catalogue probe that fails removes nothing', async () => {
  // An unreachable feed is not evidence that a product has no images.
  const detached = [];
  const unleashed = {
    async *iterateProducts({ sinceIso } = {}) {
      if (sinceIso) {
        yield { items: [LAST_IMAGE_PRODUCT], pageNumber: 1, totalPages: 1 };
        return;
      }
      throw new Error('Unleashed 503');
    },
  };

  const warnings = [];
  await reconcile({
    sinceIso: '2026-08-21T00:00:00',
    unleashed,
    shopify: lastImageShopify(detached),
    config: RETAINED_CONFIG(true),
    log: { info() {}, warn: (m) => warnings.push(m), error() {} },
  });

  assert.deepEqual(detached, [], 'a failed probe must never be read as confirmation');
  assert.ok(warnings.some((w) => w.includes('probe failed')));
});

test('a run with too little evidence leaves image-less products alone', async () => {
  // Indistinguishable from Unleashed returning products with their images
  // stripped. Costs nothing to wait: the next run is ten minutes away and the
  // window overlaps.
  const detached = [];
  const warnings = [];
  const report = await reconcile({
    unleashed: unleashedStub([LAST_IMAGE_PRODUCT]),
    shopify: lastImageShopify(detached),
    config: RETAINED_CONFIG(true),
    log: { info() {}, warn: (m) => warnings.push(m), error() {} },
  });

  assert.deepEqual(detached, [], 'nothing was removed on one product’s word alone');
  assert.equal(report.details.length, 0);
  assert.ok(
    warnings.some((w) => w.includes('not enough to rule out')),
    'and the run says why it held back',
  );
});

test('the whole-store sweep stops on its own budget rather than being killed', async () => {
  let pages = 0;
  const shopify = {
    async *iterateProductsWithMedia() {
      for (let i = 0; i < 5; i += 1) {
        pages += 1;
        yield { products: [], pageNumber: i + 1 };
      }
    },
    detachMedia: async () => assert.fail('the sweep is read-only'),
  };

  const audit = await auditDuplicates({ shopify, log: { info() {}, warn() {}, error() {} }, budgetMs: 0 });
  assert.equal(pages, 1, 'stops after the first page once the budget is spent');
  assert.ok(audit.truncated, 'and says so, so the count reads as a lower bound');
});

test('a page that throws mid-sweep keeps the findings gathered so far', async () => {
  const shopify = {
    async *iterateProductsWithMedia() {
      yield { products: [], pageNumber: 1 };
      throw new Error('Shopify still throttled after 4 attempts');
    },
    detachMedia: async () => assert.fail('the sweep is read-only'),
  };

  const audit = await auditDuplicates({ shopify, log: { info() {}, warn() {}, error() {} } });
  assert.ok(audit.truncated.includes('throttled'));
  assert.equal(audit.scanned, 0, 'partial result, not a thrown error');
});

test('the weekly sweep is a worklist: WARN while anything is duplicated', () => {
  const groups = findDuplicateGroups({ media: [HAND_UPLOADED, SYNC_OWNED], state: STATE_OWNING_OURS });
  const audit = {
    scanned: 3375,
    products: [{ productId: 'gid://shopify/Product/1', title: 'P', groups, removals: planDuplicateCleanup(groups) }],
    ...summariseDuplicateGroups([{ groups, removals: planDuplicateCleanup(groups) }]),
  };

  const warned = buildDuplicateSummary({ audit });
  assert.equal(warned.health, SYNC_HEALTH.WARN);
  assert.ok(warned.subject.includes('1 duplicated picture'));

  const clean = buildDuplicateSummary({ audit: { scanned: 3375, products: [], ...summariseDuplicateGroups([]) } });
  assert.equal(clean.health, SYNC_HEALTH.OK);
  assert.ok(clean.reasons.some((r) => r.includes('No duplicated media')));
});

test('a sweep that ran out of budget reports itself as a lower bound', () => {
  const summary = buildDuplicateSummary({
    audit: { scanned: 900, products: [], truncated: 'stopped after 900 product(s): budget ran out', ...summariseDuplicateGroups([]) },
  });
  assert.ok(summary.reasons.some((r) => r.includes('lower bound')));
});

test('daily and weekly duplicate CSVs are the same format', () => {
  // The daily result is shaped like one element of the weekly sweep's `products`,
  // so a single CSV builder serves both and the two can be diffed directly.
  const groups = findDuplicateGroups({ media: [HAND_UPLOADED, SYNC_OWNED], state: STATE_OWNING_OURS });
  const product = { productId: 'gid://shopify/Product/1', title: 'P', groups, removals: planDuplicateCleanup(groups) };

  const weekly = buildDuplicateCsv({ products: [product] });
  const daily = buildDuplicateCsv({ products: [product] });
  assert.equal(weekly, daily);
  assert.ok(weekly.split('\n')[0].startsWith('kind,shopify_product_id'));
  assert.equal(weekly.split('\n').length, 3, 'header plus both copies of the picture');
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

const duplicateCounts = (over) => ({
  productsChecked: 40,
  productsAffected: 0,
  groups: 0,
  foreignGroups: 0,
  wastedSlots: 0,
  products: [],
  ...over,
});

test('a clean day still prints a duplicate count of zero', () => {
  // A missing row is indistinguishable from "not deployed"; a visible 0 is
  // positive confirmation the check ran.
  const s = summaryOf({ unchanged: 60 }, { duplicates: duplicateCounts() });
  assert.equal(s.health, SYNC_HEALTH.OK);
  assert.equal(s.counts.duplicates, 0);
  assert.ok(s.text.includes('Duplicated pictures'));
});

test("a picture copied by something else warns, and says what to do", () => {
  const s = summaryOf(
    { unchanged: 60 },
    { duplicates: duplicateCounts({ productsAffected: 2, groups: 2, foreignGroups: 2, wastedSlots: 2 }) },
  );
  assert.equal(s.health, SYNC_HEALTH.WARN);
  assert.equal(s.counts.foreignDuplicates, 2);
  assert.ok(
    s.reasons.some((r) => r.includes('--duplicates')),
    'the report must carry the remedy, not just the count',
  );
  assert.ok(
    s.reasons.some((r) => r.includes('Syncio')),
    'and name the known cause so nobody has to rediscover it',
  );
});

test('duplicates this sync created itself do NOT move the verdict', () => {
  // Two byte-identical images on one Unleashed product both upload, on every run,
  // forever. Warning daily on a self-inflicted steady state is how a report earns
  // an inbox filter.
  const s = summaryOf(
    { unchanged: 60 },
    { duplicates: duplicateCounts({ productsAffected: 3, groups: 3, foreignGroups: 0, wastedSlots: 3 }) },
  );
  assert.equal(s.health, SYNC_HEALTH.OK, 'counted and listed, but not alarming');
  assert.equal(s.counts.duplicates, 3);
  assert.ok(s.reasons.some((r) => r.includes('do not indicate another writer')));
});

test('duplicates never downgrade a failure alert', () => {
  const s = summaryOf(
    { unchanged: 59, failed: 1 },
    { duplicates: duplicateCounts({ productsAffected: 1, groups: 1, foreignGroups: 1, wastedSlots: 1 }) },
  );
  assert.equal(s.health, SYNC_HEALTH.ALERT);
});

test('the daily duplicate count says it is a floor, not a store-wide total', () => {
  const s = summaryOf(
    { unchanged: 60 },
    { duplicates: duplicateCounts({ productsAffected: 1, groups: 1, foreignGroups: 1, wastedSlots: 1 }) },
  );
  assert.ok(
    s.reasons.some((r) => r.includes('not the') && r.includes('whole store')),
    'or the weekly sweep reporting a bigger number will look like a bug',
  );
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

test('a deleted image left on the page warns only when removal is meant to happen', () => {
  // Off is the documented steady state — say it, do not warn about it, or the
  // report earns an inbox filter. On means a write did not take, which is news.
  const off = summaryOf({ unchanged: 40, retained: 2 }, { removalEnabled: false });
  assert.equal(off.health, SYNC_HEALTH.OK);
  assert.equal(off.counts.retained, 2);
  assert.ok(off.text.includes('DELETE_REMOVED_MEDIA'), 'says why it is still there');

  const on = summaryOf({ unchanged: 40, retained: 2 }, { removalEnabled: true });
  assert.equal(on.health, SYNC_HEALTH.WARN);
  assert.ok(on.text.includes('did not take'), 'names the fault');
  assert.ok(on.text.includes('write_files'), 'names the usual cause');
});

test('a retained image never downgrades a real failure', () => {
  const s = summaryOf({ failed: 1, retained: 3 }, { removalEnabled: true });
  assert.equal(s.health, SYNC_HEALTH.ALERT);
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

// --- a healthy report is emailed weekly, a fault the day it happens ------------

// The timer fires at 22:00 UTC, which is 08:00 AEST on the following day.
const SUNDAY_2200_UTC = Date.UTC(2026, 9, 4, 22); // Monday 5 Oct, 08:00 AEST
const MONDAY_2200_UTC = Date.UTC(2026, 9, 5, 22); // Tuesday 6 Oct, 08:00 AEST

test('a healthy report is emailed on Monday morning AEST', () => {
  assert.equal(isDailyEmailDue(SYNC_HEALTH.OK, SUNDAY_2200_UTC), true);
});

test('a healthy report is not emailed on the other six days', () => {
  for (let day = 0; day < 6; day += 1) {
    const nowMs = MONDAY_2200_UTC + day * 86_400_000;
    assert.equal(isDailyEmailDue(SYNC_HEALTH.OK, nowMs), false, `day ${day} after Monday`);
  }
});

test('Monday is judged in AEST, not UTC', () => {
  // Monday 22:00 UTC is already Tuesday morning for the people reading it.
  assert.equal(new Date(MONDAY_2200_UTC).getUTCDay(), 1, 'a Monday in UTC');
  assert.equal(isDailyEmailDue(SYNC_HEALTH.OK, MONDAY_2200_UTC), false);
});

test('a warning or alert is emailed whatever the day', () => {
  for (let day = 0; day < 7; day += 1) {
    const nowMs = SUNDAY_2200_UTC + day * 86_400_000;
    assert.equal(isDailyEmailDue(SYNC_HEALTH.WARN, nowMs), true);
    assert.equal(isDailyEmailDue(SYNC_HEALTH.ALERT, nowMs), true);
  }
});

test('a report that is not due is still logged, and says why it was not sent', async () => {
  const logged = [];
  const log = { info: (line) => logged.push(line), warn: (line) => logged.push(line) };
  const delivery = await sendReport({
    // A key and a recipient, so only `emailDue` can be what stops the send.
    config: { email: { apiKey: 'unused', from: 'a@example.com', to: ['b@example.com'] } },
    summary: { health: SYNC_HEALTH.OK, subject: 'subject', text: 'body' },
    emailDue: false,
    log,
  });
  assert.deepEqual(delivery, { delivered: false, reason: REPORT_SKIP_REASON.OK_NOT_DUE });
  assert.equal(logged.length, 1, 'the summary still reaches the log');
  assert.ok(logged[0].includes('body'));
});

test('the weekly healthy email says the check still runs daily', () => {
  const weekly = buildDailySummary({
    report: { scanned: 100, withImages: 60, byOutcome: { unchanged: 60 }, details: [] },
    pendingWarnThreshold: 5,
    lookbackHours: 24,
    okEmailedWeekly: true,
  });
  assert.equal(weekly.health, SYNC_HEALTH.OK);
  assert.ok(weekly.text.includes('Monday mornings only'));

  const faulty = buildDailySummary({
    report: { scanned: 100, withImages: 60, byOutcome: { failed: 1 }, details: [] },
    pendingWarnThreshold: 5,
    lookbackHours: 24,
    okEmailedWeekly: true,
  });
  assert.ok(!faulty.text.includes('Monday mornings only'), 'an alert is not a weekly email');
});

test('Monday is the weekly report day, and the only one', () => {
  assert.equal(isWeeklyReportDay(SUNDAY_2200_UTC), true);
  for (let day = 1; day < 7; day += 1) {
    assert.equal(isWeeklyReportDay(SUNDAY_2200_UTC + day * 86_400_000), false);
  }
});

test('the report window reads in days once it is a whole number of them', () => {
  assert.equal(describeWindow(24), '24h');
  assert.equal(describeWindow(36), '36h');
  assert.equal(describeWindow(168), '7 days');
});

test('the Monday email is titled and footed with the week it covers', () => {
  const s = buildDailySummary({
    report: { scanned: 587, withImages: 517, byOutcome: { unchanged: 587 }, details: [] },
    pendingWarnThreshold: 5,
    lookbackHours: 168,
    okEmailedWeekly: true,
  });
  assert.ok(s.text.includes('Image sync — last 7 days'));
  assert.ok(s.text.includes('covering the last 7 days'));
  assert.ok(!s.text.includes('168h'));
});

test('a check that ran out of time says so, with the reason', () => {
  const s = summaryOf(
    { unchanged: 10 },
    { truncated: 'stopped after 10 product(s): the 420s time budget ran out' },
  );
  assert.ok(s.text.includes('did not finish — stopped after 10 product(s)'));
  assert.ok(s.text.includes('lower bound'));
  assert.ok(!s.text.includes('page cap'), 'not blamed on the page cap');
});

/** Unleashed products with images that no Shopify variant carries: two quick reads each. */
const unmatchedProducts = (n) =>
  Array.from({ length: n }, (_, i) => ({
    ProductCode: `U-${i}`,
    Guid: `u${i}`,
    Images: [{ Url: `https://unl/${i}.png`, IsDefault: true }],
  }));

/** Shopify stub that records how many lookups overlap. */
const overlapShopify = () => {
  const seen = { inFlight: 0, max: 0, calls: 0 };
  return {
    seen,
    async findProductsBySku() {
      seen.calls += 1;
      seen.inFlight += 1;
      seen.max = Math.max(seen.max, seen.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.inFlight -= 1;
      return { products: [] };
    },
  };
};

test('the live sync still checks one product at a time', async () => {
  const shopify = overlapShopify();
  const report = await reconcile({
    unleashed: unleashedStub(unmatchedProducts(6)),
    shopify,
    config: DUP_CONFIG,
    log: { info() {}, warn() {}, error() {} },
  });
  assert.equal(shopify.seen.max, 1);
  assert.equal(report.byOutcome.unmatched, 6);
});

test('the report checks several products at once, never more than asked', async () => {
  const shopify = overlapShopify();
  const report = await reconcile({
    unleashed: unleashedStub(unmatchedProducts(12)),
    shopify,
    config: DUP_CONFIG,
    concurrency: 4,
    log: { info() {}, warn() {}, error() {} },
  });
  assert.equal(shopify.seen.max, 4);
  assert.equal(shopify.seen.calls, 12, 'every product checked once');
  assert.equal(report.byOutcome.unmatched, 12, 'every result kept');
  assert.equal(report.truncated, false);
});

test('a limit still holds when products are checked concurrently', async () => {
  const shopify = overlapShopify();
  const report = await reconcile({
    unleashed: unleashedStub(unmatchedProducts(12)),
    shopify,
    config: DUP_CONFIG,
    concurrency: 4,
    limit: 5,
    log: { info() {}, warn() {}, error() {} },
  });
  assert.equal(shopify.seen.calls, 5);
  assert.equal(report.truncated, true);
});

test('a check out of time stops itself and says why, rather than being killed', async () => {
  const warnings = [];
  const shopify = overlapShopify();
  const report = await reconcile({
    unleashed: unleashedStub(unmatchedProducts(3)),
    shopify,
    config: DUP_CONFIG,
    budgetMs: 0,
    log: { info() {}, warn: (m) => warnings.push(m), error() {} },
  });
  assert.equal(shopify.seen.calls, 0);
  assert.equal(report.scanned, 0);
  assert.ok(report.truncated.includes('time budget ran out'));
  assert.ok(warnings.some((m) => m.includes('time budget')));
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

test('a deliberate single-page read is not reported as a truncated run', async () => {
  // The corroboration probe asks for one page on purpose. Warning there would put
  // "this run stops at page 1" in the log of every run that probes — which reads
  // as a sync that left work undone, and is not one.
  const { createUnleashedClient } = await import('../src/utils/unleashed.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      Pagination: { NumberOfPages: 33 },
      Items: [{ ProductCode: 'A', Images: [] }],
    }),
  });

  try {
    const drain = async (options) => {
      const warnings = [];
      const client = createUnleashedClient(
        { unleashed: { apiId: 'id', apiKey: 'key' } },
        { info() {}, warn: (m) => warnings.push(m), error() {} },
      );
      // Drained, not broken out of: `break` closes the generator at the yield,
      // and the truncation warning is emitted on the line after it.
      for await (const _page of client.iterateProducts(options)) {
      }
      return warnings;
    };

    assert.ok(
      (await drain({ maxPages: 1 })).some((w) => w.includes('stops at page 1')),
      'a reconcile that stopped short must still say so',
    );
    assert.deepEqual(
      await drain({ maxPages: 1, warnOnTruncation: false }),
      [],
      'but the probe must not',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
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

// --- Customer notes guard -------------------------------------------------
// Shapes from MB712 / price@searay.net.au, the customer Jian tested on.

const MINUTE = 60_000;
const T0 = Date.parse('2026-09-22T06:00:00Z');
const MB712_GUID = '9a6fca18-afcf-4f9e-816c-caa9f2d08dae';
const JIAN_NOTE = 'THIS IS A TEST. TESTING TO SEE IF THESE ORDER NOTES DISAPPEAR.';
const QUIET_LOG = { info() {}, warn() {}, error() {} };
const unleashedDate = (ms) => `/Date(${ms})/`;

function notesCustomer(overrides = {}) {
  return {
    Guid: MB712_GUID,
    CustomerCode: 'MB712',
    CustomerName: 'Mark Blencowe',
    Notes: JIAN_NOTE,
    PaymentTerm: 'C.O.D.',
    SellPriceTier: 'Exclusive',
    LastModifiedOn: unleashedDate(T0),
    Addresses: [
      { AddressType: 'Physical', StreetAddress: '135 Ironwood Street', Suburb: 'ASPLEY', Region: 'QLD', PostalCode: '4034', Guid: 'a1' },
    ],
    ...overrides,
  };
}

/** Enough of the Unleashed client for the guard, over an in-memory customer list. */
function fakeNotesUnleashed({ customers, orders = [], ignoreWrites = false }) {
  const byGuid = new Map(customers.map((customer) => [customer.Guid, { ...customer }]));
  const calls = { updates: [], orderLookups: [] };
  return {
    calls,
    byGuid,
    async *iterateCustomers({ sinceIso, customerCode } = {}) {
      const sinceMs = sinceIso ? Date.parse(`${sinceIso}Z`) : null;
      const items = [...byGuid.values()].filter(
        (customer) =>
          (sinceMs === null || parseUnleashedDate(customer.LastModifiedOn) >= sinceMs) &&
          (!customerCode || customer.CustomerCode.toLowerCase().startsWith(customerCode.toLowerCase())),
      );
      if (items.length) yield { items: items.map((item) => ({ ...item })), pageNumber: 1, totalPages: 1 };
    },
    async getCustomerByGuid(guid) {
      return { ...byGuid.get(guid) };
    },
    async updateCustomer(guid, body) {
      calls.updates.push({ guid, body });
      if (!ignoreWrites) byGuid.set(guid, { ...byGuid.get(guid), Notes: body.Notes });
    },
    async listShopifyOrdersForCustomer(customerCode, sinceIso) {
      calls.orderLookups.push({ customerCode, sinceIso });
      return orders.filter((order) => order.Customer.CustomerCode === customerCode);
    },
  };
}

const webOrder = (number, createdMs) => ({
  OrderNumber: number,
  CreatedBy: SHOPIFY_ORDER_CREATOR,
  CreatedOn: unleashedDate(createdMs),
  Customer: { CustomerCode: 'MB712' },
});

/** A snapshot as the previous whole pass, at `takenMs`, would have left it. */
function notesSnapshotAt(takenMs, entry = { code: 'MB712', notes: JIAN_NOTE, seenAt: new Date(takenMs).toISOString() }) {
  return { version: 1, takenAt: new Date(takenMs).toISOString(), customers: { [MB712_GUID]: entry }, pending: {} };
}

const runGuard = (unleashed, store, extra = {}) =>
  guardNotes({ unleashed, store, config: { dryRun: false }, log: QUIET_LOG, apply: true, persist: true, ...extra });

test('notes plan: new text is recorded, a blank with nothing on file is ignored', () => {
  assert.equal(planNotes({ Notes: 'Strictly COD' }, undefined), NOTES_ACTION.RECORD);
  assert.equal(planNotes({ Notes: '' }, undefined), NOTES_ACTION.NONE);
  assert.equal(planNotes({ Notes: null }, undefined), NOTES_ACTION.NONE);
});

test('notes plan: blank over text on file is a wipe; a known clear is not re-judged', () => {
  const entry = { notes: JIAN_NOTE };
  assert.equal(planNotes({ Notes: '' }, entry), NOTES_ACTION.WIPED);
  assert.equal(planNotes({ Notes: '   ' }, entry), NOTES_ACTION.WIPED);
  assert.equal(planNotes({ Notes: '' }, { ...entry, clearedAt: '2026-09-22T00:00:00Z' }), NOTES_ACTION.NONE);
});

test('notes plan: line endings and edge whitespace are not an edit', () => {
  assert.equal(sameNotes('Strictly COD\r\n$114/g ', 'Strictly COD\n$114/g'), true);
  assert.equal(planNotes({ Notes: 'Strictly COD\r\n$114/g' }, { notes: 'Strictly COD\n$114/g' }), NOTES_ACTION.NONE);
  assert.equal(planNotes({ Notes: 'Strictly COD, $120/g' }, { notes: 'Strictly COD' }), NOTES_ACTION.REPLACE);
});

test('notes plan: Unleashed /Date()/ values and ISO strings both parse', () => {
  assert.equal(parseUnleashedDate('/Date(1790058009129)/'), 1790058009129);
  assert.equal(parseUnleashedDate('2026-09-22T06:05:09.724Z'), Date.parse('2026-09-22T06:05:09.724Z'));
  assert.equal(parseUnleashedDate(null), null);
});

test('an unreadable snapshot throws rather than starting a fresh baseline over it', () => {
  assert.throws(() => parseSnapshot('{not json'));
  assert.throws(() => parseSnapshot('{"version":1}'));
});

test('first pass is a baseline: records every note, restores and looks up nothing', async () => {
  const unleashed = fakeNotesUnleashed({
    customers: [notesCustomer(), notesCustomer({ Guid: 'g2', CustomerCode: 'GCJ432', Notes: '' })],
  });
  const store = createMemoryNotesStore();
  const report = await runGuard(unleashed, store, { nowMs: T0 });

  assert.equal(report.baseline, true);
  assert.deepEqual(report.byOutcome, { [NOTES_OUTCOME.BASELINE]: 1 });
  assert.equal(unleashed.calls.updates.length, 0);
  assert.equal(unleashed.calls.orderLookups.length, 0);
  const saved = store.peek();
  assert.equal(saved.customers[MB712_GUID].notes, JIAN_NOTE);
  assert.equal(saved.customers.g2, undefined);
  assert.equal(saved.takenAt, new Date(T0).toISOString());
});

test("Jian's test: notes wiped with web order #3185 are put back, the rest of the record as read", async () => {
  const wipeMs = T0 + 5 * MINUTE;
  const unleashed = fakeNotesUnleashed({
    customers: [notesCustomer({ Notes: '', LastModifiedOn: unleashedDate(wipeMs) })],
    orders: [webOrder('web#3185', wipeMs - 5_000)],
  });
  const store = createMemoryNotesStore(notesSnapshotAt(T0));
  const report = await runGuard(unleashed, store, { nowMs: T0 + 15 * MINUTE });

  assert.equal(report.results[0].outcome, NOTES_OUTCOME.RESTORED);
  assert.deepEqual(report.results[0].orders, ['web#3185']);
  assert.equal(unleashed.byGuid.get(MB712_GUID).Notes, JIAN_NOTE);
  const { body } = unleashed.calls.updates[0];
  assert.equal(body.Notes, JIAN_NOTE);
  assert.equal(body.PaymentTerm, 'C.O.D.');
  assert.equal(body.SellPriceTier, 'Exclusive');
  assert.equal(body.Addresses[0].StreetAddress, '135 Ironwood Street');
  assert.equal(body.Addresses[0].Guid, undefined, 'address Guids are answered with a bare 500');
  assert.equal(body.LastModifiedOn, undefined);
  assert.equal(store.peek().customers[MB712_GUID].restoredAt, new Date(T0 + 15 * MINUTE).toISOString());
});

test('notes blanked with no web order are a person clearing them: left blank, text kept', async () => {
  const unleashed = fakeNotesUnleashed({
    customers: [notesCustomer({ Notes: '', LastModifiedOn: unleashedDate(T0 + 5 * MINUTE) })],
  });
  const store = createMemoryNotesStore(notesSnapshotAt(T0));
  const report = await runGuard(unleashed, store, { nowMs: T0 + 15 * MINUTE });

  assert.equal(report.results[0].outcome, NOTES_OUTCOME.CLEARED);
  assert.equal(unleashed.calls.updates.length, 0);
  const entry = store.peek().customers[MB712_GUID];
  assert.equal(entry.notes, JIAN_NOTE, 'the cleared text stays in the snapshot as the backup');
  assert.ok(entry.clearedAt);

  // Touched again later, still blank, and now a web order arrives: a known clear is not undone.
  unleashed.byGuid.get(MB712_GUID).LastModifiedOn = unleashedDate(T0 + 35 * MINUTE);
  const again = await runGuard(
    fakeNotesUnleashed({ customers: [unleashed.byGuid.get(MB712_GUID)], orders: [webOrder('web#3200', T0 + 34 * MINUTE)] }),
    store,
    { nowMs: T0 + 45 * MINUTE },
  );
  assert.deepEqual(again.byOutcome, {});
});

test('a web order from before the window does not make a blanking the connector', async () => {
  const unleashed = fakeNotesUnleashed({
    customers: [notesCustomer({ Notes: '', LastModifiedOn: unleashedDate(T0 + 5 * MINUTE) })],
    orders: [webOrder('web#3160', T0 - 3 * 24 * 60 * MINUTE)],
  });
  const report = await runGuard(unleashed, createMemoryNotesStore(notesSnapshotAt(T0)), { nowMs: T0 + 15 * MINUTE });
  assert.equal(report.results[0].outcome, NOTES_OUTCOME.CLEARED);
  assert.equal(unleashed.calls.updates.length, 0);
});

test('a dry run restores nothing, and the next live run still restores with the original window', async () => {
  const wipeMs = T0 + 5 * MINUTE;
  const customers = [notesCustomer({ Notes: '', LastModifiedOn: unleashedDate(wipeMs) })];
  const orders = [webOrder('web#3185', wipeMs)];
  const store = createMemoryNotesStore(notesSnapshotAt(T0));

  const dry = fakeNotesUnleashed({ customers, orders });
  const first = await runGuard(dry, store, { nowMs: T0 + 15 * MINUTE, config: { dryRun: true } });
  assert.equal(first.results[0].outcome, NOTES_OUTCOME.DRY_RUN);
  assert.equal(dry.calls.updates.length, 0);
  assert.equal(first.pending, 1);

  // Hours later: the customer has not been modified since, so only `pending` brings it back.
  const live = fakeNotesUnleashed({ customers, orders });
  const second = await runGuard(live, store, { nowMs: T0 + 6 * 60 * MINUTE });
  assert.equal(second.results[0].outcome, NOTES_OUTCOME.RESTORED);
  assert.equal(live.byGuid.get(MB712_GUID).Notes, JIAN_NOTE);
  assert.equal(second.pending, 0);
});

test('a restore that does not stick is FAILED and retried next run', async () => {
  const wipeMs = T0 + 5 * MINUTE;
  const unleashed = fakeNotesUnleashed({
    customers: [notesCustomer({ Notes: '', LastModifiedOn: unleashedDate(wipeMs) })],
    orders: [webOrder('web#3185', wipeMs)],
    ignoreWrites: true,
  });
  const report = await runGuard(unleashed, createMemoryNotesStore(notesSnapshotAt(T0)), { nowMs: T0 + 15 * MINUTE });
  assert.equal(report.results[0].outcome, NOTES_OUTCOME.FAILED);
  assert.equal(report.pending, 1);
});

test('text replaced alongside a web order is kept but flagged, with the old text saved', async () => {
  const changeMs = T0 + 5 * MINUTE;
  const unleashed = fakeNotesUnleashed({
    customers: [notesCustomer({ Notes: 'Imported from Mailchimp; original status: blank', LastModifiedOn: unleashedDate(changeMs) })],
    orders: [webOrder('web#3186', changeMs)],
  });
  const store = createMemoryNotesStore(notesSnapshotAt(T0));
  const report = await runGuard(unleashed, store, { nowMs: T0 + 15 * MINUTE });

  assert.equal(report.results[0].outcome, NOTES_OUTCOME.REPLACED_WITH_WEB_ORDER);
  assert.equal(unleashed.calls.updates.length, 0);
  const entry = store.peek().customers[MB712_GUID];
  assert.equal(entry.notes, 'Imported from Mailchimp; original status: blank');
  assert.equal(entry.previous, JIAN_NOTE);
});

test('a report-only run saves nothing, so the window does not move past what it saw', async () => {
  const unleashed = fakeNotesUnleashed({
    customers: [notesCustomer({ Notes: '', LastModifiedOn: unleashedDate(T0 + 5 * MINUTE) })],
    orders: [webOrder('web#3185', T0 + 5 * MINUTE)],
  });
  const store = createMemoryNotesStore(notesSnapshotAt(T0));
  const report = await runGuard(unleashed, store, { nowMs: T0 + 15 * MINUTE, apply: false, persist: false });
  assert.equal(report.results[0].outcome, NOTES_OUTCOME.DRY_RUN);
  assert.equal(store.peek().takenAt, new Date(T0).toISOString());
});

test('force restore puts back text the guard classed as cleared', async () => {
  const unleashed = fakeNotesUnleashed({ customers: [notesCustomer({ Notes: '' })] });
  const cleared = { code: 'MB712', notes: JIAN_NOTE, seenAt: new Date(T0).toISOString(), clearedAt: new Date(T0).toISOString() };
  const store = createMemoryNotesStore(notesSnapshotAt(T0, cleared));
  const result = await forceRestore({
    customerCode: 'mb712', unleashed, store, config: { dryRun: false }, log: QUIET_LOG, apply: true,
  });
  assert.equal(result.outcome, NOTES_OUTCOME.RESTORED);
  assert.equal(unleashed.byGuid.get(MB712_GUID).Notes, JIAN_NOTE);
  assert.equal(store.peek().customers[MB712_GUID].clearedAt, undefined);
});

// --- New Arrivals ---------------------------------------------------------

const NA_NOW = Date.UTC(2026, 9, 2, 4, 0, 0);
const naDate = (y, m, d) => `/Date(${Date.UTC(y, m - 1, d)})/`;
const naSku = (productId, productCount = 1) => ({ productId, title: productId, productCount });

test('the cutoff is six calendar months back', () => {
  assert.equal(new Date(newArrivalCutoff(NA_NOW, 6)).toISOString(), '2026-04-02T04:00:00.000Z');
});

test('only non-obsolete products created on or after the cutoff are recent', () => {
  const cutoff = newArrivalCutoff(NA_NOW, 6);
  const recent = recentCodes(
    [
      { ProductCode: '9KBELY06060CM', CreatedOn: naDate(2026, 8, 3) },
      { ProductCode: 'MS530', CreatedOn: naDate(2024, 3, 1) },
      { ProductCode: 'OLDNEW', CreatedOn: naDate(2026, 9, 1), Obsolete: true },
      { ProductCode: 'NODATE' },
    ],
    cutoff,
  );
  assert.deepEqual([...recent.keys()], ['9kbely06060cm']);
});

test('plan tags new products, untags aged-out ones, and leaves settled ones alone', () => {
  const recent = new Map([['a1', 3], ['b1', 2]]);
  const skus = new Map([['a1', naSku('P_A')], ['b1', naSku('P_B')], ['old', naSku('P_OLD')]]);
  const plan = planNewArrivals({ recent, skus, tagged: new Set(['P_B', 'P_OLD']) });
  assert.deepEqual(plan.add.map((e) => e.productId), ['P_A']);
  assert.deepEqual(plan.remove, ['P_OLD']);
  assert.deepEqual(plan.heldRemovals, []);
});

test('a product dates from its newest variant code', () => {
  const recent = new Map([['a-45', 100], ['a-50', 300]]);
  const skus = new Map([['a-45', naSku('P_A')], ['a-50', naSku('P_A')]]);
  const plan = planNewArrivals({ recent, skus, tagged: new Set() });
  assert.equal(plan.wanted.get('P_A').createdMs, 300);
  assert.equal(plan.add.length, 1);
});

test('unmatched and ambiguous codes are reported, not tagged', () => {
  const recent = new Map([['nowhere', 1], ['twice', 1]]);
  const skus = new Map([['twice', naSku('P_X', 2)]]);
  const plan = planNewArrivals({ recent, skus, tagged: new Set() });
  assert.deepEqual(plan.unmatched, ['nowhere']);
  assert.deepEqual(plan.ambiguous, ['twice']);
  assert.equal(plan.add.length, 0);
});

test('a mass untag is held back as a short read, unless forced', () => {
  const tagged = new Set(Array.from({ length: 40 }, (_, i) => `P${i}`));
  const recent = new Map([['keep', 1]]);
  const skus = new Map([['keep', naSku('P0')]]);
  const held = planNewArrivals({ recent, skus, tagged });
  assert.equal(held.remove.length, 0);
  assert.equal(held.heldRemovals.length, 39);
  const forced = planNewArrivals({ recent, skus, tagged, force: true });
  assert.equal(forced.remove.length, 39);
});

test('a few products ageing out of a small list is not held back', () => {
  const tagged = new Set(['P1', 'P2', 'P3']);
  const plan = planNewArrivals({ recent: new Map(), skus: new Map(), tagged });
  assert.equal(plan.remove.length, 3);
});

test('collection order is newest first, unknown products last in their old order', () => {
  const wanted = new Map([['A', { createdMs: 1 }], ['B', { createdMs: 3 }], ['C', { createdMs: 2 }]]);
  assert.deepEqual(newestFirst(['X', 'A', 'Y', 'B', 'C'], wanted), ['B', 'C', 'A', 'X', 'Y']);
});

test('reorder moves start at the first difference and cover the rest', () => {
  assert.deepEqual(reorderMoves(['A', 'B', 'C'], ['A', 'B', 'C']), []);
  assert.deepEqual(reorderMoves(['A', 'C', 'B'], ['A', 'B', 'C']), [
    { id: 'B', newPosition: '1' },
    { id: 'C', newPosition: '2' },
  ]);
});

function fakeNewArrivalsShopify({ tagged = [], skus = new Map(), collection = null } = {}) {
  const calls = { add: [], remove: [], reorder: [] };
  return {
    calls,
    async listAllVariantSkus() {
      return skus;
    },
    async listProductIdsWithTag(tag) {
      assert.equal(tag, NEW_ARRIVAL_TAG);
      return new Set(tagged);
    },
    async addTags({ productId }) {
      calls.add.push(productId);
    },
    async removeTags({ productId }) {
      calls.remove.push(productId);
    },
    async getCollectionProducts() {
      return collection;
    },
    async reorderCollection({ moves }) {
      calls.reorder.push(...moves);
    },
  };
}

function fakeNewArrivalsUnleashed(pages) {
  return {
    async *iterateProducts() {
      for (const [index, items] of pages.entries()) {
        yield { items, pageNumber: index + 1, totalPages: pages.length };
      }
    },
  };
}

const NA_CONFIG = { newArrivalMonths: 6, newArrivalCollectionHandle: 'new-arrivals', dryRun: false };

test('syncNewArrivals tags, untags and orders a manual collection', async () => {
  const unleashed = fakeNewArrivalsUnleashed([
    [
      { ProductCode: 'NEW1', CreatedOn: naDate(2026, 9, 1) },
      { ProductCode: 'NEW2', CreatedOn: naDate(2026, 5, 1) },
    ],
  ]);
  const shopify = fakeNewArrivalsShopify({
    tagged: ['P_NEW2', 'P_OLD'],
    skus: new Map([['new1', naSku('P_NEW1')], ['new2', naSku('P_NEW2')]]),
    collection: { id: 'C1', sortOrder: 'MANUAL', rules: [], productIds: ['P_NEW2', 'P_NEW1'] },
  });
  const report = await syncNewArrivals({
    unleashed, shopify, config: NA_CONFIG, log: QUIET_LOG, apply: true, nowMs: NA_NOW, settleMs: 0,
  });
  assert.deepEqual(shopify.calls.add, ['P_NEW1']);
  assert.deepEqual(shopify.calls.remove, ['P_OLD']);
  assert.deepEqual(shopify.calls.reorder.map((m) => m.id), ['P_NEW1', 'P_NEW2']);
  assert.equal(report.byOutcome[NEW_ARRIVAL_OUTCOME.TAGGED], 1);
  assert.equal(report.byOutcome[NEW_ARRIVAL_OUTCOME.UNTAGGED], 1);
});

test('syncNewArrivals writes nothing without apply, or under DRY_RUN', async () => {
  for (const [apply, dryRun] of [[false, false], [true, true]]) {
    const shopify = fakeNewArrivalsShopify({
      skus: new Map([['new1', naSku('P_NEW1')]]),
      collection: { id: 'C1', sortOrder: 'MANUAL', rules: [], productIds: ['P_X', 'P_NEW1'] },
    });
    const report = await syncNewArrivals({
      unleashed: fakeNewArrivalsUnleashed([[{ ProductCode: 'NEW1', CreatedOn: naDate(2026, 9, 1) }]]),
      shopify, config: { ...NA_CONFIG, dryRun }, log: QUIET_LOG, apply, nowMs: NA_NOW, settleMs: 0,
    });
    assert.equal(shopify.calls.add.length + shopify.calls.remove.length + shopify.calls.reorder.length, 0);
    assert.equal(report.byOutcome[NEW_ARRIVAL_OUTCOME.DRY_RUN], 1);
  }
});

test('a collection not sorted manually is left alone', async () => {
  const shopify = fakeNewArrivalsShopify({
    tagged: ['P_NEW1'],
    skus: new Map([['new1', naSku('P_NEW1')]]),
    collection: { id: 'C1', sortOrder: 'BEST_SELLING', rules: [], productIds: ['P_X', 'P_NEW1'] },
  });
  const report = await syncNewArrivals({
    unleashed: fakeNewArrivalsUnleashed([[{ ProductCode: 'NEW1', CreatedOn: naDate(2026, 9, 1) }]]),
    shopify, config: NA_CONFIG, log: QUIET_LOG, apply: true, nowMs: NA_NOW, settleMs: 0,
  });
  assert.equal(shopify.calls.reorder.length, 0);
  assert.match(report.ordering.status, /BEST_SELLING/);
});

test('an Unleashed walk that stops short throws instead of untagging', async () => {
  const unleashed = {
    async *iterateProducts() {
      yield { items: [{ ProductCode: 'NEW1', CreatedOn: naDate(2026, 9, 1) }], pageNumber: 1, totalPages: 3 };
    },
  };
  const shopify = fakeNewArrivalsShopify({ tagged: ['P_A', 'P_B'] });
  await assert.rejects(
    syncNewArrivals({ unleashed, shopify, config: NA_CONFIG, log: QUIET_LOG, apply: true, nowMs: NA_NOW, settleMs: 0 }),
    /stopped at page 1 of 3/,
  );
  assert.equal(shopify.calls.remove.length, 0);
});

// --- weekly products without images -------------------------------------------

const MI_CUTOFF = newArrivalCutoff(NA_NOW, 12);
const miSkus = new Map([
  ['bare1', { productId: 'P1', title: 'Bare ring', productCount: 1, hasImage: false }],
  ['hand1', { productId: 'P2', title: 'Hand ring', productCount: 1, hasImage: true }],
]);

test('only products created inside the window with no image are listed', () => {
  const result = findMissingImages({
    products: [
      { ProductCode: 'BARE1', CreatedOn: naDate(2026, 8, 1), Images: [] },
      { ProductCode: 'PHOTO1', CreatedOn: naDate(2026, 8, 1), Images: [{ Url: 'a.jpg' }] },
      { ProductCode: 'OLD1', CreatedOn: naDate(2024, 3, 1), Images: [] },
      { ProductCode: 'GONE1', CreatedOn: naDate(2026, 8, 1), Images: [], Obsolete: true },
      { ProductCode: 'NODATE', Images: [] },
    ],
    skus: miSkus,
    cutoffMs: MI_CUTOFF,
  });
  assert.equal(result.recent, 2);
  assert.equal(result.withImages, 1);
  assert.deepEqual(result.missing.map((row) => row.productCode), ['BARE1']);
  assert.equal(result.missing[0].created, '2026-08-01');
});

test('excluded codes are left out of the missing-image list, whatever their case', () => {
  const result = findMissingImages({
    products: [
      { ProductCode: 'RETURN-ITEM', CreatedOn: naDate(2026, 9, 16), Images: [] },
      { ProductCode: 'Air Freight', CreatedOn: naDate(2026, 8, 28), Images: [] },
      { ProductCode: 'BARE1', CreatedOn: naDate(2026, 8, 1), Images: [] },
    ],
    skus: miSkus,
    cutoffMs: MI_CUTOFF,
    excludeCodes: ['return-item', 'AIR FREIGHT '],
  });
  assert.equal(result.recent, 1);
  assert.deepEqual(result.missing.map((row) => row.productCode), ['BARE1']);
});

test('products bare on the website come first, then newest first', () => {
  const result = findMissingImages({
    products: [
      { ProductCode: 'OFFSITE', CreatedOn: naDate(2026, 9, 20) },
      { ProductCode: 'HAND1', CreatedOn: naDate(2026, 9, 10) },
      { ProductCode: 'OFFSITE2', CreatedOn: naDate(2026, 9, 25) },
      { ProductCode: 'BARE1', CreatedOn: naDate(2026, 1, 5) },
    ],
    skus: miSkus,
    cutoffMs: MI_CUTOFF,
  });
  assert.deepEqual(
    result.missing.map((row) => [row.productCode, row.status]),
    [
      ['BARE1', WEBSITE_IMAGE_STATUS.LISTED_NO_IMAGE],
      ['HAND1', WEBSITE_IMAGE_STATUS.LISTED_HAS_IMAGE],
      ['OFFSITE2', WEBSITE_IMAGE_STATUS.NOT_LISTED],
      ['OFFSITE', WEBSITE_IMAGE_STATUS.NOT_LISTED],
    ],
  );
  assert.equal(result.missing[0].websiteTitle, 'Bare ring');
});

test('the missing-image check reads 12 months back and reports the cutoff', async () => {
  let asked;
  const unleashed = {
    async *iterateProducts(options) {
      asked = options;
      yield {
        items: [{ ProductCode: 'BARE1', ProductDescription: 'Ring', CreatedOn: naDate(2026, 8, 1), Images: [] }],
        pageNumber: 1,
        totalPages: 1,
      };
    },
  };
  const shopify = { async listAllVariantSkus() { return miSkus; } };
  const audit = await auditMissingImages({ unleashed, shopify, config: { missingImageMonths: 12 }, nowMs: NA_NOW });
  assert.equal(asked.sinceIso, '2025-10-02T04:00:00');
  assert.equal(audit.cutoff, '2025-10-02');
  assert.equal(audit.missing.length, 1);
});

test('the missing-image email carries the count in the subject and a CSV', () => {
  const audit = {
    months: 12,
    cutoff: '2025-10-02',
    recent: 40,
    withImages: 38,
    missing: [
      { productCode: 'BARE1', description: 'Ring "special", 9ct', created: '2026-08-01', status: WEBSITE_IMAGE_STATUS.LISTED_NO_IMAGE, websiteTitle: 'Bare ring' },
      { productCode: 'OFFSITE', description: 'Chain', created: '2026-09-20', status: WEBSITE_IMAGE_STATUS.NOT_LISTED, websiteTitle: '' },
    ],
  };
  const summary = buildMissingImagesSummary({ audit });
  assert.equal(summary.health, SYNC_HEALTH.WARN);
  assert.ok(summary.subject.includes('2 product(s) need an image uploaded'));
  assert.ok(summary.text.includes('BARE1  on website, no image'));
  assert.ok(summary.html.includes('Products needing an image'));

  const rows = buildMissingImagesCsv(audit).split('\n');
  assert.equal(rows[0], 'product_code,description,created,website,website_title');
  assert.ok(rows[1].includes('"Ring ""special"", 9ct"'));
  assert.ok(rows[2].endsWith('not on website,'));
});

test('no missing images is OK; a window with no images at all is called out', () => {
  const clean = buildMissingImagesSummary({
    audit: { months: 12, cutoff: '2025-10-02', recent: 5, withImages: 5, missing: [] },
  });
  assert.equal(clean.health, SYNC_HEALTH.OK);
  assert.ok(clean.text.includes('Nothing to action'));

  const suspect = buildMissingImagesSummary({
    audit: {
      months: 12, cutoff: '2025-10-02', recent: 1, withImages: 0,
      missing: [{ productCode: 'X', description: '', created: '2026-08-01', status: WEBSITE_IMAGE_STATUS.NOT_LISTED, websiteTitle: '' }],
    },
  });
  assert.ok(suspect.text.includes('Check before acting'));
});

// --- This Week Specials ---------------------------------------------------

const WS_NOW = Date.UTC(2026, 9, 7, 0, 0, 0);
const WS_CUTOFF = newArrivalCutoff(WS_NOW, 24);
const WS_DAY = 86_400_000;
const WS_CURRENT = new Set(['divya', 'lotus']);
const wsDate = (y, m, d) => `/Date(${Date.UTC(y, m - 1, d)})/`;
const wsSku = (productId, productType, extra = {}) => ({
  productId, title: productId, productCount: 1, productType, onWebsite: true, price: 100, ...extra,
});
const wsBin = (bin) => [
  { Warehouse: { WarehouseCode: 'VIC' }, BinLocation: 'VIC1' },
  { Warehouse: { WarehouseCode: 'WH' }, BinLocation: bin },
];

/** One qualifying product per code (old supplier, own bin, undated) unless the overrides say otherwise. */
function wsInput({ rows, tagged = [], perCategory = 2 }) {
  const products = [];
  const daysSinceSale = new Map();
  const warehouseQty = new Map();
  const landed = new Map();
  const skus = new Map();
  for (const row of rows) {
    const code = row.code.toLowerCase();
    products.push({
      ProductCode: row.code,
      CreatedOn: row.created ?? wsDate(2024, 3, 1),
      Supplier: { SupplierName: row.supplier ?? 'Unknown' },
      InventoryDetails: wsBin(row.bin === undefined ? `BIN-${row.code}` : row.bin),
    });
    daysSinceSale.set(code, row.daysSinceSale ?? null);
    warehouseQty.set(code, row.qty ?? 1);
    if (row.landedMs) landed.set(code, row.landedMs);
    if (row.listed !== false) skus.set(code, wsSku(row.productId ?? `P_${row.code}`, row.type ?? 'Rings', row.sku ?? {}));
  }
  return {
    products, daysSinceSale, warehouseQty, landed, skus, tagged: new Set(tagged),
    nowMs: WS_NOW, cutoffMs: WS_CUTOFF, perCategory, minPrice: 80, warehouseCode: 'WH', currentSuppliers: WS_CURRENT,
  };
}

test('product types map to the four categories, earrings before rings', () => {
  assert.equal(specialCategory('Diamond Huggies'), SPECIAL_CATEGORY.EARRINGS);
  assert.equal(specialCategory('Earrings'), SPECIAL_CATEGORY.EARRINGS);
  assert.equal(specialCategory('Semi-Mount Rings'), SPECIAL_CATEGORY.RINGS);
  assert.equal(specialCategory('Bangles (No Stones)'), SPECIAL_CATEGORY.CHAINS_BRACELETS);
  assert.equal(specialCategory('Diamond Necklets'), SPECIAL_CATEGORY.CHAINS_BRACELETS);
  assert.equal(specialCategory('Lockets'), SPECIAL_CATEGORY.PENDANTS);
  assert.equal(specialCategory('Findings'), null);
});

test('chain lengths, ring sizes and pendant letters are one design', () => {
  assert.equal(designFamily('9KBELY05950CM'), designFamily('9KBELY05945CM'));
  assert.equal(designFamily('9KSR034SIZEP'), designFamily('9KSR034SIZEM'));
  assert.equal(designFamily('9KDLW3C', 'Letter Pendants'), designFamily('9KDLW3R', 'Letter Pendants'));
  assert.notEqual(designFamily('9KDP626', 'Diamond Pendants'), designFamily('9KDP62', 'Diamond Pendants'));
});

test('products are related by their warehouse bin, or by design when there is no bin', () => {
  const nineK = { ProductCode: '9KFSY05042CM', InventoryDetails: wsBin('FSY050') };
  const eighteenK = { ProductCode: '18KFSY05042CM', InventoryDetails: wsBin('fsy050') };
  assert.equal(relatedKey(nineK, 'WH'), relatedKey(eighteenK, 'WH'));
  assert.equal(relatedKey(nineK, 'WH'), 'fsy050', 'the VIC bin is not used');
  const noBin = (code, bin) => relatedKey({ ProductCode: code, InventoryDetails: wsBin(bin) }, 'WH');
  assert.equal(noBin('9KSR034SIZEP', '0'), noBin('9KSR034SIZEM', 'N/A'));
  assert.notEqual(noBin('9KSR034SIZEP', null), noBin('9KSR035SIZEP', null));
});

test('landed date is the latest receipt that received the code', () => {
  const landed = landedDates([
    { ReceivedDate: wsDate(2025, 1, 1), PurchaseOrderLines: [{ Product: { ProductCode: 'A' }, ReceiptQuantity: 2 }] },
    { ReceivedDate: wsDate(2026, 2, 1), PurchaseOrderLines: [{ Product: { ProductCode: 'A' }, ReceiptQuantity: 1 }] },
    { ReceivedDate: wsDate(2026, 5, 1), PurchaseOrderLines: [{ Product: { ProductCode: 'B' }, ReceiptQuantity: 0 }] },
    { ReceivedDate: null, PurchaseOrderLines: [{ Product: { ProductCode: 'C' }, ReceiptQuantity: 3 }] },
  ]);
  assert.equal(landed.get('a'), Date.UTC(2026, 1, 1));
  assert.equal(landed.has('b'), false);
  assert.equal(landed.has('c'), false);
});

test('specials skip current suppliers, recent sales, new products, no warehouse stock and hidden products', () => {
  const plan = planWeeklySpecials(wsInput({
    perCategory: 20,
    rows: [
      { code: 'OK1' },
      { code: 'NOSUPPLIER', supplier: '' },
      { code: 'OLDSUPPLIER', supplier: 'Cavinato Dino SRL' },
      { code: 'CURRENT', supplier: 'Divya' },
      { code: 'CURRENTCASE', supplier: 'LOTUS ' },
      { code: 'SOLDLONGAGO', daysSinceSale: 800 },
      { code: 'SOLDRECENT', daysSinceSale: 600 },
      { code: 'NEWPRODUCT', created: wsDate(2026, 1, 1) },
      { code: 'NOSTOCK', qty: 0 },
      { code: 'HIDDEN', sku: { onWebsite: false } },
      { code: 'FINDING', type: 'Findings' },
    ],
  }));
  assert.deepEqual([...plan.wanted.keys()].sort(), ['P_NOSUPPLIER', 'P_OK1', 'P_OLDSUPPLIER', 'P_SOLDLONGAGO']);
});

test('specials must be priced over the minimum, judged by an in-stock variant', () => {
  const plan = planWeeklySpecials(wsInput({
    perCategory: 20,
    rows: [
      { code: 'DEAR', sku: { price: 80.01 } },
      { code: 'EXACTLY80', sku: { price: 80 } },
      { code: 'CHEAP', sku: { price: 45 } },
      { code: 'UNPRICED', sku: { price: null } },
      // A ring whose only dear size is out of stock does not count.
      { code: 'R2SIZEM', productId: 'P_R2', sku: { price: 60 } },
      { code: 'R2SIZEZ', productId: 'P_R2', qty: 0, sku: { price: 120 } },
      // Its dear size in stock does, and that size stands for the product.
      { code: 'R3SIZEM', productId: 'P_R3', sku: { price: 60 } },
      { code: 'R3SIZEZ', productId: 'P_R3', sku: { price: 120 } },
    ],
  }));
  assert.deepEqual([...plan.wanted.keys()].sort(), ['P_DEAR', 'P_R3']);
  assert.equal(plan.wanted.get('P_R3').code, 'R3SIZEZ');
  assert.equal(plan.wanted.get('P_R3').price, 120);
});

test('specials are picked oldest first but shown most expensive first', () => {
  const plan = planWeeklySpecials(wsInput({
    perCategory: 2,
    rows: [
      { code: 'OLDCHEAP', landedMs: WS_NOW - 1000 * WS_DAY, sku: { price: 90 } },
      { code: 'OLDDEAR', landedMs: WS_NOW - 900 * WS_DAY, sku: { price: 500 } },
      // Dearest of all, but too recently landed to be picked.
      { code: 'NEWDEAR', landedMs: WS_NOW - 800 * WS_DAY, sku: { price: 900 } },
    ],
  }));
  const ranked = [...plan.wanted.values()].sort((a, b) => a.rank - b.rank).map((entry) => entry.productId);
  assert.deepEqual(ranked, ['P_OLDDEAR', 'P_OLDCHEAP']);
});

test('a sale of anything in the same bin keeps a product off the specials', () => {
  const plan = planWeeklySpecials(wsInput({
    rows: [
      // 18k Franco chain unsold, but the 9k one in the same bin sells.
      { code: '18KFSY05042CM', bin: 'FSY050' },
      { code: '9KFSY05045CM', bin: 'FSY050', daysSinceSale: 30, qty: 0, listed: false },
      // One ring size of a Shopify product sold: the whole product is out.
      { code: 'R1SIZEM', productId: 'P_R1' },
      { code: 'R1SIZEP', productId: 'P_R1', daysSinceSale: 20, qty: 0 },
      // No bin: related by design, so another length's sale counts.
      { code: 'CH01045CM', bin: '0', type: 'Curb Chains' },
      { code: 'CH01050CM', bin: '0', daysSinceSale: 10, qty: 0, listed: false },
    ],
  }));
  assert.equal(plan.wanted.size, 0);
});

test('specials are oldest landed first, undated first, capped per category, one per bin', () => {
  const plan = planWeeklySpecials(wsInput({
    perCategory: 3,
    rows: [
      { code: 'NEW', landedMs: WS_NOW - 800 * WS_DAY },
      { code: 'OLD', landedMs: WS_NOW - 1000 * WS_DAY },
      { code: 'UNDATED_SOLD', daysSinceSale: 900 },
      { code: 'UNDATED_NEVER' },
      { code: 'CH01045CM', type: 'Curb Chains', bin: 'CH010' },
      { code: 'CH01050CM', type: 'Curb Chains', bin: 'CH010' },
    ],
  }));
  const ranked = [...plan.wanted.values()].sort((a, b) => a.rank - b.rank).map((entry) => entry.productId);
  const chains = ranked.filter((id) => id.startsWith('P_CH010'));
  assert.equal(chains.length, 1, 'one length per bin');
  // Undated and never sold tie, so this week's shuffle orders them; then the sold one, then the dated one.
  assert.deepEqual(ranked.slice(0, 2).sort(), [chains[0], 'P_UNDATED_NEVER'].sort());
  assert.deepEqual(ranked.slice(2), ['P_UNDATED_SOLD', 'P_OLD']);
  assert.equal(plan.qualifying, 6);
  assert.deepEqual(plan.shortfalls.map((s) => [s.category, s.picked]), [
    [SPECIAL_CATEGORY.CHAINS_BRACELETS, 1],
    [SPECIAL_CATEGORY.EARRINGS, 0],
    [SPECIAL_CATEGORY.PENDANTS, 0],
  ]);
});

test('tied specials hold for a week and change the next', () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({ code: `TIE${index}` }));
  const pick = (nowMs) => [...planWeeklySpecials({ ...wsInput({ rows, perCategory: 5 }), nowMs }).wanted.keys()];
  const timerRun = Date.UTC(2026, 9, 11, 18, 30); // Monday 04:30 AEST
  const monday = pick(timerRun);
  assert.deepEqual(pick(Date.UTC(2026, 9, 11, 14, 1)), monday, 'Monday just after midnight AEST');
  assert.deepEqual(pick(Date.UTC(2026, 9, 18, 13, 59)), monday, 'the following Sunday night AEST');
  assert.notDeepEqual(pick(Date.UTC(2026, 9, 18, 18, 30)), monday, 'different next Monday');
  assert.equal(weeklyShuffle('A', WS_NOW), weeklyShuffle('A', WS_NOW));
});

test("specials replace last week's tags; an empty pick keeps them unless forced", () => {
  const swap = planWeeklySpecials(wsInput({ rows: [{ code: 'A' }], tagged: ['P_A', 'P_LAST'] }));
  assert.deepEqual(swap.add, []);
  assert.deepEqual(swap.remove, ['P_LAST']);
  const empty = planWeeklySpecials(wsInput({ rows: [], tagged: ['P_LAST'] }));
  assert.deepEqual(empty.remove, []);
  assert.deepEqual(empty.heldRemovals, ['P_LAST']);
  const forced = planWeeklySpecials({ ...wsInput({ rows: [], tagged: ['P_LAST'] }), force: true });
  assert.deepEqual(forced.remove, ['P_LAST']);
});

test('syncWeeklySpecials tags, untags and orders most expensive first', async () => {
  const calls = { add: [], remove: [], reorder: [] };
  const landedOn = WS_NOW - 800 * WS_DAY;
  const unleashed = {
    async listProducts() {
      return [
        { ProductCode: 'RA', CreatedOn: wsDate(2024, 3, 1), Supplier: { SupplierName: 'Hem' }, InventoryDetails: wsBin('RA') },
        { ProductCode: 'RB', CreatedOn: wsDate(2024, 3, 1), Supplier: { SupplierName: 'Unknown' }, InventoryDetails: wsBin('RB') },
        { ProductCode: 'RC', CreatedOn: wsDate(2024, 3, 1), Supplier: { SupplierName: 'Divya' }, InventoryDetails: wsBin('RC') },
      ];
    },
    async listStockOnHand({ warehouseCode } = {}) {
      return warehouseCode
        ? ['RA', 'RB', 'RC'].map((code) => ({ ProductCode: code, QtyOnHand: 1 }))
        : [{ ProductCode: 'RA', DaysSinceLastSale: null }, { ProductCode: 'RB', DaysSinceLastSale: 800 }];
    },
    async listPurchaseOrders() {
      return [
        { ReceivedDate: `/Date(${landedOn})/`, PurchaseOrderLines: [{ Product: { ProductCode: 'RA' }, ReceiptQuantity: 1 }] },
      ];
    },
  };
  const shopify = {
    async listAllVariantSkus() {
      return new Map([
        ['ra', wsSku('P_RA', 'Rings', { price: 250 })],
        ['rb', wsSku('P_RB', 'Diamond Rings', { price: 95.5 })],
        ['rc', wsSku('P_RC', 'Rings')],
      ]);
    },
    async listProductIdsWithTag(tag) {
      assert.equal(tag, WEEKLY_SPECIAL_TAG);
      return new Set(['P_LAST']);
    },
    async addTags({ productId, tags }) {
      assert.deepEqual(tags, [WEEKLY_SPECIAL_TAG]);
      calls.add.push(productId);
    },
    async removeTags({ productId }) {
      calls.remove.push(productId);
    },
    async getCollectionProducts() {
      return { id: 'C', sortOrder: 'MANUAL', rules: [], productIds: ['P_RB', 'P_RA'] };
    },
    async reorderCollection({ moves }) {
      calls.reorder.push(...moves);
    },
  };
  const config = {
    weeklySpecialsUnsoldMonths: 24, weeklySpecialsPerCategory: 12, weeklySpecialsMinPrice: 80, weeklySpecialsWarehouse: 'WH',
    weeklySpecialsCurrentSuppliers: ['Divya'], weeklySpecialsCollectionHandle: 'sale', dryRun: false,
  };
  const report = await syncWeeklySpecials({
    unleashed, shopify, config, log: QUIET_LOG, apply: true, nowMs: WS_NOW, settleMs: 0,
  });
  assert.deepEqual(calls.add.sort(), ['P_RA', 'P_RB']);
  assert.deepEqual(calls.remove, ['P_LAST']);
  assert.deepEqual(calls.reorder.map((m) => m.id), ['P_RA', 'P_RB']);
  assert.deepEqual(report.specials.map((row) => [row.code, row.price, row.landed, row.lastSold]), [
    ['RA', 250, new Date(landedOn).toISOString().slice(0, 10), 'no sale on record'],
    ['RB', 95.5, 'before Mar 2024', new Date(WS_NOW - 800 * WS_DAY).toISOString().slice(0, 10)],
  ]);

  const dry = await syncWeeklySpecials({
    unleashed, shopify, config: { ...config, dryRun: true }, log: QUIET_LOG, apply: true, nowMs: WS_NOW, settleMs: 0,
  });
  assert.equal(calls.add.length, 2);
  assert.equal(dry.dryRun, true);
});

test('the specials email lists the picks and warns on a short category', () => {
  const report = {
    perCategory: 12, minPrice: 80, warehouse: 'WH', unsoldSince: '2024-10-07', qualifying: 3, currentSuppliers: ['Divya'],
    specials: [{
      category: SPECIAL_CATEGORY.RINGS, code: '9KX1', title: 'Ring, gold', supplier: 'Hem', price: 129.5,
      landed: 'before Mar 2024', lastSold: 'no sale on record',
    }],
    shortfalls: [{ category: SPECIAL_CATEGORY.EARRINGS, picked: 0, wanted: 12 }],
    results: [], heldRemovals: [],
  };
  const summary = buildWeeklySpecialsSummary({ report });
  assert.equal(summary.health, SYNC_HEALTH.WARN);
  assert.ok(summary.subject.includes('1 on this week'));
  assert.ok(summary.text.includes('Earrings: only 0 of 12'));
  assert.ok(summary.text.includes('9KX1'));
  assert.ok(summary.text.includes('Divya'));
  assert.ok(summary.text.includes('priced over $80'));
  assert.ok(summary.text.includes('$129.50'));
  assert.ok(buildWeeklySpecialsCsv(report).includes('Rings,9KX1,"Ring, gold",129.5,Hem,before Mar 2024,no sale on record'));
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
