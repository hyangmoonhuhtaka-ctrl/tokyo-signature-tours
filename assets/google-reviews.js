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
  var serverSnapshot;
  var PAGE_SIZE = 6;

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

  function retireLegacyReviewSchema() {
    var legacyId = 'https://tokyosignaturetours.com/reviews.html#guide-review-collection';
    each('script[type="application/ld+json"]', function (script) {
      var data;
      try { data = JSON.parse(script.textContent); } catch (_) { return; }
      if (!data || !Array.isArray(data['@graph'])) return;
      var graph = data['@graph'];
      var remaining = graph.filter(function (node) {
        return !node || node['@type'] !== 'ItemList' || node['@id'] !== legacyId;
      });
      if (remaining.length === graph.length) return;
      remaining.forEach(function (node) {
        if (node && node['@type'] === 'CollectionPage' && node.mainEntity && node.mainEntity['@id'] === legacyId) {
          delete node.mainEntity;
        }
      });
      data['@graph'] = remaining;
      script.textContent = JSON.stringify(data);
    });
  }

  function routeLegacyReviewHash() {
    var id;
    try { id = decodeURIComponent(window.location.hash.slice(1)); } catch (_) { return; }
    if (!id) return;
    var target = document.getElementById(id);
    if (!target || !target.closest('[data-google-review-legacy][hidden]')) return;
    var feed = document.querySelector('[data-google-review-feed]');
    if (feed && !feed.hidden) feed.scrollIntoView({ block: 'start', behavior: 'auto' });
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
      // Native disclosure keeps the complete original text readable without JavaScript.
      var details = element('details', 'tst-google-review-text');
      var summary = element('summary', 'tst-google-review-text-summary');
      summary.appendChild(element('span', 'tst-google-review-comment', review.comment));
      var toggle = element('span', 'tst-google-review-toggle');
      toggle.appendChild(element('span', 'tst-review-read', 'Read full review'));
      toggle.appendChild(element('span', 'tst-review-close', 'Show less'));
      summary.appendChild(toggle);
      details.appendChild(summary);
      card.appendChild(details);
      prepareDisclosure(details);
    } else {
      card.appendChild(element('p', 'tst-google-review-no-comment', 'This guest left a rating without a written review.'));
    }
    card.appendChild(element('p', 'tst-google-review-attribution', 'Posted on Google'));
    return card;
  }

  function prepareDisclosure(details) {
    if (details.dataset.reviewReady === 'true') return;
    details.dataset.reviewReady = 'true';
    var summary = details.querySelector('summary');
    if (!summary) return;
    function update() { summary.setAttribute('aria-expanded', details.open ? 'true' : 'false'); }
    details.addEventListener('toggle', update);
    update();
  }

  function currentPage(totalPages) {
    var raw = new URL(window.location.href).searchParams.get('page');
    var page = raw && /^[1-9]\d*$/.test(raw) ? Number(raw) : 1;
    return Math.max(1, Math.min(Number.isSafeInteger(page) ? page : 1, totalPages));
  }

  function pageUrl(page) {
    return '/reviews.html' + (page > 1 ? '?page=' + page : '') + '#google-review-feed';
  }

  function pageLink(page, label, className, current, changePage) {
    var link = element('a', className, label);
    link.href = pageUrl(page);
    link.setAttribute('aria-label', 'Review page ' + page);
    if (current) link.setAttribute('aria-current', 'page');
    link.addEventListener('click', function (event) {
      // Retain normal links for crawlers, new tabs, and browsers without History API.
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !window.history || !window.history.pushState) return;
      event.preventDefault();
      window.history.pushState(null, '', link.href);
      changePage(page, true);
    });
    return link;
  }

  function pagination(page, totalPages, changePage) {
    var nav = element('nav', 'tst-google-reviews-pagination');
    nav.setAttribute('aria-label', 'Google review pages');
    if (page > 1) {
      var previous = pageLink(page - 1, 'Previous', 'tst-google-reviews-page-step', false, changePage);
      previous.setAttribute('aria-label', 'Previous review page');
      previous.rel = 'prev';
      nav.appendChild(previous);
    } else {
      var start = element('span', 'tst-google-reviews-page-step', 'Previous');
      start.setAttribute('aria-disabled', 'true');
      nav.appendChild(start);
    }
    var pages = element('div', 'tst-google-reviews-page-numbers');
    var first = Math.max(2, page - 1);
    var last = Math.min(totalPages - 1, page + 1);
    if (page <= 2) last = Math.min(totalPages - 1, 3);
    if (page >= totalPages - 1) first = Math.max(2, totalPages - 2);
    pages.appendChild(pageLink(1, '1', 'tst-google-reviews-page-number', page === 1, changePage));
    if (first > 2) pages.appendChild(element('span', 'tst-google-reviews-page-gap', '…'));
    for (var number = first; number <= last; number++) pages.appendChild(pageLink(number, String(number), 'tst-google-reviews-page-number', page === number, changePage));
    if (last < totalPages - 1) pages.appendChild(element('span', 'tst-google-reviews-page-gap', '…'));
    if (totalPages > 1) pages.appendChild(pageLink(totalPages, String(totalPages), 'tst-google-reviews-page-number', page === totalPages, changePage));
    nav.appendChild(pages);
    if (page < totalPages) {
      var next = pageLink(page + 1, 'Next', 'tst-google-reviews-page-step', false, changePage);
      next.setAttribute('aria-label', 'Next review page');
      next.rel = 'next';
      nav.appendChild(next);
    } else {
      var end = element('span', 'tst-google-reviews-page-step', 'Next');
      end.setAttribute('aria-disabled', 'true');
      nav.appendChild(end);
    }
    return nav;
  }

  function renderFeed(container, data) {
    container.replaceChildren();
    container.hidden = false;
    container.classList.add('tst-google-reviews');
    var meta = element('div', 'tst-google-reviews-meta');
    meta.appendChild(element('p', 'tst-google-reviews-order', 'Latest guest reviews'));
    meta.appendChild(sourceLink(data.sourceUrl, 'View on Google'));
    container.appendChild(meta);
    if (!data.reviews.length) {
      container.appendChild(element('p', 'tst-google-reviews-empty', 'There are no Google reviews to display yet.'));
      return;
    }
    var cap = Number(container.dataset.reviewLimit);
    var limited = Number.isInteger(cap) && cap > 0;
    var reviews = limited ? data.reviews.slice(0, Math.min(cap, 3)) : data.reviews;
    var totalPages = Math.ceil(reviews.length / PAGE_SIZE);
    var range = element('p', 'tst-google-reviews-range');
    range.setAttribute('role', 'status');
    range.setAttribute('aria-live', 'polite');
    if (!limited) container.appendChild(range);
    var grid = element('div', 'tst-google-reviews-grid');
    container.appendChild(grid);
    var nav;
    function showPage(page, focusFirst) {
      grid.replaceChildren();
      var first;
      var start = limited ? 0 : (page - 1) * PAGE_SIZE;
      var end = Math.min(start + (limited ? reviews.length : PAGE_SIZE), reviews.length);
      for (var index = start; index < end; index++) {
        var card = reviewCard(reviews[index]);
        if (!first) first = card;
        grid.appendChild(card);
      }
      range.textContent = 'Reviews ' + (start + 1) + '–' + end + ' of ' + data.count + ' · newest first';
      if (nav) nav.remove();
      if (!limited && totalPages > 1) { nav = pagination(page, totalPages, showPage); container.appendChild(nav); }
      if (focusFirst && first) {
        first.setAttribute('tabindex', '-1');
        first.focus({ preventScroll: true });
        container.scrollIntoView({ block: 'start', behavior: 'auto' });
      }
    }
    showPage(limited ? 1 : currentPage(totalPages), false);
    if (limited && data.reviews.length > reviews.length) {
      var all = element('a', 'tst-google-reviews-more', 'See all ' + data.count + ' reviews');
      all.href = pageUrl(1);
      container.appendChild(all);
    }
  }

  function renderUnavailable() {
    serverSnapshot = null;
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

  function expireAt(value) {
    window.clearTimeout(expiryTimer);
    expiryTimer = window.setTimeout(function () { renderUnavailable(); refresh(); }, Math.max(0, Date.parse(value) - Date.now()));
  }

  function prepareServerContent() {
    each('.tst-google-review-text', prepareDisclosure);
    var marker = document.querySelector('[data-review-rendered="true"]');
    if (!marker) return false;
    var checked = timestamp(marker.dataset.reviewFetchedAt);
    var expires = timestamp(marker.dataset.reviewExpiresAt);
    var now = Date.now();
    if (!Number.isFinite(checked) || !Number.isFinite(expires) || checked > now + 5 * 60 * 1000 || expires <= now || expires <= checked || expires - checked > MAX_AGE || now - checked > MAX_AGE) {
      renderUnavailable();
      return false;
    }
    serverSnapshot = { fetchedAt: marker.dataset.reviewFetchedAt, expiresAt: marker.dataset.reviewExpiresAt };
    expireAt(serverSnapshot.expiresAt);
    return true;
  }

  function render(data) {
    serverSnapshot = null;
    updateSummary(data);
    each('[data-google-review-feed]', function (container) { renderFeed(container, data); });
    updateStatus(data);
    expireAt(data.expiresAt);
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
      var available = snapshot || serverSnapshot;
      if (!available || Date.parse(available.expiresAt) <= Date.now()) renderUnavailable();
      else status('Last successful Google check: ' + formattedDate(available.fetchedAt, false) + '. The next update is delayed; see Google for the current reviews.');
    } finally {
      pending = false;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(refresh, HOUR);
    }
  }

  async function start() {
    var sourceAnchor = document.querySelector('[data-google-review-link]');
    defaultSource = sourceAnchor ? googleUrl(sourceAnchor.getAttribute('href')) : null;
    var hasServerContent = prepareServerContent();
    var settings;
    try { settings = await fetchJson('/assets/google-reviews-config.json', 8192); } catch (_) { return; }
    // A disabled or missing config preserves the dated, manually checked HTML exactly.
    if (!settings || settings.enabled !== true || typeof settings.endpoint !== 'string') return;
    try {
      var endpoint = new URL(settings.endpoint, window.location.href);
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) return;
      config = { endpoint: endpoint.href };
    } catch (_) { return; }
    hideLegacy();
    retireLegacyReviewSchema();
    if (!hasServerContent) {
      updateSummary(null);
      status('Checking Google reviews…');
    }
    await refresh();
    routeLegacyReviewHash();
    window.addEventListener('hashchange', routeLegacyReviewHash);
    window.addEventListener('popstate', function () {
      if (!snapshot || Date.parse(snapshot.expiresAt) <= Date.now()) return;
      each('[data-google-review-feed]', function (container) {
        if (!container.dataset.reviewLimit) renderFeed(container, snapshot);
      });
    });
    if (document.readyState !== 'complete') window.addEventListener('load', routeLegacyReviewHash, { once: true });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      var available = snapshot || serverSnapshot;
      if (available && Date.parse(available.expiresAt) <= Date.now()) renderUnavailable();
      if (Date.now() - lastAttempt >= HOUR) refresh();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})(window, document);
