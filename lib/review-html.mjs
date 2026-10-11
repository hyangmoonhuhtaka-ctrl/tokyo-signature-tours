import { SOURCE_URL, validateSnapshot } from './google-reviews.mjs';

export const REVIEW_PAGE_SIZE = 6;
export const REVIEW_HOME_LIMIT = 3;
const REVIEW_CANONICAL_ORIGIN = 'https://tokyosignaturetours.com';
const REVIEW_LEGACY_SCHEMA_ID = `${REVIEW_CANONICAL_ORIGIN}/reviews.html#guide-review-collection`;
const REVIEW_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function escapeReviewHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function reviewDate(value, short = false) {
  const date = new Date(value);
  const month = REVIEW_MONTHS[date.getUTCMonth()];
  return `${date.getUTCDate()} ${short ? month.slice(0, 3) : month} ${date.getUTCFullYear()}`;
}

function reviewStars(rating) {
  const filled = Math.max(0, Math.min(5, Math.round(rating)));
  return '★'.repeat(filled) + '☆'.repeat(5 - filled);
}

function reviewPageHref(page) {
  return `/reviews.html${page > 1 ? `?page=${page}` : ''}#google-review-feed`;
}

export function createReviewPageModel(raw, url, now = Date.now()) {
  const requestUrl = new URL(url);
  const isReviews = requestUrl.pathname === '/reviews.html';
  const isHome = requestUrl.pathname === '/' || requestUrl.pathname === '/index.html';
  const pages = requestUrl.searchParams.getAll('page');
  const validPage = !isReviews || pages.length === 0 || (pages.length === 1 && /^[1-9]\d{0,5}$/.test(pages[0]));
  const page = isReviews && pages.length && validPage ? Number(pages[0]) : 1;
  let snapshot = null;
  try { snapshot = validateSnapshot(raw, now); } catch { /* An unavailable/expired snapshot is never rendered. */ }
  if (snapshot) snapshot.reviews.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const totalPages = snapshot ? Math.max(1, Math.ceil(snapshot.count / REVIEW_PAGE_SIZE)) : null;
  const status = !validPage || (snapshot && isReviews && page > totalPages) ? 404 : (!snapshot && isReviews && page > 1 ? 503 : 200);
  const canonicalPath = isHome ? '/' : requestUrl.pathname;
  const canonical = `${REVIEW_CANONICAL_ORIGIN}${canonicalPath}${isReviews && page > 1 && status !== 404 ? `?page=${page}` : ''}`;
  return { snapshot, isReviews, isHome, page, totalPages, status, canonical, pageSize: REVIEW_PAGE_SIZE };
}

