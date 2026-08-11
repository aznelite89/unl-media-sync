/**
 * Deciding whether two images are the same PICTURE when their names disagree.
 *
 * `imageIdentity.js` matches on the filename, which is all that survives Shopify
 * re-hosting a file it fetched from Unleashed. That works for anything Unleashed
 * itself pushed, and cannot work at all for the case this module exists for:
 *
 *   Unleashed's API returns only `{ Url, IsDefault }`, and the Url is a bare
 *   GUID —
 *     https://unlappcdn…/9c5255af-e6c0-4627-80a4-869e3e81c78b.png
 *   The human name shown in the Unleashed UI ("9KDP663 & 9KDP663-1
 *   _Comparison.png") is never sent over the wire.
 *
 * So when someone uploads that same photo into Shopify by hand it keeps its
 * human name, the GUID never matches it, and the sync uploads a second copy of a
 * picture already on the page. That is the 9KDP663-1 duplicate, and 51 more
 * products were carrying the same shape when this was written.
 *
 * The fix is to compare the bytes instead. Both sides can be fingerprinted
 * cheaply and without downloading anything:
 *
 *   Shopify  `originalSource.fileSize` + `image.width/height`, already in the
 *            media query — no extra request at all.
 *   Unleashed one ranged GET of the first few KB, whose `Content-Range` header
 *            carries the total size and whose body carries the dimensions.
 *
 * Exact byte count AND exact pixel dimensions agreeing is decisive in practice:
 * on the duplicate that prompted this, both copies were 866082 bytes at
 * 1080x1080 and Shopify's own `thumbhash` of the two was identical.
 */

import {
  HTTP_PARTIAL_CONTENT,
  IMAGE_PROBE_BYTES,
  IMAGE_PROBE_BYTES_MAX,
} from '../constants/index.js';
import { imageKey } from './imageIdentity.js';

/** JPEG frame headers carry the dimensions; these three markers only look like them. */
const JPEG_NON_FRAME_MARKERS = new Set([0xc4, 0xc8, 0xcc]);
/** Markers with no length field, so the segment walk must step over them by hand. */
const JPEG_STANDALONE_MARKERS = new Set([0x01, 0xd8, 0xd9]);

/**
 * Pixel dimensions read from the first bytes of a PNG or JPEG.
 *
 * Deliberately header-only: the alternative is decoding the image, which would
 * mean a native dependency in an Azure Functions app for two integers.
 *
 * @param {Buffer} buffer Head of the file; a few KB is plenty.
 * @returns {{ width: number, height: number } | null}
 */
export function readImageSize(buffer) {
  if (!buffer || buffer.length < 24) return null;

  // PNG: 8-byte signature, then an IHDR whose width and height sit at 16 and 20.
  if (buffer.toString('latin1', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // JPEG: walk the segment chain until the frame header that declares the size.
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xff) {
        // Fill byte; the marker proper is the next one along.
        offset += 1;
        continue;
      }
      if (JPEG_STANDALONE_MARKERS.has(marker) || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }

      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) return null;

      if (marker >= 0xc0 && marker <= 0xcf && !JPEG_NON_FRAME_MARKERS.has(marker)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }

  return null;
}

/**
 * Total file size behind a ranged reply. `Content-Range: bytes 0-4095/866082`
 * gives it away without the rest of the file ever being sent.
 *
 * @param {Response} response
 * @param {Buffer} buffer
 * @returns {number | null}
 */
export function totalBytesOf(response, buffer) {
  const contentRange = response.headers?.get?.('content-range');
  if (contentRange) {
    const total = Number(contentRange.split('/')[1]);
    if (Number.isFinite(total) && total > 0) return total;
  }

  // The CDN ignored the range and sent the whole file, so what arrived IS the file.
  if (response.status !== HTTP_PARTIAL_CONTENT && buffer.length > 0) return buffer.length;

  return null;
}

