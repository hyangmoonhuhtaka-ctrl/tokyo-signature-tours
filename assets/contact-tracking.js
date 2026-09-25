/* Contact-link clicks only. A click is not a submitted inquiry or confirmed booking. */
(function (window, document) {
  'use strict';

  if (window.__tstContactTrackingInstalled) return;
  window.__tstContactTrackingInstalled = true;

  var locations = ['header', 'menu', 'hero', 'booking', 'contact', 'footer', 'sticky', 'body'];
  var pageTypes = {
    '/': 'home',
    '/index': 'home',
    '/tours': 'tours',
    '/private-tokyo-tour-guide': 'private_tokyo_tour_guide',
    '/about': 'about',
    '/contact': 'contact',
    '/faq': 'faq',
    '/reviews': 'reviews',
    '/terms': 'terms',
    '/legal': 'legal',
    '/privacy': 'privacy'
  };
  var selectionLinkIds = ['bookingWhatsappBtn', 'bookingEmailBtn', 'bookingInquiry', 'bookingEmail', 'bookBtn', 'stickyEmailBtn'];

  function contactMethod(link) {
    var url;
    try {
      url = new URL(link.getAttribute('href'), window.location.href);
    } catch (_) {
      return null;
    }
    if (url.protocol === 'mailto:') return 'email';
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.hostname === 'wa.me' && url.pathname !== '/') return 'whatsapp';
    if (['api.whatsapp.com', 'web.whatsapp.com', 'www.whatsapp.com', 'whatsapp.com'].indexOf(url.hostname) !== -1 && /^\/send\/?$/.test(url.pathname)) {
      return 'whatsapp';
    }
    return null;
  }

  function ctaLocation(link, pageType) {
    var explicit = link.closest('[data-cta-location]');
    var value = explicit && explicit.getAttribute('data-cta-location');
    if (locations.indexOf(value) !== -1) return value;
    if (link.closest('#stickyBuy, .sticky-buy')) return 'sticky';
    if (link.closest('#mobile-menu, .side-menu')) return 'menu';
    if (link.closest('footer, [role="contentinfo"]')) return 'footer';
    if (link.closest('header, [role="banner"]')) return 'header';
    if (link.closest('#booking, .booking-shell')) return 'booking';
    if (link.closest('.hero, .hero-actions, section.first')) return 'hero';
    if (link.closest('#contact') || pageType === 'contact') return 'contact';
    return 'body';
  }

  function numericAttribute(element, name) {
    var raw = element && element.getAttribute(name);
    if (raw === null || raw === undefined || !/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
    var value = Number(raw);
    return Number.isFinite(value) && value > 0 && value <= 100000 ? value : null;
  }

  function selectionFor(link, location) {
    if (location !== 'booking' && location !== 'sticky') return null;
    // General inquiries in the booking section (for example, 7+ guests) do not use its selected price.
    var selectionFlag = link.getAttribute('data-contact-selection');
    if (selectionFlag === 'false') return null;
    if (selectionFlag !== 'true' && selectionLinkIds.indexOf(link.getAttribute('id')) === -1) return null;
    // Price context requires an actual booking module, not merely a general inquiry bar.
    var booking = link.closest('#booking, .booking-shell');
    if (!booking && location === 'sticky') booking = document.querySelector('#booking');
    if (!booking) return null;

    var duration = numericAttribute(booking, 'data-tour-duration');
    var guests = numericAttribute(booking, 'data-group-size');
    if (duration === null) duration = numericAttribute(booking.querySelector('[data-duration][aria-pressed="true"]'), 'data-duration');
    if (guests === null) guests = numericAttribute(booking.querySelector('[data-guests][aria-pressed="true"]'), 'data-guests');
    if ([4, 6, 8].indexOf(duration) === -1 || !Number.isInteger(guests) || guests < 1 || guests > 6) return null;

    var selection = { tour_duration: duration, group_size: guests };
    var total = numericAttribute(booking, 'data-total-price-usd');
    if (total === null) {
      // Use machine-readable published prices; never inspect link queries, drafts or free text.
      var cell = document.querySelector('[data-price-duration="' + duration + '"][data-price-guests="' + guests + '"][data-price-total]');
      total = numericAttribute(cell, 'data-price-total');
    }
    if (total !== null) {
      selection.total_price_usd = total;
      selection.price_per_person_usd = Math.round((total / guests) * 100) / 100;
    }
    return selection;
  }

  function leadSource(pageType, location, method) {
    var prefix = pageType === 'home' ? '' : pageType === 'private_tokyo_tour_guide' ? 'private_guide_' : pageType + '_';
    return prefix + location + '_' + method;
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (target && typeof target.closest !== 'function') target = target.parentElement;
    var link = target && typeof target.closest === 'function' ? target.closest('a[href]') : null;
    if (!link) return;
    var method = contactMethod(link);
    if (!method) return;

    var pagePath = window.location.pathname;
    var pageKey = pagePath.replace(/\/+$/, '').replace(/\.html$/, '') || '/';
    var pageType = pageTypes[pageKey] || 'other';
    var location = ctaLocation(link, pageType);
    var payload = {
      event: 'contact_click',
      contact_method: method,
      cta_location: location,
      page_path: pagePath,
      page_type: pageType,
      lead_source: leadSource(pageType, location, method),
      // Explicit undefined values clear earlier selections in GTM's persistent data model.
      tour_duration: undefined,
      group_size: undefined,
      total_price_usd: undefined,
      price_per_person_usd: undefined
    };
    var selection = selectionFor(link, location);
    if (selection) {
      Object.keys(selection).forEach(function (key) { payload[key] = selection[key]; });
    }
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(payload);
    // Native link navigation is deliberately left untouched.
  }, true);
})(window, document);
