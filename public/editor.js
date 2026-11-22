(function () {
  const steps = document.getElementById('steps'), tpl = document.getElementById('tpl'), form = document.getElementById('guideform');
  if (!steps || !tpl || !form) return;
  const btn = form.querySelector('button[type=submit]'), label = btn.textContent;
  let n = 1000;
  const renumber = () => [...steps.children].forEach((el, i) => { el.querySelector('.num').textContent = 'Étape ' + (i + 1); });
  const preview = (input, box) => {
    box.innerHTML = '';
    [...input.files].forEach(f => {
      const v = f.type.indexOf('video') === 0, el = document.createElement(v ? 'video' : 'img');
      el.src = URL.createObjectURL(f);
      if (v) { el.muted = true; el.preload = 'metadata'; }
      box.appendChild(el);
    });
  };
  document.getElementById('addstep').onclick = () => {
    const d = document.createElement('div');
    d.innerHTML = tpl.innerHTML.split('__K__').join('n' + (++n)).trim();
    steps.appendChild(d.firstElementChild); renumber();
    steps.lastElementChild.querySelector('textarea').focus();
  };
  steps.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const el = b.closest('.step-edit'), a = b.dataset.act;
    if (a === 'del') { if (confirm('Supprimer cette étape ?')) el.remove(); }
    else if (a === 'up' && el.previousElementSibling) steps.insertBefore(el, el.previousElementSibling);
    else if (a === 'down' && el.nextElementSibling) steps.insertBefore(el.nextElementSibling, el);
    renumber();
  });
  steps.addEventListener('change', e => {
    const t = e.target; if (t.type !== 'file') return;
    const drop = t.closest('.drop');
    if (t.name.indexOf('f_') === 0) {
      const box = drop.querySelector('.fnames'); box.innerHTML = '';
      [...t.files].forEach(f => { const li = document.createElement('div'); li.textContent = f.name + ' (' + Math.max(1, Math.round(f.size / 1024)) + ' Ko)'; box.appendChild(li); });
    } else preview(t, drop.querySelector('.previews'));
  });
  const cover = form.querySelector('input[name=cover]');
  if (cover) cover.addEventListener('change', () => preview(cover, document.getElementById('coverpreview')));
  form.addEventListener('submit', () => {
    document.getElementById('order').value = [...steps.children].map(el => el.dataset.key).join(',');
    btn.disabled = true; btn.textContent = 'Envoi en cours…';
  });
  window.addEventListener('pageshow', () => { btn.disabled = false; btn.textContent = label; });
  renumber();
})();