/**
 * Fingerprint of an image behind a URL, without downloading it.
 *
 * Returns null rather than throwing on anything unexpected: a fingerprint that
 * cannot be taken must degrade to the old filename-only behaviour, never cost a
 * product its images.
 *
 * @param {string} url
 * @param {{ log?: object, fetchImpl?: Function }} [options]
 * @returns {Promise<{ bytes: number, width: number, height: number } | null>}
 */
export async function fetchImageFingerprint(url, { log, fetchImpl = fetch } = {}) {
  const read = async (probeBytes) => {
    const response = await fetchImpl(url, {
      headers: { Range: `bytes=0-${probeBytes - 1}` },
    });
    if (!response.ok) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    return { bytes: totalBytesOf(response, buffer), size: readImageSize(buffer) };
  };

  try {
    let head = await read(IMAGE_PROBE_BYTES);
    if (!head) return null;

    // A JPEG with a big ICC or EXIF block keeps its frame header well past 4 KB.
    // Failing here used to mean no fingerprint and therefore a duplicate upload,
    // so it is worth one more request before giving up.
    if (head.bytes && !head.size && head.bytes > IMAGE_PROBE_BYTES) {
      log?.info?.(`${url}: dimensions not in the first ${IMAGE_PROBE_BYTES} bytes, re-probing`);
      head = (await read(IMAGE_PROBE_BYTES_MAX)) ?? head;
    }

    if (!head.bytes || !head.size) {
      log?.warn?.(`could not read dimensions for ${url}; it will be treated as a new image`);
      return null;
    }

    return { bytes: head.bytes, width: head.size.width, height: head.size.height };
  } catch (error) {
    log?.warn?.(`could not fingerprint ${url} — ${error.message}`);
    return null;
  }
}

/**
 * Fingerprint of a Shopify media node, from fields the media query already asks
 * for. Costs nothing beyond the query that was happening anyway.
 *
 * @param {object} media
 * @returns {{ bytes: number, width: number, height: number, thumbhash: string | null } | null}
 */
export function shopifyFingerprint(media) {
  const bytes = Number(media?.originalSource?.fileSize);
  const width = Number(media?.image?.width);
  const height = Number(media?.image?.height);

  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  if (!Number.isFinite(width) || width <= 0) return null;
  if (!Number.isFinite(height) || height <= 0) return null;

  return { bytes, width, height, thumbhash: media?.image?.thumbhash ?? null };
}

/**
 * True when two fingerprints describe the same picture.
 *
 * Both the byte count and both dimensions must agree. Either alone is far too
 * weak — a store full of 1080x1080 product shots makes dimensions meaningless on
 * their own, which is exactly why a dimensions-only sweep of this catalogue
 * flagged whole photoshoots as duplicates of each other.
 *
 * A missing fingerprint never matches, so anything unmeasured falls back to
 * uploading, which is the pre-existing behaviour.
 *
 * @param {object | null} a
 * @param {object | null} b
 */
export function isSameContent(a, b) {
  if (!a || !b) return false;
  return a.bytes === b.bytes && a.width === b.width && a.height === b.height;
}

/**
 * Grouping key for media already in Shopify, where both sides carry a thumbhash
 * — Shopify's own perceptual digest of the picture. Available only here, since
 * an image still sitting in Unleashed has never been given one.
 *
 * @param {object} fingerprint
 */
export function contentKey(fingerprint) {
  return [
    fingerprint.bytes,
    `${fingerprint.width}x${fingerprint.height}`,
    fingerprint.thumbhash ?? '',
  ].join('|');
}

/**
 * Fingerprints a set of Unleashed images, keyed the same way media identity is
 * keyed elsewhere so a plan can look them up by image.
 *
 * Images that cannot be measured are simply absent from the map.
 *
 * @param {Array<{ url: string }>} images
 * @param {{ log?: object, fetchImpl?: Function }} [options]
 * @returns {Promise<Map<string, object>>}
 */
export async function fingerprintImages(images, options = {}) {
  const entries = await Promise.all(
    images.map(async (image) => [imageKey(image.url), await fetchImageFingerprint(image.url, options)]),
  );
  return new Map(entries.filter(([, fingerprint]) => fingerprint !== null));
}
