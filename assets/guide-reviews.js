/* Native scrolling remains available without JavaScript. No automatic rotation. */
(() => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  document.querySelectorAll('[data-review-carousel]').forEach(carousel => {
    const track = carousel.querySelector('.guide-review-track');
    const cards = Array.from(track.children);
    const actions = carousel.querySelector('.guide-review-actions');
    const previous = carousel.querySelector('.guide-review-prev');
    const next = carousel.querySelector('.guide-review-next');
    const count = carousel.querySelector('.guide-review-count');
    if (cards.length < 2) return;
    actions.hidden = false;

    const positions = () => {
      const left = track.getBoundingClientRect().left;
      return cards.map(card => card.getBoundingClientRect().left - left + track.scrollLeft);
    };
    const current = () => {
      const offsets = positions();
      return offsets.reduce((best, offset, i) =>
        Math.abs(offset - track.scrollLeft) < Math.abs(offsets[best] - track.scrollLeft) ? i : best, 0);
    };
    const visibleCount = () => {
      const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
      return Math.max(1, Math.floor((track.clientWidth + gap + 1) / (cards[0].getBoundingClientRect().width + gap)));
    };
    const update = () => {
      const box = track.getBoundingClientRect();
      const visible = cards.map((card, i) => ({i, box: card.getBoundingClientRect()}))
        .filter(item => Math.min(item.box.right, box.right) - Math.max(item.box.left, box.left) >= item.box.width * .6);
      const first = visible[0]?.i ?? current();
      const last = visible[visible.length - 1]?.i ?? first;
      const label = first === last ? `${first + 1} / ${cards.length}` : `${first + 1}–${last + 1} / ${cards.length}`;
      if (count.textContent !== label) count.textContent = label;
      previous.disabled = track.scrollLeft <= 2;
      next.disabled = track.scrollWidth - track.clientWidth - track.scrollLeft <= 2;
    };
    const go = (index, animate = true) => {
      const safeIndex = Math.max(0, Math.min(cards.length - 1, index));
      track.scrollTo({left: positions()[safeIndex], behavior: !animate || reducedMotion.matches ? 'instant' : 'smooth'});
    };
    previous.addEventListener('click', () => go(current() - visibleCount()));
    next.addEventListener('click', () => go(current() + visibleCount()));
    track.addEventListener('keydown', event => {
      if (event.target !== track) return;
      const directions = {ArrowLeft: current() - 1, ArrowRight: current() + 1, Home: 0, End: cards.length - 1};
      if (!(event.key in directions)) return;
      event.preventDefault();
      go(directions[event.key]);
    });
    let frame;
    track.addEventListener('scroll', () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    }, {passive: true});
    const reveal = (hash, animate, focus) => {
      let target;
      try { target = document.getElementById(decodeURIComponent(hash.slice(1))); } catch { return false; }
      const index = cards.findIndex(card => card === target || card.contains(target));
      if (index < 0) return false;
      if (focus) {
        cards[index].tabIndex = -1;
        cards[index].focus({preventScroll:true});
      }
      carousel.scrollIntoView({block:'start', behavior: !animate || reducedMotion.matches ? 'instant' : 'smooth'});
      go(index, animate);
      return true;
    };
    document.addEventListener('click', event => {
      const link = event.target.closest('a[href^="#"]');
      if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (reveal(link.hash, true, true)) {
        event.preventDefault();
        if (location.hash !== link.hash) history.pushState(null, '', link.hash);
      }
    });
    window.addEventListener('hashchange', () => reveal(location.hash, false, false));
    if (document.readyState === 'complete') reveal(location.hash, false, false);
    else window.addEventListener('load', () => reveal(location.hash, false, false), {once:true});
    new ResizeObserver(update).observe(track);
    update();
  });
})();