function reviewSourceLink(label = 'View on Google') {
  return `<a class="tst-google-reviews-link" href="${escapeReviewHtml(SOURCE_URL)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

function renderReviewCard(review) {
  const modified = Date.parse(review.updatedAt) !== Date.parse(review.createdAt);
  const comment = review.comment.trim() ?
    `<details class="tst-google-review-text"><summary class="tst-google-review-text-summary"><span class="tst-google-review-comment">${escapeReviewHtml(review.comment)}</span><span class="tst-google-review-toggle"><span class="tst-review-read">Read full review</span><span class="tst-review-close">Show less</span></span></summary></details>` :
    '<p class="tst-google-review-no-comment">This guest left a rating without a written review.</p>';
  return `<article class="tst-google-review-card"><header class="tst-google-review-card-header"><h3 class="tst-google-review-author">${escapeReviewHtml(review.author)}</h3><span class="tst-google-review-stars" role="img" aria-label="${review.rating} out of 5 stars">${reviewStars(review.rating)}</span></header><time class="tst-google-review-date" datetime="${escapeReviewHtml(review.updatedAt)}">${modified ? 'Updated' : 'Published'} ${reviewDate(review.updatedAt, true)}</time>${comment}<p class="tst-google-review-attribution">Posted on Google</p></article>`;
}

function renderReviewPagination(page, totalPages) {
  const link = (number, label, className, attrs = '') => `<a class="${className}" href="${reviewPageHref(number)}"${attrs}>${label}</a>`;
  let first = Math.max(2, page - 1);
  let last = Math.min(totalPages - 1, page + 1);
  if (page <= 2) last = Math.min(totalPages - 1, 3);
  if (page >= totalPages - 1) first = Math.max(2, totalPages - 2);
  const pageLink = number => link(number, number, 'tst-google-reviews-page-number', ` aria-label="Review page ${number}"${number === page ? ' aria-current="page"' : ''}`);
  let numbers = pageLink(1);
  if (first > 2) numbers += '<span class="tst-google-reviews-page-gap">…</span>';
  for (let number = first; number <= last; number++) numbers += pageLink(number);
  if (last < totalPages - 1) numbers += '<span class="tst-google-reviews-page-gap">…</span>';
  if (totalPages > 1) numbers += pageLink(totalPages);
  const previous = page > 1 ? link(page - 1, 'Previous', 'tst-google-reviews-page-step', ' rel="prev" aria-label="Previous review page"') : '<span class="tst-google-reviews-page-step" aria-disabled="true">Previous</span>';
  const next = page < totalPages ? link(page + 1, 'Next', 'tst-google-reviews-page-step', ' rel="next" aria-label="Next review page"') : '<span class="tst-google-reviews-page-step" aria-disabled="true">Next</span>';
  return `<nav class="tst-google-reviews-pagination" aria-label="Google review pages">${previous}<div class="tst-google-reviews-page-numbers">${numbers}</div>${next}</nav>`;
}

export function renderReviewFeed(model) {
  if (model.status === 404) return '<p class="tst-google-reviews-unavailable">This review page does not exist.</p><a class="tst-google-reviews-more" href="/reviews.html#google-review-feed">Go to the first review page</a>';
  const data = model.snapshot;
  if (!data) return `<p class="tst-google-reviews-unavailable">Google reviews are temporarily unavailable here.</p>${reviewSourceLink('See the current reviews on Google')}`;
  let html = `<div class="tst-google-reviews-meta"><p class="tst-google-reviews-order">Latest guest reviews</p>${reviewSourceLink()}</div>`;
  if (!data.count) return html + '<p class="tst-google-reviews-empty">There are no Google reviews to display yet.</p>';
  const start = model.isHome ? 0 : (model.page - 1) * REVIEW_PAGE_SIZE;
  const end = Math.min(start + (model.isHome ? REVIEW_HOME_LIMIT : REVIEW_PAGE_SIZE), data.count);
  if (!model.isHome) html += `<p class="tst-google-reviews-range" role="status" aria-live="polite">Reviews ${start + 1}–${end} of ${data.count} · newest first</p>`;
  html += `<div class="tst-google-reviews-grid">${data.reviews.slice(start, end).map(renderReviewCard).join('')}</div>`;
  if (model.isHome && data.count > REVIEW_HOME_LIMIT) html += `<a class="tst-google-reviews-more" href="${reviewPageHref(1)}">See all ${data.count} reviews</a>`;
  if (!model.isHome && model.totalPages > 1) html += renderReviewPagination(model.page, model.totalPages);
  return html;
}

export function retireReviewSchema(text, model) {
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data?.['@graph'])) return text;
    data['@graph'] = data['@graph'].filter(node => node?.['@id'] !== REVIEW_LEGACY_SCHEMA_ID);
    for (const node of data['@graph']) {
      if (node?.mainEntity?.['@id'] === REVIEW_LEGACY_SCHEMA_ID) delete node.mainEntity;
      if (model.isReviews && node?.['@type'] === 'CollectionPage') {
        node.url = model.canonical;
        if (model.snapshot) node.dateModified = model.snapshot.fetchedAt;
      }
    }
    return JSON.stringify(data).replace(/</g, '\\u003c');
  } catch { return text.includes(REVIEW_LEGACY_SCHEMA_ID) ? '{}' : text; }
}

// Cloudflare's native streaming parser edits only explicit review markers.
// Pricing, navigation and unrelated page content are retained from the origin.
export function rewriteReviewPage(response, model, { HTMLRewriterImpl = globalThis.HTMLRewriter, preview = false } = {}) {
  if (typeof HTMLRewriterImpl !== 'function') throw new Error('HTML rewriting unavailable');
  const data = model.snapshot;
  const hasRating = data && data.count > 0;
  const score = hasRating ? data.rating.toFixed(1) : '—';
  const updated = data ? reviewDate(data.fetchedAt) : '';
  const setText = value => ({ element(element) { element.setInnerContent(value); } });
  const mark = element => {
    element.setAttribute('data-review-rendered', 'true');
    if (data) {
      element.setAttribute('data-review-fetched-at', data.fetchedAt);
      element.setAttribute('data-review-expires-at', data.expiresAt);
    } else {
      element.removeAttribute('data-review-fetched-at');
      element.removeAttribute('data-review-expires-at');
    }
    element.setAttribute('data-review-page', String(model.page));
    element.setAttribute('data-review-page-size', String(REVIEW_PAGE_SIZE));
  };
  let schemaText = '';
  const rewriter = new HTMLRewriterImpl()
    .on('body', { element: mark })
    .on('[data-google-review-legacy]', { element(element) { element.remove(); } })
    .on('[data-google-review-feed]', { element(element) {
      mark(element);
      element.setAttribute('id', 'google-review-feed');
      element.removeAttribute('hidden');
      element.setAttribute('class', `${element.getAttribute('class') || ''} tst-google-reviews`.trim());
      if (model.isHome) element.setAttribute('data-review-limit', String(REVIEW_HOME_LIMIT));
      element.setInnerContent(renderReviewFeed(model), { html: true });
    } })
    .on('[data-google-rating-score]', setText(score))
    .on('[data-google-review-count]', setText(data ? String(data.count) : '—'))
    .on('[data-google-review-count-label]', setText(data ? `${data.count} ${data.count === 1 ? 'review' : 'reviews'}` : 'View reviews on Google'))
    .on('[data-google-review-checked]', { element(element) {
      element.setInnerContent(data ? reviewDate(data.fetchedAt, element.getAttribute('data-date-format') === 'short') : 'unavailable');
      if (data) element.setAttribute('datetime', data.fetchedAt); else element.removeAttribute('datetime');
    } })
    .on('[data-google-review-check-note]', setText(data ? `Google rating checked on ${updated}.` : 'See the current rating and reviews on Google.'))
    .on('[data-google-review-summary]', setText(data ? `${hasRating ? `${score} on Google` : 'No Google reviews yet'} · checked ${reviewDate(data.fetchedAt, true)}` : 'Google reviews'))
    .on('[data-google-rating-stars], [data-google-review-summary-stars]', { element(element) {
      element.setInnerContent(hasRating ? reviewStars(data.rating) : '');
      element.setAttribute('role', 'img');
      element.setAttribute('aria-label', hasRating ? `${score} out of 5 stars` : 'Rating unavailable');
      if (hasRating) element.removeAttribute('hidden'); else element.setAttribute('hidden', '');
    } })
    .on('[data-google-review-link]', { element(element) {
      element.setAttribute('href', SOURCE_URL);
      element.setAttribute('aria-label', data ? `${hasRating ? `Rated ${score} on Google with ` : ''}${data.count} reviews, checked on ${updated}. View reviews on Google Maps.` : 'View the current Tokyo Signature Tours reviews on Google Maps.');
    } })
    .on('[data-google-review-status]', { element(element) {
      element.removeAttribute('hidden');
      element.setInnerContent(data ? `${data.status === 'stale' ? 'Last successful Google check' : 'Checked on Google'}: ${updated}. Reviews sync daily.${data.status === 'stale' ? ' The next update is delayed; see Google for the current reviews.' : ''}` : 'Please check Google for the current rating and reviews.');
    } })
    .on('link[rel="canonical"]', { element(element) { element.setAttribute('href', model.canonical); } })
    .on('meta[property="og:url"]', { element(element) { element.setAttribute('content', model.canonical); } })
    .on('script[type="application/ld+json"]', {
      element(element) { schemaText = ''; element.onEndTag(tag => tag.before(retireReviewSchema(schemaText, model), { html: true })); },
      text(chunk) { schemaText += chunk.text; chunk.remove(); },
    });
  const headers = new Headers(response.headers);
  for (const name of ['Content-Length', 'Content-Encoding', 'ETag', 'Last-Modified', 'Set-Cookie', 'Age']) headers.delete(name);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (preview || model.status !== 200) headers.set('X-Robots-Tag', 'noindex');
  if (model.status === 503) headers.set('Retry-After', '300');
  return rewriter.transform(new Response(response.body, { status: model.status, headers }));
}
