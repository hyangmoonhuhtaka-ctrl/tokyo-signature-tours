(function () {
  'use strict';

  // Keep every answer in the HTML. Search is an optional enhancement.
  const normalize = (value) => value.normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

  document.querySelectorAll('[data-faq-root]').forEach((root) => {
    const form = root.querySelector('[data-faq-search]');
    const input = root.querySelector('[data-faq-input]');
    const clear = root.querySelector('[data-faq-clear]');
    const count = root.querySelector('[data-faq-count]');
    const empty = root.querySelector('[data-faq-empty]');
    const items = Array.from(root.querySelectorAll('[data-faq-item]'));
    if (!form || !input || !clear || !count || !empty || !items.length) return;

    const searchable = items.map((item) => normalize(item.textContent));
    let savedOpenStates = null;

    const filter = () => {
      const query = normalize(input.value);
      const tokens = query ? query.split(/\s+/) : [];
      if (tokens.length && !savedOpenStates) {
        savedOpenStates = items.map((item) => item.open);
      }
      let matches = 0;
      items.forEach((item, index) => {
        const matchesQuery = tokens.every((token) => searchable[index].includes(token));
        item.hidden = !matchesQuery;
        if (matchesQuery) matches += 1;
        if (item.tagName === 'DETAILS') {
          if (tokens.length) item.open = matchesQuery;
          else if (savedOpenStates) item.open = savedOpenStates[index];
        }
      });
      if (!tokens.length) savedOpenStates = null;
      count.textContent = tokens.length
        ? `${matches} of ${items.length} questions match your search.`
        : `Showing all ${items.length} questions.`;
      empty.hidden = matches !== 0;
      clear.disabled = !input.value;
    };

    const clearSearch = () => {
      input.value = '';
      filter();
      input.focus();
    };

    input.addEventListener('input', filter);
    input.addEventListener('search', filter);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && input.value) {
        event.preventDefault();
        clearSearch();
      }
    });
    clear.addEventListener('click', clearSearch);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      filter();
    });
    form.addEventListener('reset', (event) => {
      event.preventDefault();
      clearSearch();
    });

    // Shared links to individual answers also work after a search.
    const openLinkedAnswer = () => {
      let id;
      try { id = decodeURIComponent(window.location.hash.slice(1)); }
      catch (_) { return; }
      const target = items.find((item) => item.id === id);
      if (!target) return;
      input.value = '';
      filter();
      if (target.tagName === 'DETAILS') target.open = true;
    };
    window.addEventListener('hashchange', openLinkedAnswer);
    filter();
    openLinkedAnswer();
    form.hidden = false;
    count.hidden = false;
  });
})();
