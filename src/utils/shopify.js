import {
  DUPLICATE_SCAN_MAX_PAGES,
  DUPLICATE_SCAN_MEDIA_SIZE,
  DUPLICATE_SCAN_PAGE_SIZE,
  MEDIA_CONTENT_TYPE,
  MEDIA_PAGE_SIZE,
  RETRY,
  SHOPIFY_API_VERSION,
  SHOPIFY_BULK_MAX_PAGES,
  SHOPIFY_BULK_PAGE_SIZE,
  SHOPIFY_THROTTLED_CODE,
  SHOPIFY_TOKEN_HEADER,
  STATE_METAFIELD,
} from '../constants/index.js';
import { fetchWithRetry, sleep } from './http.js';

const FIND_PRODUCT_BY_SKU = /* GraphQL */ `
  query FindProductBySku($q: String!) {
    productVariants(first: 10, query: $q) {
      nodes {
        id
        sku
        product {
          id
          title
        }
      }
    }
  }
`;

/**
 * Every variant SKU in the store, for the weekly audit. Reading the whole set
 * once and diffing in memory costs ~25 requests; asking Shopify per Unleashed
 * product would cost thousands and could not finish inside a function timeout.
 */
const ALL_VARIANT_SKUS = /* GraphQL */ `
  query AllVariantSkus($first: Int!, $after: String) {
    productVariants(first: $first, after: $after) {
      nodes {
        sku
        product {
          id
          title
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/**
 * `originalSource.fileSize` and `image.width/height` are what let the sync tell
 * that a hand-uploaded image IS one of Unleashed's, when the filenames cannot.
 * They are free here — no extra request, no image ever downloaded.
 */
const MEDIA_IMAGE_FIELDS = /* GraphQL */ `
  ... on MediaImage {
    mimeType
    originalSource {
      fileSize
    }
    image {
      url
      width
      height
      thumbhash
    }
  }
`;

const PRODUCT_MEDIA = /* GraphQL */ `
  query ProductMedia($id: ID!, $first: Int!) {
    product(id: $id) {
      id
      title
      media(first: $first) {
        nodes {
          id
          mediaContentType
          status
          alt
          mediaErrors {
            code
            details
            message
          }
          ${MEDIA_IMAGE_FIELDS}
        }
      }
      metafield(namespace: "${STATE_METAFIELD.NAMESPACE}", key: "${STATE_METAFIELD.KEY}") {
        id
        value
        type
      }
    }
  }
