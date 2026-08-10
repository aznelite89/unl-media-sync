#!/usr/bin/env node
/**
 * Exercises the decision logic with no network access, using URL shapes taken
 * from the live store. Run with: node scripts/self-test.js
 */
import assert from 'node:assert/strict';

import {
  DUPLICATE_KIND,
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
  buildDuplicateCsv,
  buildDuplicateSummary,
  collectProblems,
  orderedProblemDetails,
} from '../src/utils/report.js';
import { diffCatalogue, findNearMiss, buildPrefixIndex } from '../src/utils/audit.js';
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
