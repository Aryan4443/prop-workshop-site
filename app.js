(function () {
  const CFG = window.WORKSHOP_CONFIG;
  const sb = supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
  const store = sb.storage.from(CFG.bucket);

  const STATUS = {
    queued: 'Queued', building: 'Building', review: 'Review', changes: 'Changes asked',
    approved: 'Approved', lowpoly: 'Low-poly', done: 'Done'
  };
  const OUTPUT = { files: 'model files', unity: 'Unity asset (developer step)', vr: 'Unity, grabbable in VR (developer step)' };
  const OUTPUT_HINT = {
    files: 'Made automatically. You get the FBX, GLB and texture, ready to import into Unity yourself.',
    unity: 'The model files are made automatically. The Unity material and prefab are made by the developer, so that step waits for their approval.',
    vr: 'The model files are made automatically. The Unity prefab with physics and grab is made by the developer, so that step waits for their approval.'
  };
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let me = null;
  let requests = [];
  let selected = null;
  let shown = null;
  let channel = null;

  // ---------- sign-in ----------
  const isAllowed = (email) => (email || '').toLowerCase().endsWith('@' + CFG.emailDomain);

  // Sign in with a code typed from the email. Links get used up by CSULB's email link scanner.
  let sending = false;
  $('signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sending) return;
    const email = $('email').value.trim();
    const msg = $('signin-msg');
    if (!isAllowed(email)) { msg.className = 'msg err'; msg.textContent = 'Use your @' + CFG.emailDomain + ' email.'; return; }
    sending = true;
    $('signin-btn').disabled = true;
    msg.className = 'msg'; msg.textContent = 'Sending…';
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    sending = false;
    if (error) {
      msg.className = 'msg err';
      msg.textContent = error.status === 429
        ? 'Too many sign-in emails were sent recently. If you already have a code, enter it below; otherwise wait a few minutes and try again.'
        : 'Could not send the code: ' + error.message;
      if (error.status === 429) showCodeForm();
      setTimeout(() => { $('signin-btn').disabled = false; }, 60000);
      return;
    }
    msg.textContent = 'Code sent to ' + email + '. Check your inbox (and junk folder).';
    setTimeout(() => { $('signin-btn').disabled = false; }, 60000);
    showCodeForm();
  });
  function showCodeForm() {
    $('signin-form').hidden = true;
    $('code-form').hidden = false;
    $('code').focus();
  }
  $('code-back').addEventListener('click', () => {
    $('code-form').hidden = true; $('signin-form').hidden = false; $('signin-msg').textContent = '';
  });
  $('code-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('signin-msg');
    $('code-btn').disabled = true;
    msg.className = 'msg'; msg.textContent = 'Checking…';
    const { error } = await sb.auth.verifyOtp({ email: $('email').value.trim(), token: $('code').value.trim(), type: 'email' });
    $('code-btn').disabled = false;
    if (error) { msg.className = 'msg err'; msg.textContent = 'That code did not work: ' + error.message + '. Check for typos, or request a new code.'; return; }
    msg.textContent = '';
  });
  $('signout').addEventListener('click', () => sb.auth.signOut());

  sb.auth.onAuthStateChange((_event, session) => setUser(session ? session.user : null));

  function setUser(user) {
    const same = me && user && me.id === user.id;
    me = user;
    if (user && !isAllowed(user.email)) {
      $('signin').hidden = false; $('app').hidden = true; $('account').hidden = true;
      $('signin-msg').className = 'msg err';
      $('signin-msg').textContent = 'The workshop is only for @' + CFG.emailDomain + ' accounts. Signed out.';
      sb.auth.signOut();
      return;
    }
    $('signin').hidden = !!user;
    $('app').hidden = !user;
    $('account').hidden = !user;
    if (!user) { if (channel) { sb.removeChannel(channel); channel = null; } return; }
    $('who').textContent = user.email;
    if (!same) startQueue();
  }

  // ---------- files ----------
  const urlCache = new Map();
  async function signedUrls(paths) {
    const now = Date.now();
    const need = [...new Set(paths.filter(p => p && !(urlCache.has(p) && urlCache.get(p).until > now)))];
    if (need.length) {
      const { data } = await store.createSignedUrls(need, 3600);
      (data || []).forEach(d => { if (d.signedUrl) urlCache.set(d.path, { url: d.signedUrl, until: now + 50 * 60 * 1000 }); });
    }
    const out = {};
    paths.forEach(p => { if (p && urlCache.has(p)) out[p] = urlCache.get(p).url; });
    return out;
  }

  // ---------- queue ----------
  async function loadRequests() {
    const { data, error } = await sb.from('requests').select('*').order('created_at', { ascending: false });
    if (error) { $('q-empty').hidden = false; $('q-empty').textContent = 'Could not load the queue: ' + error.message; return; }
    requests = data || [];
    if (!selected && requests.length) selected = requests[0].id;
    await renderQueue();
    const cur = JSON.stringify(requests.find(x => x.id === selected) || null);
    if (cur !== shown) { shown = cur; renderDetail(); }
  }

  function startQueue() {
    loadRequests();
    if (channel) sb.removeChannel(channel);
    channel = sb.channel('requests-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'requests' }, () => loadRequests())
      .subscribe();
  }

  function chip(status) { return el('span', 'chip s-' + status, STATUS[status] || status); }
  function when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  const shortName = (email) => (email || 'Someone').split('@')[0];

  async function renderQueue() {
    const list = $('queue');
    $('q-empty').hidden = requests.length > 0;
    if (!requests.length) $('q-empty').textContent = 'No requests yet. Send the first one with the form above.';
    const urls = await signedUrls(requests.map(r => (r.photo_paths || [])[0]));
    list.textContent = '';
    for (const r of requests) {
      const li = el('li');
      const b = el('button');
      b.type = 'button';
      b.setAttribute('aria-current', String(r.id === selected));
      const cover = urls[(r.photo_paths || [])[0]];
      if (cover) { const img = el('img'); img.alt = ''; img.src = cover; b.appendChild(img); } else b.appendChild(el('span', 'ph'));
      const mid = el('span');
      mid.style.minWidth = '0';
      mid.appendChild(el('div', 't', r.name || 'Untitled'));
      mid.appendChild(el('div', 'm', shortName(r.requester_email) + ' · ' + when(r.created_at)));
      b.appendChild(mid);
      b.appendChild(chip(r.status || 'queued'));
      b.addEventListener('click', () => { selected = r.id; shown = JSON.stringify(r); renderQueue(); renderDetail(); });
      li.appendChild(b);
      list.appendChild(li);
    }
  }

  // ---------- detail ----------
  async function renderDetail() {
    const box = $('detail');
    const r = requests.find(x => x.id === selected);
    if (!r) return;
    const versions = (r.versions || []).slice().sort((a, b) => b.n - a.n);
    const preview = versions.find(v => v.preview_path);
    const paths = [...(r.photo_paths || []), r.scan && r.scan.path, r.glb_path, preview && preview.preview_path, ...versions.map(v => v.sheet_path)];
    const urls = await signedUrls(paths);
    box.textContent = '';

    const head = el('div', 'detail-head');
    head.appendChild(el('h2', null, r.name || 'Untitled'));
    head.appendChild(chip(r.status || 'queued'));
    box.appendChild(head);

    const facts = el('p', 'facts');
    const s = r.size_mm || {};
    const size = [s.w, s.d, s.h].every(v => v) ? s.w + ' × ' + s.d + ' × ' + s.h + ' mm' : 'to estimate';
    for (const [k, v] of [['From', shortName(r.requester_email)], ['Size', size], ['Project', r.project || '—'], ['Needs', OUTPUT[r.output] || 'model files'], ['Aged', r.aged ? 'yes' : 'no']]) {
      const sp = el('span', null, k + ' ');
      sp.appendChild(el('b', null, v));
      facts.appendChild(sp);
    }
    box.appendChild(facts);
    if (r.notes) box.appendChild(el('p', 'notes', r.notes));

    if (r.status === 'done' && (r.model_paths || []).length) {
      box.appendChild(el('h3', null, 'Download'));
      const dl = el('div', 'downloads');
      for (const m of r.model_paths) {
        const b = el('button', 'ghost', m.name);
        b.type = 'button';
        b.addEventListener('click', async () => {
          b.disabled = true;
          const { data, error } = await store.createSignedUrl(m.path, 600, { download: m.name });
          b.disabled = false;
          if (!error) location.href = data.signedUrl;
        });
        dl.appendChild(b);
      }
      box.appendChild(dl);
      if (r.developer_step === 'waiting') box.appendChild(el('p', 'empty', 'The Unity prefab is waiting for the developer.'));
    }

    box.appendChild(el('h3', null, 'Photos'));
    const photos = el('div', 'photos');
    (r.photo_paths || []).forEach((p, i, all) => {
      if (!urls[p]) return;
      const label = 'Photo ' + (i + 1) + ' of ' + all.length + ' · ' + (r.name || 'Untitled');
      const img = el('img'); img.src = urls[p]; img.alt = 'Reference photo of ' + (r.name || 'the object');
      photos.appendChild(zoomable(img, urls[p], label));
    });
    box.appendChild(photos);

    if (r.scan && r.scan.path) {
      box.appendChild(el('h3', null, '3D scan'));
      if (r.scan.format === 'glb' && urls[r.scan.path]) {
        const sv = el('div', 'viewer');
        sv.setAttribute('role', 'img');
        sv.setAttribute('aria-label', '3D scan of ' + (r.name || 'the object') + '. Drag to turn it.');
        box.appendChild(sv);
        initViewer(sv, urls[r.scan.path]);
      }
      box.appendChild(el('p', 'facts', (r.scan.file_name || 'scan') + ' · used for exact size and shape'));
    }

    const model3d = r.glb_path && urls[r.glb_path]
      ? { url: urls[r.glb_path], title: 'Game model in 3D', note: (r.tris_lod0 ? r.tris_lod0.toLocaleString() + ' triangles · ' : '') + 'the finished low-poly model' }
      : preview && urls[preview.preview_path]
        ? { url: urls[preview.preview_path], title: '3D preview of v' + preview.n, note: 'review model, simplified for the web' }
        : null;
    if (model3d) {
      box.appendChild(el('h3', null, model3d.title));
      const v = el('div', 'viewer');
      v.setAttribute('role', 'img');
      v.setAttribute('aria-label', model3d.title + ' of ' + (r.name || 'the prop') + '. Drag to turn it.');
      box.appendChild(v);
      box.appendChild(el('p', 'facts', model3d.note + ' · drag to turn, scroll to zoom, right-drag to move'));
      initViewer(v, model3d.url);
    }

    box.appendChild(el('h3', null, 'Review sheets'));
    if (!versions.length) {
      box.appendChild(el('p', 'empty', r.status === 'queued' ? 'Waiting to be picked up. The first sheet appears here when the model is built.' : 'The first sheet appears here when the model is built.'));
    } else {
      box.appendChild(sheet(versions[0], urls));
      if (versions.length > 1) {
        const det = el('details', 'older');
        det.appendChild(el('summary', null, 'Earlier versions (' + (versions.length - 1) + ')'));
        versions.slice(1).forEach(v => det.appendChild(sheet(v, urls)));
        box.appendChild(det);
      }
    }

    const fb = r.feedback || [];
    box.appendChild(el('h3', null, 'Feedback'));
    if (fb.length) {
      const ul = el('ul', 'feedback');
      for (const f of fb) {
        const li = el('li', f.verdict);
        const who = f.by === 'claude' ? 'Claude' : shortName(f.by_email);
        li.appendChild(el('div', 'who', who + ' · ' + (f.verdict === 'approve' ? 'approved' : f.verdict === 'changes' ? 'asked for changes' : 'note') + (f.version ? ' on v' + f.version : '') + ' · ' + when(f.at)));
        if (f.text) li.appendChild(el('p', null, f.text));
        ul.appendChild(li);
      }
      box.appendChild(ul);
    } else {
      box.appendChild(el('p', 'empty', 'No feedback yet.'));
    }

    if (r.status === 'review' && me && r.requested_by === me.id) box.appendChild(reviewForm(r, versions[0]));
    else if (r.status === 'review') box.appendChild(el('p', 'empty', 'Waiting for ' + shortName(r.requester_email) + ' to review.'));
  }

  function sheet(v, urls) {
    const d = el('div', 'sheet');
    if (urls[v.sheet_path]) {
      const img = el('img'); img.src = urls[v.sheet_path]; img.alt = 'Review sheet v' + v.n + ': photo next to the model'; img.loading = 'lazy';
      d.appendChild(zoomable(img, urls[v.sheet_path], 'Review sheet v' + v.n));
    }
    const cap = el('div', 'cap');
    cap.appendChild(el('b', null, 'v' + v.n));
    cap.appendChild(document.createTextNode(' · ' + when(v.at) + (v.note ? ' · ' + v.note : '')));
    d.appendChild(cap);
    return d;
  }

  function reviewForm(r, latest) {
    const f = el('form');
    const lab = el('label', null, 'Your review of v' + (latest ? latest.n : '?'));
    lab.htmlFor = 'rv-text';
    const ta = el('textarea'); ta.id = 'rv-text'; ta.maxLength = 2000;
    ta.placeholder = 'What should change? Be specific: colour, shape, size, wear.';
    lab.appendChild(ta);
    f.appendChild(lab);
    const row = el('div', 'row');
    const ok = el('button', null, 'Approve'); ok.type = 'button';
    const ch = el('button', 'ghost', 'Ask for changes'); ch.type = 'button';
    row.append(ok, ch);
    f.appendChild(row);
    const msg = el('p', 'msg'); msg.setAttribute('role', 'status');
    f.appendChild(msg);
    f.addEventListener('submit', (e) => e.preventDefault());

    async function send(verdict) {
      const text = ta.value.trim();
      if (verdict === 'changes' && !text) { msg.className = 'msg err'; msg.textContent = 'Write what should change first.'; ta.focus(); return; }
      ok.disabled = ch.disabled = true;
      msg.className = 'msg'; msg.textContent = 'Saving…';
      const { error } = await sb.rpc('submit_review', { request_id: r.id, verdict, review_text: text });
      if (error) { msg.className = 'msg err'; msg.textContent = 'Could not save your review: ' + error.message; ok.disabled = ch.disabled = false; return; }
      loadRequests();
    }
    ok.addEventListener('click', () => send('approve'));
    ch.addEventListener('click', () => send('changes'));
    return f;
  }

  // ---------- new request ----------
  let photoFiles = [];
  function renderThumbs() {
    const t = $('f-thumbs'); t.textContent = '';
    photoFiles.forEach((p, i) => {
      const wrap = el('div', 'thumb');
      const img = el('img'); img.alt = 'Photo ' + (i + 1); img.src = p.url;
      const rm = el('button', 'rm', '×'); rm.type = 'button'; rm.setAttribute('aria-label', 'Remove photo ' + (i + 1));
      rm.addEventListener('click', () => { URL.revokeObjectURL(p.url); photoFiles.splice(i, 1); renderThumbs(); });
      wrap.append(img, rm); t.appendChild(wrap);
    });
    $('f-count').textContent = photoFiles.length
      ? photoFiles.length + (photoFiles.length === 1 ? ' photo. ' : ' photos. ') + 'Add more angles with Take photo, or send the request.'
      : 'No photos yet. On a phone, Take photo opens the camera; take one, then tap it again for the next angle.';
    $('f-take').textContent = photoFiles.length ? 'Take another photo' : 'Take photo';
  }
  // Phones can hand over HEIC or very large images: store a JPEG the worker can read.
  async function asStorableImage(file) {
    const okType = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
    if (okType && file.size <= 12 * 1024 * 1024) return file;
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const scale = Math.min(1, 4096 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.92));
      if (!blob) throw new Error('encode');
      return new File([blob], (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
    } catch (e) {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  async function addPhotos(list) {
    for (const f of list) {
      const ok = await asStorableImage(f);
      if (!ok) { $('f-msg').className = 'msg err'; $('f-msg').textContent = (f.name || 'A photo') + ' could not be read. Try JPEG or PNG.'; continue; }
      photoFiles.push({ file: ok, url: URL.createObjectURL(ok) });
    }
    renderThumbs();
  }
  $('f-take').addEventListener('click', () => $('f-camera').click());
  $('f-choose').addEventListener('click', () => $('f-photos').click());
  $('f-camera').addEventListener('change', async () => { await addPhotos(Array.from($('f-camera').files)); $('f-camera').value = ''; });
  $('f-photos').addEventListener('change', async () => { await addPhotos(Array.from($('f-photos').files)); $('f-photos').value = ''; });
  $('f-output').addEventListener('change', () => { $('f-output-hint').textContent = OUTPUT_HINT[$('f-output').value]; });

  $('req-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('f-msg'), btn = $('f-submit');
    const say = (t, err) => { msg.textContent = t; msg.className = err ? 'msg err' : 'msg'; };
    if (!me) { say('Sign in first.', true); return; }
    if (!photoFiles.length) { say('Add at least one photo: tap Take photo or Choose photos.', true); return; }
    const scanFile = $('f-scan').files[0] || null;
    const scanExt = scanFile ? scanFile.name.split('.').pop().toLowerCase() : null;
    if (scanFile && !['glb', 'usdz', 'obj', 'ply', 'stl'].includes(scanExt)) { say('The 3D scan must be a GLB, USDZ, OBJ, PLY or STL file.', true); return; }
    if (scanFile && scanFile.size > 50 * 1024 * 1024) { say('The 3D scan is over 50 MB. Export it again at medium quality.', true); return; }

    btn.disabled = true;
    const id = crypto.randomUUID();
    const folder = 'uploads/' + me.id + '/' + id + '/';
    try {
      const photoPaths = [];
      for (let i = 0; i < photoFiles.length; i++) {
        say('Uploading photo ' + (i + 1) + ' of ' + photoFiles.length + '…');
        const f = photoFiles[i].file;
        const ext = f.type === 'image/png' ? 'png' : f.type === 'image/webp' ? 'webp' : 'jpg';
        const path = folder + 'photo_' + String(i + 1).padStart(2, '0') + '.' + ext;
        const { error } = await store.upload(path, f, { contentType: f.type, upsert: false });
        if (error) throw error;
        photoPaths.push(path);
      }
      let scan = null;
      if (scanFile) {
        say('Uploading 3D scan…');
        const path = folder + 'scan.' + scanExt;
        const { error } = await store.upload(path, scanFile, { contentType: scanExt === 'glb' ? 'model/gltf-binary' : 'application/octet-stream' });
        if (error) throw error;
        scan = { path, format: scanExt, file_name: scanFile.name, size_bytes: scanFile.size };
      }
      say('Saving request…');
      const num = (fid) => { const v = parseInt($(fid).value, 10); return v > 0 ? v : null; };
      const { error } = await sb.from('requests').insert({
        id,
        name: $('f-name').value.trim(),
        notes: $('f-notes').value.trim(),
        project: $('f-project').value.trim(),
        output: $('f-output').value,
        aged: $('f-aged').checked,
        size_mm: { w: num('f-w'), d: num('f-d'), h: num('f-h') },
        photo_paths: photoPaths,
        scan
      });
      if (error) throw error;
      selected = id;
      $('req-form').reset(); $('f-scan').value = '';
      photoFiles.forEach(p => URL.revokeObjectURL(p.url)); photoFiles = []; renderThumbs();
      $('f-output-hint').textContent = OUTPUT_HINT.files;
      say('Request sent. It shows in the queue as Queued and is picked up within about 15 minutes.');
      loadRequests();
    } catch (err) {
      say('Could not send the request: ' + (err && err.message ? err.message : err), true);
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- zoom viewer for photos and review sheets ----------
  function zoomable(img, src, label) {
    const b = el('button', 'zoomable');
    b.type = 'button';
    b.setAttribute('aria-label', 'Open ' + label + ' full screen');
    b.appendChild(img);
    b.addEventListener('click', () => openLightbox(src, label, b));
    return b;
  }

  const lb = { box: $('lightbox'), stage: $('lb-stage'), img: $('lb-img'), scale: 1, x: 0, y: 0, fit: 1, opener: null, pointers: new Map(), pinch: null };
  const MAX_SCALE = 8;
  function lbApply() {
    lb.img.style.transform = 'translate(' + lb.x + 'px,' + lb.y + 'px) scale(' + lb.scale + ')';
    $('lb-zoom').textContent = Math.round(lb.scale * 100) + '%';
  }
  function lbFit() {
    const sw = lb.stage.clientWidth, sh = lb.stage.clientHeight;
    const iw = lb.img.naturalWidth || 1, ih = lb.img.naturalHeight || 1;
    lb.fit = Math.min(sw / iw, sh / ih, 1);
    lb.scale = lb.fit;
    lb.x = (sw - iw * lb.scale) / 2;
    lb.y = (sh - ih * lb.scale) / 2;
    lbApply();
  }
  function lbZoomAt(factor, cx, cy) {
    const next = Math.min(MAX_SCALE, Math.max(lb.fit * 0.5, lb.scale * factor));
    const k = next / lb.scale;
    lb.x = cx - (cx - lb.x) * k;
    lb.y = cy - (cy - lb.y) * k;
    lb.scale = next;
    lbApply();
  }
  const lbCenter = () => [lb.stage.clientWidth / 2, lb.stage.clientHeight / 2];
  function stagePoint(e) { const r = lb.stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  function openLightbox(src, label, opener) {
    lb.opener = opener;
    $('lb-title').textContent = label;
    lb.img.alt = label;
    lb.box.hidden = false;
    document.body.style.overflow = 'hidden';
    lb.img.onload = lbFit;
    lb.img.src = src;
    if (lb.img.complete && lb.img.naturalWidth) lbFit();
    $('lb-close').focus();
  }
  function closeLightbox() {
    lb.box.hidden = true;
    document.body.style.overflow = '';
    lb.pointers.clear(); lb.pinch = null;
    if (lb.opener && lb.opener.isConnected) lb.opener.focus();
  }
  $('lb-close').addEventListener('click', closeLightbox);
  $('lb-fit').addEventListener('click', lbFit);
  $('lb-full').addEventListener('click', () => { const [cx, cy] = lbCenter(); lbZoomAt(1 / lb.scale, cx, cy); });
  $('lb-in').addEventListener('click', () => { const [cx, cy] = lbCenter(); lbZoomAt(1.5, cx, cy); });
  $('lb-out').addEventListener('click', () => { const [cx, cy] = lbCenter(); lbZoomAt(1 / 1.5, cx, cy); });
  document.addEventListener('keydown', (e) => {
    if (lb.box.hidden) return;
    const [cx, cy] = lbCenter();
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === '+' || e.key === '=') lbZoomAt(1.5, cx, cy);
    else if (e.key === '-') lbZoomAt(1 / 1.5, cx, cy);
    else if (e.key === '0') lbFit();
  });
  lb.stage.addEventListener('wheel', (e) => { e.preventDefault(); const [cx, cy] = stagePoint(e); lbZoomAt(Math.exp(-e.deltaY * 0.0015), cx, cy); }, { passive: false });
  lb.stage.addEventListener('dblclick', (e) => { const [cx, cy] = stagePoint(e); if (lb.scale < 0.99) lbZoomAt(1 / lb.scale, cx, cy); else lbFit(); });
  lb.stage.addEventListener('pointerdown', (e) => {
    lb.stage.setPointerCapture(e.pointerId);
    lb.pointers.set(e.pointerId, stagePoint(e));
    lb.stage.classList.add('dragging');
    if (lb.pointers.size === 2) { const [a, b] = [...lb.pointers.values()]; lb.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) }; }
  });
  lb.stage.addEventListener('pointermove', (e) => {
    if (!lb.pointers.has(e.pointerId)) return;
    const prev = lb.pointers.get(e.pointerId);
    const cur = stagePoint(e);
    lb.pointers.set(e.pointerId, cur);
    if (lb.pointers.size === 2 && lb.pinch) {
      const [a, b] = [...lb.pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (lb.pinch.d > 0) lbZoomAt(d / lb.pinch.d, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      lb.pinch.d = d;
    } else if (lb.pointers.size === 1) {
      lb.x += cur[0] - prev[0]; lb.y += cur[1] - prev[1]; lbApply();
    }
  });
  const lbUp = (e) => { lb.pointers.delete(e.pointerId); if (lb.pointers.size < 2) lb.pinch = null; if (!lb.pointers.size) lb.stage.classList.remove('dragging'); };
  lb.stage.addEventListener('pointerup', lbUp);
  lb.stage.addEventListener('pointercancel', lbUp);
  window.addEventListener('resize', () => { if (!lb.box.hidden) lbFit(); });

  // ---------- 3D viewer ----------
  function initViewer(box, url) {
    if (typeof THREE === 'undefined' || !THREE.GLTFLoader) { status(box, '3D viewer could not load.'); return; }
    status(box, 'Loading model…');
    new THREE.GLTFLoader().load(url, (gltf) => {
      if (!box.isConnected) return;
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputEncoding = THREE.sRGBEncoding;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      box.appendChild(renderer.domElement);
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(getComputedStyle(box).backgroundColor);
      scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new THREE.RoomEnvironment(), 0.04).texture;
      const key = new THREE.DirectionalLight(0xffffff, 1.2); key.position.set(1, 2, 1.5); scene.add(key);
      const model = gltf.scene;
      const bb = new THREE.Box3().setFromObject(model);
      model.position.sub(bb.getCenter(new THREE.Vector3()));
      scene.add(model);
      const radius = bb.getSize(new THREE.Vector3()).length() / 2;
      const dist = radius / Math.sin(THREE.MathUtils.degToRad(17.5)) * 1.05;
      const camera = new THREE.PerspectiveCamera(35, 1, dist / 100, dist * 100);
      camera.position.set(dist * 0.45, dist * 0.35, dist * 0.82);
      const controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.enablePan = true;
      controls.minDistance = dist * 0.05; controls.maxDistance = dist * 3;
      controls.autoRotate = !reduceMotion; controls.autoRotateSpeed = 1.6;
      controls.addEventListener('start', () => { controls.autoRotate = false; });
      const resize = () => { const w = box.clientWidth, h = box.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
      new ResizeObserver(resize).observe(box); resize();
      (function loop() {
        if (!box.isConnected) { renderer.dispose(); return; }
        requestAnimationFrame(loop);
        controls.update(); renderer.render(scene, camera);
      })();
      status(box, '');
    }, undefined, (err) => status(box, 'Could not show this model (' + (err && err.message ? err.message : 'load error') + ').'));
  }
  function status(box, text) {
    let s = box.querySelector('.status');
    if (!text) { if (s) s.remove(); return; }
    if (!s) { s = el('span', 'status'); box.appendChild(s); }
    s.textContent = text;
  }

  // ---------- start ----------
  if (CFG.supabaseUrl.startsWith('PASTE')) {
    $('signin').hidden = false;
    $('signin-msg').className = 'msg err';
    $('signin-msg').textContent = 'The workshop is not connected to its database yet.';
    $('signin-btn').disabled = true;
    return;
  }
  sb.auth.getSession().then(({ data }) => setUser(data.session ? data.session.user : null));
})();