`;

/**
 * Every product's media plus its sync state, for the store-wide duplicate scan.
 * Paged rather than fetched per product: asking product by product would be
 * thousands of requests for a question that is one sweep.
 */
const ALL_PRODUCT_MEDIA = /* GraphQL */ `
  query AllProductMedia($first: Int!, $after: String, $media: Int!) {
    products(first: $first, after: $after) {
      nodes {
        id
        title
        media(first: $media) {
          nodes {
            id
            status
            ${MEDIA_IMAGE_FIELDS}
          }
        }
        metafield(namespace: "${STATE_METAFIELD.NAMESPACE}", key: "${STATE_METAFIELD.KEY}") {
          id
          value
          type
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const ADD_MEDIA = /* GraphQL */ `
  mutation AddMedia($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
    productUpdate(product: $product, media: $media) {
      product {
        id
        media(first: ${MEDIA_PAGE_SIZE}) {
          nodes {
            id
            status
            mediaErrors {
              code
              details
              message
            }
            ... on MediaImage {
              image {
                url
              }
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const DETACH_MEDIA = /* GraphQL */ `
  mutation DetachMedia($files: [FileUpdateInput!]!) {
    fileUpdate(files: $files) {
      files {
        id
        fileStatus
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const REORDER_MEDIA = /* GraphQL */ `
  mutation ReorderMedia($id: ID!, $moves: [MoveInput!]!) {
    productReorderMedia(id: $id, moves: $moves) {
      job {
        id
        done
      }
      mediaUserErrors {
        field
        message
        code
      }
    }
  }
`;

const SET_METAFIELD = /* GraphQL */ `
  mutation SetState($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

/**
 * @param {{ shopify: { storeDomain: string, adminToken: string } }} config
 * @param {{ info?: Function, warn?: Function, error?: Function }} [log]
 */
export function createShopifyClient(config, log = console) {
  const { storeDomain, adminToken } = config.shopify;
  const endpoint = `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  /**
   * Runs an operation, retrying cost-throttled responses. Shopify reports
   * throttling as HTTP 200 with an errors array, so it needs handling here
   * rather than in the transport layer.
   */
  async function graphql(query, variables = {}, { label = 'graphql' } = {}) {
    for (let attempt = 1; attempt <= RETRY.MAX_ATTEMPTS; attempt += 1) {
      const response = await fetchWithRetry(
        () =>
          fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              [SHOPIFY_TOKEN_HEADER]: adminToken,
            },
            body: JSON.stringify({ query, variables }),
          }),
        { label: `shopify ${label}`, log },
      );

      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Shopify ${label} failed: HTTP ${response.status} ${text.slice(0, 500)}`);
      }

      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`Shopify ${label} returned non-JSON: ${text.slice(0, 200)}`);
      }

      const throttled = payload.errors?.some(
        (error) => error?.extensions?.code === SHOPIFY_THROTTLED_CODE,
      );
      if (throttled && attempt < RETRY.MAX_ATTEMPTS) {
        const delay = Math.min(RETRY.BASE_DELAY_MS * 2 ** attempt, RETRY.MAX_DELAY_MS);
        log.warn?.(`shopify ${label}: throttled, retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }

      if (payload.errors?.length) {
        throw new Error(
          `Shopify ${label} returned errors: ${JSON.stringify(payload.errors).slice(0, 500)}`,
        );
      }

      return payload.data;
    }

    throw new Error(`Shopify ${label}: still throttled after ${RETRY.MAX_ATTEMPTS} attempts`);
  }

  function assertNoUserErrors(label, userErrors) {
    if (userErrors?.length) {
      throw new Error(`Shopify ${label}: ${JSON.stringify(userErrors)}`);
    }
  }

  /**
   * Resolves an Unleashed product code to a Shopify product via variant SKU.
   * Shopify's search is not strictly exact, so matches are re-checked here.
   *
   * @param {string} productCode
   * @returns {Promise<{ products: Array<{ id: string, title: string }>, variantIds: string[] }>}
   */
  async function findProductsBySku(productCode) {
    const escaped = productCode.replace(/["\\]/g, '\\$&');
    const data = await graphql(
      FIND_PRODUCT_BY_SKU,
      { q: `sku:"${escaped}"` },
      { label: 'findProductsBySku' },
    );

    const wanted = productCode.trim().toLowerCase();
    const matches = (data?.productVariants?.nodes ?? []).filter(
      (node) => String(node?.sku ?? '').trim().toLowerCase() === wanted,
    );

    const byId = new Map();
    for (const match of matches) {
      if (match.product?.id) byId.set(match.product.id, match.product);
    }

    return { products: [...byId.values()], variantIds: matches.map((m) => m.id) };
  }

  /**
   * Every non-empty variant SKU in the store, lowercased, mapped to its product.
   *
   * @param {{ pageSize?: number, maxPages?: number }} [options]
   * @returns {Promise<Map<string, { productId: string, title: string }>>}
   */
  async function listAllVariantSkus({
    pageSize = SHOPIFY_BULK_PAGE_SIZE,
    maxPages = SHOPIFY_BULK_MAX_PAGES,
  } = {}) {
    const skus = new Map();
    let after = null;
    let pages = 0;

    for (;;) {
      const data = await graphql(
        ALL_VARIANT_SKUS,
        { first: pageSize, after },
        { label: 'listAllVariantSkus' },
      );

      const connection = data?.productVariants;
      for (const node of connection?.nodes ?? []) {
        const sku = String(node?.sku ?? '').trim().toLowerCase();
        if (!sku) continue;

        const productId = node.product?.id ?? null;
        const existing = skus.get(sku);
        if (!existing) {
          skus.set(sku, { productId, title: node.product?.title ?? '', productCount: 1 });
        } else if (existing.productId !== productId) {
          // One SKU on two different products is a data fault the sync reports
          // as `ambiguous` and refuses to act on, so the audit surfaces it.
          existing.productCount += 1;
        }
      }

      pages += 1;
      if (!connection?.pageInfo?.hasNextPage) break;
      if (pages >= maxPages) {
        log.warn?.(
          `listAllVariantSkus: stopped at ${pages} pages (${skus.size} SKUs); ` +
            'the audit would under-report, raise SHOPIFY_BULK_MAX_PAGES.',
        );
        return skus;
      }
      after = connection.pageInfo.endCursor;
    }

    log.info?.(`listAllVariantSkus: ${skus.size} SKUs across ${pages} page(s)`);
    return skus;
  }

  /**
   * Yields every product in the store with its media and sync state, one page at
   * a time so a large catalogue never has to be held in memory at once.
   *
   * @param {{ pageSize?: number, mediaPageSize?: number, maxPages?: number }} [options]
   */
  async function* iterateProductsWithMedia({
    pageSize = DUPLICATE_SCAN_PAGE_SIZE,
    mediaPageSize = DUPLICATE_SCAN_MEDIA_SIZE,
    maxPages = DUPLICATE_SCAN_MAX_PAGES,
  } = {}) {
    let after = null;
    let pages = 0;

    for (;;) {
      const data = await graphql(
        ALL_PRODUCT_MEDIA,
        { first: pageSize, after, media: mediaPageSize },
        { label: 'iterateProductsWithMedia' },
      );

      const connection = data?.products;
      yield { products: connection?.nodes ?? [], pageNumber: pages + 1 };

      pages += 1;
      if (!connection?.pageInfo?.hasNextPage) return;
      if (pages >= maxPages) {
        log.warn?.(
          `iterateProductsWithMedia: stopped at ${pages} pages — the scan is incomplete, ` +
            'raise DUPLICATE_SCAN_MAX_PAGES.',
        );
        return;
      }
      after = connection.pageInfo.endCursor;
    }
  }

  /**
   * @param {string} productId
   * @returns {Promise<{ id: string, title: string, media: object[], stateMetafield: object | null }>}
   */
  async function getProduct(productId) {
    const data = await graphql(
      PRODUCT_MEDIA,
      { id: productId, first: MEDIA_PAGE_SIZE },
      { label: 'getProduct' },
    );
    const product = data?.product;
    if (!product) throw new Error(`Shopify product not found: ${productId}`);

    return {
      id: product.id,
      title: product.title,
      media: product.media?.nodes ?? [],
      stateMetafield: product.metafield ?? null,
    };
  }

  /**
   * Appends ONE image and returns the media it created.
   *
   * One image per call on purpose: Shopify re-hosts the file and does not echo
   * the source URL back, so uploading singly is the only way to know which
   * media id belongs to which Unleashed image. It also stops one bad URL from
   * failing the whole batch.
   *
   * @param {{ productId: string, url: string, alt?: string, knownMediaIds: Set<string> }} input
   * @returns {Promise<{ media: object | null, allMedia: object[] }>}
   */
  async function appendImage({ productId, url, alt, knownMediaIds }) {
    const data = await graphql(
      ADD_MEDIA,
      {
        product: { id: productId },
        media: [{ originalSource: url, alt: alt ?? '', mediaContentType: MEDIA_CONTENT_TYPE.IMAGE }],
      },
      { label: 'appendImage' },
    );

    assertNoUserErrors('productUpdate', data?.productUpdate?.userErrors);

    const allMedia = data?.productUpdate?.product?.media?.nodes ?? [];
    const created = allMedia.filter((node) => !knownMediaIds.has(node.id));

    if (created.length !== 1) {
      log.warn?.(
        `appendImage: expected 1 new media for ${url}, saw ${created.length}. ` +
          'Another process may be writing to this product at the same time.',
      );
    }

    return { media: created[0] ?? null, allMedia };
  }

  /**
   * Detaches media from a product without deleting the underlying file.
   * A MediaImage id doubles as its File id.
   *
   * @param {{ productId: string, mediaIds: string[] }} input
   */
  async function detachMedia({ productId, mediaIds }) {
    if (mediaIds.length === 0) return [];
    const data = await graphql(
      DETACH_MEDIA,
      { files: mediaIds.map((id) => ({ id, referencesToRemove: [productId] })) },
      { label: 'detachMedia' },
    );
    assertNoUserErrors('fileUpdate', data?.fileUpdate?.userErrors);
    return data?.fileUpdate?.files ?? [];
  }

  /**
   * @param {{ productId: string, orderedMediaIds: string[] }} input
   */
  async function reorderMedia({ productId, orderedMediaIds }) {
    if (orderedMediaIds.length === 0) return null;
    const data = await graphql(
      REORDER_MEDIA,
      {
        id: productId,
        moves: orderedMediaIds.map((id, position) => ({ id, newPosition: String(position) })),
      },
      { label: 'reorderMedia' },
    );
    assertNoUserErrors('productReorderMedia', data?.productReorderMedia?.mediaUserErrors);
    return data?.productReorderMedia?.job ?? null;
  }

  /**
   * Persists which media this service owns, on the product itself.
   *
   * @param {{ productId: string, state: object }} input
   */
  async function saveState({ productId, state }) {
    const data = await graphql(
      SET_METAFIELD,
      {
        metafields: [
          {
            ownerId: productId,
            namespace: STATE_METAFIELD.NAMESPACE,
            key: STATE_METAFIELD.KEY,
            type: STATE_METAFIELD.TYPE,
            value: JSON.stringify(state),
          },
        ],
      },
      { label: 'saveState' },
    );
    assertNoUserErrors('metafieldsSet', data?.metafieldsSet?.userErrors);
    return data?.metafieldsSet?.metafields ?? [];
  }

  return {
    graphql,
    findProductsBySku,
    listAllVariantSkus,
    iterateProductsWithMedia,
    getProduct,
    appendImage,
    detachMedia,
    reorderMedia,
    saveState,
  };
}
