/**
 * Deciding whether a Shopify media item *is* a given Unleashed image.
 *
 * Shopify re-hosts every image on its own CDN, so URLs can never be compared
 * directly. What survives the round trip is the filename: Shopify keeps the
 * original basename and, on collision, appends `_<uuid>` before the extension.
 *
 * Observed on this store — an Unleashed image
 *   https://unlappcdn.../80f09d43-44ad-404a-ad55-02c99f9b7388.png
 * lands as
 *   https://cdn.shopify.com/.../80f09d43-44ad-404a-ad55-02c99f9b7388_8b9a1258-4642-4d45-b3b6-f2af015f7d05.png?v=1769662214
 *
 * That is what lets a first run ADOPT the image Unleashed's own connector
 * already pushed, instead of uploading a duplicate alongside it.
 */

/**
 * Filename of a URL, without query string or extension, normalised so that
 * Shopify's filename sanitising can't cause a false mismatch.
 *
 * @param {string} url
 * @returns {string}
 */
export function imageKey(url) {
  if (!url) return '';

  let pathname = String(url);
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = String(url).split('?')[0];
  }

  let basename = decodeURIComponent(pathname.split('/').filter(Boolean).pop() ?? '');
  const dot = basename.lastIndexOf('.');
  if (dot > 0) basename = basename.slice(0, dot);

  return basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * True when a Shopify media URL represents the given Unleashed image.
 *
 * @param {string} shopifyUrl Shopify CDN URL of existing media.
 * @param {string} unleashedUrl `Images[].Url` from Unleashed.
 */
export function isSameImage(shopifyUrl, unleashedUrl) {
  const target = imageKey(unleashedUrl);
  if (!target) return false;

  const candidate = imageKey(shopifyUrl);
  if (!candidate) return false;

  return candidate === target || candidate.startsWith(`${target}_`);
}

/**
 * Unleashed images in the order they should appear in Shopify: the default
 * image first, everything else in the order Unleashed returned, capped.
 *
 * @param {Array<{ Url?: string, IsDefault?: boolean }>} images
 * @param {number} max
 * @returns {Array<{ url: string, isDefault: boolean }>}
 */
export function orderedUnleashedImages(images, max) {
  const usable = (images ?? [])
    .filter((image) => typeof image?.Url === 'string' && image.Url.trim() !== '')
    .map((image, index) => ({
      url: image.Url.trim(),
      isDefault: image.IsDefault === true,
      index,
    }));

  // Stable: default first, original Unleashed order otherwise.
  usable.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.index - b.index;
  });

  const seen = new Set();
  const unique = [];
  for (const image of usable) {
    const key = imageKey(image.url);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ url: image.url, isDefault: image.isDefault });
  }

  return unique.slice(0, max);
}
