/* Shared Google review display. Credentials and daily synchronization stay on the server. */
(function (window, document) {
  'use strict';

  if (window.__tstGoogleReviewsInstalled) return;
  window.__tstGoogleReviewsInstalled = true;

  var HOUR = 60 * 60 * 1000;
  var MAX_AGE = 72 * HOUR;
  var MAX_BYTES = 5 * 1024 * 1024;
  var config;
  var snapshot;
  var expiryTimer;
  var refreshTimer;
  var lastAttempt = 0;
  var pending = false;
  var defaultSource = '';

  function each(selector, callback) {
    document.querySelectorAll(selector).forEach(callback);
  }

  function googleUrl(value) {
    if (typeof value !== 'string' || value.length > 8192) return null;
    try {
      var url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
      if (['maps.app.goo.gl', 'g.page', 'share.google', 'maps.google.com'].indexOf(url.hostname) !== -1) return url.href;
      if (['www.google.com', 'google.com'].indexOf(url.hostname) !== -1 && /^\/maps(?:\/|$)/.test(url.pathname)) return url.href;
    } catch (_) { /* Invalid source links are never inserted into the page. */ }
    return null;
  }

  function timestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
    return Date.parse(value);
  }

  function validate(data) {
    var now = Date.now();
    if (!data || data.version !== 1) throw new Error('Unsupported review snapshot');
    var checked = timestamp(data.fetchedAt);
    var expires = timestamp(data.expiresAt);
    if (!Number.isFinite(checked) || !Number.isFinite(expires) || checked > now + 5 * 60 * 1000 || expires <= now || expires <= checked || expires - checked > MAX_AGE || now - checked > MAX_AGE) {
      throw new Error('Expired or invalid review snapshot');
    }
    if (!Number.isSafeInteger(data.count) || data.count < 0 || data.count > 10000 || !Array.isArray(data.reviews) || data.reviews.length !== data.count) {
      throw new Error('Incomplete review snapshot');
    }
    if (data.count === 0 ? data.rating !== null && data.rating !== 0 : typeof data.rating !== 'number' || !Number.isFinite(data.rating) || data.rating < 1 || data.rating > 5) {
      throw new Error('Invalid review average');
    }
    var source = googleUrl(data.sourceUrl);
    if (!source) throw new Error('Invalid Google source');
    var ids = new Set();
    data.reviews.forEach(function (review) {
      if (!review || typeof review.id !== 'string' || !review.id.length || review.id.length > 2048 || ids.has(review.id) || typeof review.author !== 'string' || !review.author.trim() || review.author.length > 1000 || typeof review.comment !== 'string' || review.comment.length > 100000 || !Number.isInteger(review.rating) || review.rating < 1 || review.rating > 5) {
        throw new Error('Invalid review record');
      }
      var created = timestamp(review.createdAt);
      var updated = timestamp(review.updatedAt);
      if (!Number.isFinite(created) || !Number.isFinite(updated) || created > updated || updated > now + 5 * 60 * 1000) throw new Error('Invalid review date');
      ids.add(review.id);
    });
    return {
      version: 1,
      fetchedAt: data.fetchedAt,
      expiresAt: data.expiresAt,
      rating: data.count ? data.rating : null,
      count: data.count,
      sourceUrl: source,
      reviews: data.reviews.slice().sort(function (a, b) { return Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id); })
    };
  }

  function formattedDate(value, short) {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: short ? 'short' : 'long', year: 'numeric', timeZone: 'Asia/Tokyo' }).format(new Date(value));
  }

  function stars(rating) {
    var filled = Math.max(0, Math.min(5, Math.round(rating)));
    return '★'.repeat(filled) + '☆'.repeat(5 - filled);
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function sourceLink(source, label) {
    var link = element('a', 'tst-google-reviews-link', label || 'Read reviews on Google');
    link.href = source;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }

  function hideLegacy() {
    each('[data-google-review-legacy]', function (node) { node.hidden = true; });
  }

  function status(message) {
    each('[data-google-review-status]', function (node) { node.textContent = message; node.hidden = !message; });
  }

  function updateSummary(data) {
    var hasRating = data && data.count > 0;
    var score = hasRating ? data.rating.toFixed(1) : '—';
    each('[data-google-rating-score]', function (node) { node.textContent = score; });
    each('[data-google-review-count]', function (node) { node.textContent = data ? String(data.count) : '—'; });
    each('[data-google-review-count-label]', function (node) { node.textContent = data ? data.count + (data.count === 1 ? ' review' : ' reviews') : 'View reviews on Google'; });
    each('[data-google-review-checked]', function (node) {
      node.textContent = data ? formattedDate(data.fetchedAt, node.dataset.dateFormat === 'short') : 'unavailable';
      if (data) node.setAttribute('datetime', data.fetchedAt);
      else node.removeAttribute('datetime');
    });
    each('[data-google-review-check-note]', function (node) {
      node.textContent = data ? 'Google rating checked on ' + formattedDate(data.fetchedAt, false) + '.' : 'See the current rating and reviews on Google.';
    });
    each('[data-google-rating-stars], [data-google-review-summary-stars]', function (node) {
      node.textContent = hasRating ? stars(data.rating) : '';
      node.hidden = !hasRating;
      node.setAttribute('aria-label', hasRating ? score + ' out of 5 stars' : 'Rating unavailable');
      node.setAttribute('role', 'img');
    });
    each('[data-google-review-summary]', function (node) {
      node.textContent = data ? (hasRating ? score + ' on Google' : 'No Google reviews yet') + ' · checked ' + formattedDate(data.fetchedAt, true) : 'Google reviews';
    });
    each('[data-google-review-link]', function (node) {
      if (data) node.setAttribute('href', data.sourceUrl);
      node.setAttribute('aria-label', data ? (hasRating ? 'Rated ' + score + ' on Google with ' : '') + data.count + (data.count === 1 ? ' review' : ' reviews') + ', checked on ' + formattedDate(data.fetchedAt, false) + '. View reviews on Google Maps.' : 'View the current Tokyo Signature Tours reviews on Google Maps.');
    });
  }

  function reviewCard(review) {
    var card = element('article', 'tst-google-review-card');
    var header = element('header', 'tst-google-review-card-header');
    header.appendChild(element('h3', 'tst-google-review-author', review.author));
    var rating = element('span', 'tst-google-review-stars', stars(review.rating));
    rating.setAttribute('role', 'img');
    rating.setAttribute('aria-label', review.rating + ' out of 5 stars');
    header.appendChild(rating);
    card.appendChild(header);
    var modified = Date.parse(review.updatedAt) !== Date.parse(review.createdAt);
    var date = element('time', 'tst-google-review-date', (modified ? 'Updated ' : 'Published ') + formattedDate(review.updatedAt, true));
    date.setAttribute('datetime', review.updatedAt);
    card.appendChild(date);
    if (review.comment.trim()) {
      var quote = element('blockquote', 'tst-google-review-quote');
      quote.appendChild(element('p', 'tst-google-review-comment', review.comment));
      card.appendChild(quote);
    } else {
      card.appendChild(element('p', 'tst-google-review-no-comment', 'This guest left a rating without a written review.'));
    }
    card.appendChild(element('p', 'tst-google-review-attribution', 'Posted on Google'));
    return card;
  }

  function renderFeed(container, data) {
    container.replaceChildren();
    container.hidden = false;
    container.classList.add('tst-google-reviews');
    var meta = element('div', 'tst-google-reviews-meta');
    meta.appendChild(element('p', 'tst-google-reviews-order', 'Most recently updated on Google'));
    meta.appendChild(sourceLink(data.sourceUrl, 'View Tokyo Signature Tours on Google'));
    container.appendChild(meta);
    if (!data.reviews.length) {
      container.appendChild(element('p', 'tst-google-reviews-empty', 'There are no Google reviews to display yet.'));
      return;
    }
    var grid = element('div', 'tst-google-reviews-grid');
    container.appendChild(grid);
    var cap = Number(container.dataset.reviewLimit);
    var limited = Number.isInteger(cap) && cap > 0;
    var reviews = limited ? data.reviews.slice(0, Math.min(cap, 100)) : data.reviews;
    var shown = 0;
    var more;
    function appendPage(focusFirst) {
      var first;
      var end = Math.min(shown + (limited ? reviews.length : 12), reviews.length);
      while (shown < end) {
        var card = reviewCard(reviews[shown++]);
        if (!first) first = card;
        grid.appendChild(card);
      }
      if (more) {
        more.hidden = shown >= reviews.length;
        more.textContent = 'Show more reviews (' + (reviews.length - shown) + ' remaining)';
      }
      if (focusFirst && first) {
        first.setAttribute('tabindex', '-1');
        first.focus({ preventScroll: true });
      }
    }
    appendPage(false);
    if (limited && data.reviews.length > reviews.length) {
      var all = element('a', 'tst-google-reviews-more', 'Read all Google reviews');
      all.href = '/reviews.html';
      container.appendChild(all);
    } else if (!limited && shown < reviews.length) {
      more = element('button', 'tst-google-reviews-more', 'Show more reviews (' + (reviews.length - shown) + ' remaining)');
      more.type = 'button';
      more.addEventListener('click', function () { appendPage(true); });
      container.appendChild(more);
    }
  }

  function renderUnavailable() {
    updateSummary(null);
    each('[data-google-review-feed]', function (container) {
      container.replaceChildren();
      container.hidden = false;
      container.classList.add('tst-google-reviews');
      container.appendChild(element('p', 'tst-google-reviews-unavailable', 'Google reviews are temporarily unavailable here.'));
      var source = snapshot ? snapshot.sourceUrl : defaultSource;
      if (source) container.appendChild(sourceLink(source, 'See the current reviews on Google'));
    });
    status(snapshot ? 'Last successful Google check: ' + formattedDate(snapshot.fetchedAt, false) + '. Please check Google for the current reviews.' : 'Please check Google for the current rating and reviews.');
  }

  function updateStatus(data) {
    var stale = Date.now() - Date.parse(data.fetchedAt) > 36 * HOUR;
    status((stale ? 'Last successful Google check: ' : 'Checked on Google: ') + formattedDate(data.fetchedAt, false) + '. Reviews sync daily.' + (stale ? ' The next update is delayed; see Google for the current reviews.' : ''));
  }

  function render(data) {
    updateSummary(data);
    each('[data-google-review-feed]', function (container) { renderFeed(container, data); });
    updateStatus(data);
    window.clearTimeout(expiryTimer);
    expiryTimer = window.setTimeout(function () { renderUnavailable(); refresh(); }, Math.max(0, Date.parse(data.expiresAt) - Date.now()));
  }

  async function fetchJson(url, maxBytes) {
    var controller = new AbortController();
    var timeout = window.setTimeout(function () { controller.abort(); }, 15000);
    try {
      var response = await window.fetch(url, { credentials: 'omit', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('Review request failed');
      var contentLength = Number(response.headers.get('content-length'));
      if (contentLength > maxBytes) throw new Error('Review response too large');
      var text;
      if (response.body && response.body.getReader) {
        var reader = response.body.getReader();
        var chunks = [];
        var total = 0;
        while (true) {
          var part = await reader.read();
          if (part.done) break;
          total += part.value.byteLength;
          if (total > maxBytes) { await reader.cancel(); throw new Error('Review response too large'); }
          chunks.push(part.value);
        }
        var bytes = new Uint8Array(total);
        var position = 0;
        chunks.forEach(function (chunk) { bytes.set(chunk, position); position += chunk.byteLength; });
        text = new TextDecoder().decode(bytes);
      } else {
        text = await response.text();
        if (text.length > maxBytes) throw new Error('Review response too large');
      }
      return JSON.parse(text);
    } finally { window.clearTimeout(timeout); }
  }

  async function refresh() {
    if (pending || !config) return;
    pending = true;
    lastAttempt = Date.now();
    try {
      var next = validate(await fetchJson(config.endpoint, MAX_BYTES));
      var changed = !snapshot || next.fetchedAt !== snapshot.fetchedAt;
      snapshot = next;
      if (changed) render(snapshot);
      else updateStatus(snapshot);
    } catch (_) {
      if (!snapshot || Date.parse(snapshot.expiresAt) <= Date.now()) renderUnavailable();
      else status('Last successful Google check: ' + formattedDate(snapshot.fetchedAt, false) + '. The next update is delayed; see Google for the current reviews.');
    } finally {
      pending = false;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(refresh, HOUR);
    }
  }

  async function start() {
    var settings;
    try { settings = await fetchJson('/assets/google-reviews-config.json', 8192); } catch (_) { return; }
    // A disabled or missing config preserves the dated, manually checked HTML exactly.
    if (!settings || settings.enabled !== true || typeof settings.endpoint !== 'string') return;
    try {
      var endpoint = new URL(settings.endpoint, window.location.href);
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) return;
      config = { endpoint: endpoint.href };
    } catch (_) { return; }
    var sourceAnchor = document.querySelector('[data-google-review-link]');
    defaultSource = sourceAnchor ? googleUrl(sourceAnchor.getAttribute('href')) : null;
    hideLegacy();
    updateSummary(null);
    status('Checking Google reviews…');
    await refresh();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (snapshot && Date.parse(snapshot.expiresAt) <= Date.now()) renderUnavailable();
      if (Date.now() - lastAttempt >= HOUR) refresh();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})(window, document);
