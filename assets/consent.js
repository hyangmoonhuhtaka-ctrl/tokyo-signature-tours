/* Optional Google Analytics: Basic Consent Mode. No Google tag loads before opt-in. */
(function (window, document) {
  'use strict';
  if (window.TSTConsent) return;

  var STORAGE_KEY = 'tst_analytics_consent_v1';
  var VERSION = 1;
  var MAX_AGE = 180 * 24 * 60 * 60 * 1000;
  var production = window.location.hostname === 'tokyosignaturetours.com';
  // Legal and payment-status pages expose settings without adding analytics to those pages.
  var analyticsPage = !!document.querySelector('script[data-tst-analytics-page="true"]');
  var measurementId = 'G-2P5MT76792';
  var choice = null;
  var loaded = false;
  var panel;
  var status;
  var previousFocus;
  var expiryTimer;

  function validRecord(raw) {
    try {
      var record = JSON.parse(raw);
      if (!record || record.version !== VERSION ||
          ['granted', 'denied'].indexOf(record.analytics) === -1 ||
          typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt) ||
          record.expiresAt <= Date.now() || record.expiresAt > Date.now() + MAX_AGE) return null;
      return record;
    } catch (_) { return null; }
  }

  function readChoice() {
    try { return validRecord(window.localStorage.getItem(STORAGE_KEY)); }
    catch (_) { return null; }
  }

  function isAllowed() {
    return !!(choice && choice.analytics === 'granted' && choice.expiresAt > Date.now());
  }

  function consentCommand(type, analytics) {
    if (!production) return;
    window.dataLayer = window.dataLayer || [];
    function gtag() { window.dataLayer.push(arguments); }
    gtag('consent', type, {
      analytics_storage: analytics,
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied'
    });
  }

  function deleteAnalyticsCookies() {
    if (!production) return;
    document.cookie.split(';').forEach(function (part) {
      var name = part.trim().split('=')[0];
      if (!/^(_ga(?:_|$)|_gid$|_gat(?:_|$))/.test(name)) return;
      ['', '; Domain=tokyosignaturetours.com', '; Domain=.tokyosignaturetours.com'].forEach(function (domain) {
        document.cookie = name + '=; Max-Age=0; Path=/; SameSite=Lax; Secure' + domain;
      });
    });
  }

  function loadAnalytics() {
    if (!production || !analyticsPage || !isAllowed()) return;
    window['ga-disable-' + measurementId] = false;
    consentCommand('update', 'granted');
    if (loaded) return;
    loaded = true;
    window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
    var script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtm.js?id=GTM-KP5FS3V4';
    document.head.appendChild(script);
  }

  function stopAnalytics(reload) {
    if (!production) return;
    // Stop GA collection immediately; reloading removes already-installed GTM listeners.
    window['ga-disable-' + measurementId] = true;
    consentCommand('update', 'denied');
    deleteAnalyticsCookies();
    if (loaded && reload !== false) window.location.reload();
  }

  function watchExpiry() {
    window.clearTimeout(expiryTimer);
    if (!choice) return;
    expiryTimer = window.setTimeout(function () {
      if (choice && choice.expiresAt <= Date.now()) {
        choice = null;
        stopAnalytics();
        if (!loaded) openSettings();
      } else { watchExpiry(); }
    }, Math.min(Math.max(choice.expiresAt - Date.now(), 1), 2147483647));
  }

  function closeSettings() {
    if (typeof panel.close === 'function') panel.close();
    else panel.removeAttribute('open');
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
  }

  function choose(analytics) {
    var record = { version: VERSION, analytics: analytics, expiresAt: Date.now() + MAX_AGE };
    var stored = false;
    try {
      var serialized = JSON.stringify(record);
      window.localStorage.setItem(STORAGE_KEY, serialized);
      stored = window.localStorage.getItem(STORAGE_KEY) === serialized;
    } catch (_) { /* A storage failure never enables collection. */ }
    if (!stored) {
      choice = null;
      // A failed save must not reload into a previously stored grant.
      try { window.localStorage.removeItem(STORAGE_KEY); } catch (_) { /* Fail closed in this document. */ }
      stopAnalytics(false);
      status.textContent = 'Your browser could not save this choice. Google Analytics is off on this page. To keep it off on future visits, allow this website to save your preference or clear its site data in your browser.';
      return;
    }
    choice = record;
    watchExpiry();
    if (analytics === 'granted') loadAnalytics();
    else stopAnalytics();
    closeSettings();
  }

  function openSettings() {
    if (!panel) return;
    previousFocus = document.activeElement;
    status.textContent = 'Current setting: Google Analytics ' + (isAllowed() ? 'on.' : 'off.');
    if (!panel.open) {
      if (typeof panel.showModal === 'function') panel.showModal();
      else panel.setAttribute('open', '');
    }
    panel.querySelector('[data-tst-reject]').focus();
  }

  function installControls() {
    panel = document.createElement('dialog');
    panel.id = 'tst-analytics-dialog';
    panel.className = 'tst-consent-dialog';
    panel.setAttribute('aria-labelledby', 'tst-consent-title');
    panel.setAttribute('aria-describedby', 'tst-consent-description');
    panel.innerHTML = '<h2 id="tst-consent-title">Optional analytics</h2>' +
      '<p id="tst-consent-description">With your permission, we use Google Analytics to understand how visitors use this website and improve it. Analytics is off until you accept. Your choice does not affect tour inquiries or bookings.</p>' +
      '<p>We remember your choice on this browser for 180 days. You can change it anytime using Analytics settings in the footer. <a href="/privacy.html">Privacy Policy</a></p>' +
      '<p class="tst-consent-status" role="status" aria-live="polite"></p>' +
      '<div class="tst-consent-actions"><button type="button" data-tst-reject>Reject analytics</button><button type="button" data-tst-accept>Accept analytics</button></div>' +
      '<button type="button" class="tst-consent-close" data-tst-close>Close settings</button>';
    document.body.appendChild(panel);
    status = panel.querySelector('.tst-consent-status');
    panel.querySelector('[data-tst-reject]').addEventListener('click', function () { choose('denied'); });
    panel.querySelector('[data-tst-accept]').addEventListener('click', function () { choose('granted'); });
    panel.querySelector('[data-tst-close]').addEventListener('click', closeSettings);
    document.querySelectorAll('[data-tst-consent-settings]').forEach(function (button) {
      button.hidden = false;
      button.addEventListener('click', openSettings);
    });
    if (!choice && analyticsPage) openSettings();
    installInstagramControls();
  }

  function installInstagramControls() {
    document.querySelectorAll('[data-tst-instagram-load]').forEach(function (button) {
      button.hidden = false;
      button.addEventListener('click', function () {
        if (button.disabled) return;
        button.disabled = true;
        var message = document.getElementById(button.getAttribute('aria-describedby'));
        if (message) message.textContent = 'Loading Instagram content...';
        var script = document.createElement('script');
        script.async = true;
        script.src = 'https://www.instagram.com/embed.js';
        script.onload = function () {
          button.textContent = 'Instagram content loaded';
          if (message) message.textContent = 'This embedded post is provided by Instagram (Meta).';
        };
        script.onerror = function () {
          button.disabled = false;
          if (message) message.textContent = 'The post could not load. You can try again or use the Instagram link.';
          script.remove();
        };
        document.body.appendChild(script);
      });
    });
  }

  window.TSTConsent = { isAnalyticsAllowed: isAllowed, openSettings: openSettings };
  // These defaults are queued before GTM can load, including when a saved choice exists.
  consentCommand('default', 'denied');
  choice = readChoice();
  if (isAllowed()) loadAnalytics();
  else {
    if (production) window['ga-disable-' + measurementId] = true;
    deleteAnalyticsCookies();
  }
  watchExpiry();
  window.addEventListener('storage', function (event) {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    choice = readChoice();
    watchExpiry();
    if (isAllowed()) loadAnalytics();
    else stopAnalytics();
  });
  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    choice = readChoice();
    watchExpiry();
    if (isAllowed()) loadAnalytics();
    else stopAnalytics();
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installControls, { once: true });
  else installControls();
})(window, document);
