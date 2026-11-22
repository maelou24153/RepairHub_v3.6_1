document.addEventListener('click', e => {
  const lb = document.getElementById('lb'), z = e.target.closest('img.zoom');
  if (z && lb) { lb.querySelector('img').src = z.src; lb.hidden = false; }
  else if (lb && e.target.closest('#lb')) lb.hidden = true;
  const c = e.target.closest('[data-copy]');
  if (c && navigator.clipboard) navigator.clipboard.writeText(location.href).then(() => { c.textContent = 'Lien copié'; });
  if (e.target.closest('[data-print]')) window.print();
});
// Barre du bas (téléphone) : met en avant la rubrique en cours
(function () {
  const p = location.pathname;
  document.querySelectorAll('.tabbar a').forEach(a => {
    const keys = a.dataset.tab.split(','), on = keys.some(k => k === '/' ? p === '/' : p.indexOf(k) === 0);
    if (on) a.classList.add('on');
  });
})();
document.addEventListener('click', e => document.querySelectorAll('details.menu[open]').forEach(d => { if (!d.contains(e.target)) d.removeAttribute('open'); }));
document.addEventListener('keydown', e => { const lb = document.getElementById('lb'); if (e.key === 'Escape') { if (lb) lb.hidden = true; document.querySelectorAll('details.menu[open]').forEach(d => d.removeAttribute('open')); } });
