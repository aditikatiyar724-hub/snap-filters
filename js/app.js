(() => {
  const $ = (id) => document.getElementById(id);

  const els = {
    cameraScreen: $('cameraScreen'),
    stage: $('stage'),
    preview: $('preview'),
    flash: $('flash'),
    carousel: $('carousel'),
    ring: document.querySelector('.shutter-ring'),
    recProgress: document.querySelector('.rec-progress circle'),
    recTimer: $('recTimer'),
    recTime: $('recTime'),
    openGallery: $('openGallery'),
    notice: $('notice'),
    noticeText: $('noticeText'),
    retryCamera: $('retryCamera'),
    uploadInput: $('uploadInput'),
    galleryScreen: $('galleryScreen'),
    closeGallery: $('closeGallery'),
    grid: $('grid'),
    empty: $('empty'),
    viewer: $('viewer'),
    closeViewer: $('closeViewer'),
    viewerImg: $('viewerImg'),
    viewerVideo: $('viewerVideo'),
    viewerTitle: $('viewerTitle'),
    saveSnap: $('saveSnap'),
    shareSnap: $('shareSnap'),
    deleteSnap: $('deleteSnap'),
    intensityRange: $('intensityRange'),
    intensityValue: $('intensityValue'),
    filterName: $('filterName'),
  };

  const PREVIEW_PIXELS = 2.2e6; // pixel budget for the live preview (screen resolution up to this)
  const CAPTURE_MAX = 1920;  // long edge of saved snaps
  const STEP = 65;           // item width + gap
  const SPREAD = 21;         // extra space either side of the ring (from design)
  const REST_SCALE = 55 / 77;
  const HOLD_MS = 300;          // press longer than this on the ring to record
  const MAX_RECORD_MS = 60000;  // recordings auto-stop after 1 minute
  const RECORD_FPS = 30;
  const INTENSITY_KEY = 'snap-filters:intensity';  // per-filter slider values (this device only)
  const RECORD_TYPES = [
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];

  const state = {
    filterIndex: DEFAULT_FILTER,
    facing: 'user',
    mirror: true,
    stream: null,
    source: null,          // HTMLVideoElement or HTMLImageElement
    srcStats: null,
    refStats: FILTERS.map(() => null),
    intensity: loadIntensity(),  // per filter, 0..1
    lastStatsAt: 0,
    capturing: false,
    recording: false,
    snaps: [],
    urls: [],
    current: null,
    thumbQueue: [],        // filters whose thumbnail still needs rendering from PREVIEW_IMAGE
    thumbSrc: null,        // { img, stats } once PREVIEW_IMAGE is decoded
  };

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');

  let renderer;
  let captureRenderer = null;
  let thumbRenderer = null;
  const THUMB_PX = 154;        // 77px active thumbnail at 2x
  const PREVIEW_IMAGE = 'assets/filters/nineties.jpg';  // every carousel thumbnail is this scene through its filter
  const THUMBS_PER_FRAME = 3;  // spread shader compiles so the preview doesn't stall

  // Active recording: a 2D canvas holding the on-screen crop of the preview, fed to MediaRecorder
  const rec = { recorder: null, chunks: [], canvas: null, ctx: null, crop: null, started: 0, timer: 0, filter: null, poster: null };

  /* ---------------- Setup ---------------- */

  function init() {
    try {
      renderer = new Renderer(els.preview);
      renderer.warm(FILTERS);
    } catch (err) {
      showNotice(err.message, { upload: false, retry: false });
      console.error(err);
      return;
    }
    buildCarousel();
    loadReferenceStats().then(loadPreviewImage);
    startCamera();
    requestAnimationFrame(loop);
  }

  function loadReferenceStats() {
    return Promise.all(FILTERS.map((f, i) => {
      if (!f.image) return null;   // pure grades: no reference image
      const img = new Image();
      img.src = f.image;
      return img.decode()
        .then(() => { state.refStats[i] = ColorStats.measure(img, img.naturalWidth, img.naturalHeight); })
        .catch((e) => console.warn('Reference failed to load', f.image, e));
    }));
  }

  function loadPreviewImage() {
    const img = new Image();
    img.src = PREVIEW_IMAGE;
    img.decode().then(() => {
      state.thumbSrc = { img, stats: ColorStats.measure(img, img.naturalWidth, img.naturalHeight) };
      state.thumbQueue = FILTERS.map((f, i) => i);
    }).catch((e) => console.warn('Preview image failed to load', PREVIEW_IMAGE, e));
  }

  /* ---------------- Camera ---------------- */

  function stopStream() {
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }

  async function startCamera() {
    stopStream();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showNotice(location.protocol === 'file:'
        ? 'Open this page over http://localhost or HTTPS to use the camera.'
        : 'Camera is not available in this browser.');
      return;
    }
    try {
      const constraints = { facingMode: { ideal: state.facing }, width: { ideal: 1920 }, height: { ideal: 1080 } };
      // Ask for the mic too so videos have sound; fall back to camera only if it's refused
      const stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: true })
        .catch(() => navigator.mediaDevices.getUserMedia({ video: constraints, audio: false }));
      state.stream = stream;
      video.srcObject = stream;
      await video.play();
      const settings = stream.getVideoTracks()[0].getSettings ? stream.getVideoTracks()[0].getSettings() : {};
      state.mirror = (settings.facingMode || state.facing) !== 'environment';
      state.source = video;
      state.srcStats = null;
      hideNotice();
    } catch (err) {
      console.error(err);
      const msg = {
        NotAllowedError: 'Camera access was blocked. Allow it in your browser settings, or upload a photo.',
        NotFoundError: 'No camera found. Upload a photo to try the filters.',
        NotReadableError: 'The camera is being used by another app.',
      }[err.name] || 'Could not start the camera.';
      showNotice(msg);
    }
  }

  async function flipCamera() {
    if (state.source !== video || state.recording) return;
    const prev = state.facing;
    state.facing = prev === 'user' ? 'environment' : 'user';
    await startCamera();
    if (!state.stream) { state.facing = prev; startCamera(); }
  }

  function showNotice(text, { upload = true, retry = true } = {}) {
    els.noticeText.textContent = text;
    els.retryCamera.hidden = !retry;
    els.uploadInput.parentElement.hidden = !upload;
    els.notice.hidden = false;
  }
  function hideNotice() { els.notice.hidden = true; }

  function useUploadedImage(file) {
    if (!file) return;
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.src = url;
    img.decode().then(() => {
      stopStream();
      state.source = img;
      state.mirror = false;
      state.srcStats = ColorStats.measure(img, img.naturalWidth, img.naturalHeight);
      hideNotice();
    }).catch(() => showNotice('That file could not be opened as an image.'));
  }

  /* ---------------- Render loop ---------------- */

  function sourceSize(src) {
    return src === video
      ? { w: video.videoWidth, h: video.videoHeight }
      : { w: src.naturalWidth, h: src.naturalHeight };
  }

  /** Part of the source visible on screen (object-fit: cover), as 0..1 crop + source px. */
  function visibleCrop(w, h) {
    const vw = els.stage.clientWidth || w, vh = els.stage.clientHeight || h;
    const s = Math.max(vw / w, vh / h);
    const cw = vw / s, ch = vh / s;
    return { crop: [(w - cw) / 2 / w, (h - ch) / 2 / h, cw / w, ch / h], cw, ch, vw, vh };
  }

  function statsFor(i) {
    const src = state.srcStats;
    return { src, ref: state.refStats[i] || src };
  }

  function loop(now) {
    requestAnimationFrame(loop);
    if (state.thumbQueue.length) renderThumbs();
    const src = state.source;
    if (!src) return;
    const { w, h } = sourceSize(src);
    if (!w || !h) return;
    if (src === video && video.readyState < 2) return;

    if (src === video && (!state.srcStats || now - state.lastStatsAt > 300)) {
      state.srcStats = ColorStats.blend(state.srcStats, ColorStats.measure(video, w, h), 0.35);
      state.lastStatsAt = now;
    }

    // Render only what's visible, at the screen's real pixel size, so nothing gets upscaled
    const { crop, vw, vh } = visibleCrop(w, h);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const k = Math.min(dpr, Math.sqrt(PREVIEW_PIXELS / (vw * vh)));
    renderer.setSize(Math.round(vw * k), Math.round(vh * k));
    renderer.render(src, FILTERS[state.filterIndex], {
      ...statsFor(state.filterIndex),
      intensity: state.intensity[state.filterIndex],
      time: now / 1000,
      mirror: state.mirror,
      crop,
    });

    if (state.recording) {
      drawRecordFrame();
      const elapsed = now - rec.started;
      els.recProgress.style.strokeDashoffset = String(100 - Math.min(100, (elapsed / MAX_RECORD_MS) * 100));
      els.recTime.textContent = formatDuration(elapsed);
    }
  }

  /* Carousel thumbnails: PREVIEW_IMAGE (centre square) through each filter. */
  function renderThumbs() {
    const { img, stats } = state.thumbSrc;
    const w = img.naturalWidth, h = img.naturalHeight;
    try {
      if (!thumbRenderer) {
        thumbRenderer = new Renderer(document.createElement('canvas'), { preserve: true });
        thumbRenderer.setSize(THUMB_PX, THUMB_PX);
      }
      const s = Math.min(w, h);
      const crop = [(w - s) / 2 / w, (h - s) / 2 / h, s / w, s / h];
      state.thumbQueue.splice(0, THUMBS_PER_FRAME).forEach((i) => {
        thumbRenderer.render(img, FILTERS[i], { src: stats, ref: state.refStats[i] || stats, crop });
        items()[i].querySelector('img').src = thumbRenderer.canvas.toDataURL('image/jpeg', 0.85);
      });
    } catch (err) {
      console.warn('Thumbnail rendering failed', err);
      state.thumbQueue = [];
    }
  }

  /* ---------------- Capture ---------------- */

  async function capture() {
    const src = state.source;
    if (!src || !state.srcStats || state.capturing) return;
    const { w, h } = sourceSize(src);
    if (!w || !h) return;
    state.capturing = true;

    els.flash.classList.remove('on');
    void els.flash.offsetWidth;
    els.flash.classList.add('on');
    if (navigator.vibrate) navigator.vibrate(20);

    try {
      if (!captureRenderer) captureRenderer = new Renderer(document.createElement('canvas'), { preserve: true });
      // Exactly what is visible on screen, rendered at the screen's pixel size or the
      // camera's native size, whichever is larger, so snaps are as sharp as the preview
      const { crop, cw, ch, vw, vh } = visibleCrop(w, h);
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const base = Math.max(cw / vw, dpr);
      const k = Math.min(base, CAPTURE_MAX / Math.max(vw, vh));
      const filter = FILTERS[state.filterIndex];
      captureRenderer.setSize(Math.round(vw * k), Math.round(vh * k));
      captureRenderer.render(src, filter, {
        ...statsFor(state.filterIndex),
        intensity: state.intensity[state.filterIndex],
        time: performance.now() / 1000,
        mirror: state.mirror,
        crop,
      });

      const blob = await new Promise((res) => captureRenderer.canvas.toBlob(res, 'image/jpeg', 0.95));
      if (blob) {
        await SnapStore.add({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, blob, created: Date.now(), filter: filter.id });
        els.openGallery.classList.remove('bump');
        void els.openGallery.offsetWidth;
        els.openGallery.classList.add('bump');
      }
    } catch (err) {
      console.error('Capture failed', err);
    } finally {
      state.capturing = false;
    }
  }

  /* ---------------- Video recording ---------------- */

  function formatDuration(ms) {
    const t = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  }

  // Same crop as photos: exactly what is visible on screen (object-fit: cover)
  function drawRecordFrame() {
    const W = els.preview.width, H = els.preview.height;
    if (!W || !H) return;
    const { vw, vh } = rec.crop;
    const s = Math.max(vw / W, vh / H);
    const cw = vw / s, ch = vh / s;
    rec.ctx.drawImage(els.preview, (W - cw) / 2, (H - ch) / 2, cw, ch, 0, 0, rec.canvas.width, rec.canvas.height);
  }

  function startRecording() {
    if (state.recording || !state.source || !state.srcStats) return false;
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
      console.warn('Video recording is not supported in this browser.');
      return false;
    }
    const W = els.preview.width, H = els.preview.height;
    if (!W || !H) return false;

    const vw = els.stage.clientWidth, vh = els.stage.clientHeight;
    const s = Math.max(vw / W, vh / H);
    rec.crop = { vw, vh };
    rec.canvas = document.createElement('canvas');
    rec.canvas.width = Math.round(vw / s / 2) * 2;   // encoders want even dimensions
    rec.canvas.height = Math.round(vh / s / 2) * 2;
    rec.ctx = rec.canvas.getContext('2d');
    drawRecordFrame();
    rec.poster = new Promise((res) => rec.canvas.toBlob(res, 'image/jpeg', 0.85));

    const stream = rec.canvas.captureStream(RECORD_FPS);
    if (state.source === video && state.stream) state.stream.getAudioTracks().forEach((t) => stream.addTrack(t));

    const mimeType = RECORD_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    let recorder;
    try {
      recorder = new MediaRecorder(stream, { ...(mimeType && { mimeType }), videoBitsPerSecond: 6e6 });
    } catch (err) {
      console.error('Could not start recording', err);
      return false;
    }

    rec.recorder = recorder;
    rec.chunks = [];
    rec.filter = FILTERS[state.filterIndex].id;
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
    recorder.onstop = () => saveRecording(recorder, stream, mimeType);
    recorder.start(1000);

    rec.started = performance.now();
    rec.timer = setTimeout(stopRecording, MAX_RECORD_MS);
    state.recording = true;
    els.recTime.textContent = '0:00';
    els.recProgress.style.strokeDashoffset = '100';
    els.recTimer.hidden = false;
    els.cameraScreen.classList.add('recording');
    if (navigator.vibrate) navigator.vibrate(30);
    return true;
  }

  function stopRecording() {
    if (!state.recording) return;
    state.recording = false;
    clearTimeout(rec.timer);
    rec.duration = performance.now() - rec.started;
    els.recTimer.hidden = true;
    els.cameraScreen.classList.remove('recording');
    if (rec.recorder && rec.recorder.state !== 'inactive') rec.recorder.stop();
  }

  async function saveRecording(recorder, stream, mimeType) {
    stream.getVideoTracks().forEach((t) => t.stop());   // only the canvas track; mic stays with the camera
    const type = (recorder.mimeType || mimeType || 'video/webm').split(';')[0];
    const blob = new Blob(rec.chunks, { type });
    rec.chunks = [];
    if (!blob.size) return;
    try {
      const poster = await rec.poster;
      await SnapStore.add({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        kind: 'video', blob, poster, duration: rec.duration, created: Date.now(), filter: rec.filter,
      });
      els.openGallery.classList.remove('bump');
      void els.openGallery.offsetWidth;
      els.openGallery.classList.add('bump');
    } catch (err) {
      console.error('Saving video failed', err);
    }
  }

  /* ---------------- Filter carousel ---------------- */

  // Tap the centred filter for a photo; press and hold it to record
  const press = { id: null, x: 0, y: 0, timer: 0, held: false };

  function onItemDown(e, i) {
    press.held = false;
    if (e.button > 0 || i !== state.filterIndex || !isCentered(i)) return;
    press.id = e.pointerId;
    press.x = e.clientX;
    press.y = e.clientY;
    clearTimeout(press.timer);
    press.timer = setTimeout(() => {
      press.timer = 0;
      if (startRecording()) press.held = true;
    }, HOLD_MS);
  }

  function onPressMove(e) {
    if (e.pointerId !== press.id || !press.timer) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) { clearTimeout(press.timer); press.timer = 0; }
  }

  function onPressEnd(e) {
    if (e.pointerId !== press.id) return;
    press.id = null;
    clearTimeout(press.timer);
    press.timer = 0;
    stopRecording();
  }

  function buildCarousel() {
    FILTERS.forEach((f, i) => {
      const btn = document.createElement('button');
      btn.className = 'filter-item';
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-label', f.name);
      btn.innerHTML = `<span class="filter-thumb"><img alt="" draggable="false" /></span>`;
      btn.addEventListener('pointerdown', (e) => onItemDown(e, i));
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        if (press.held) { press.held = false; return; }   // this press was a recording
        if (i === state.filterIndex && isCentered(i)) {
          els.ring.classList.add('press');
          setTimeout(() => els.ring.classList.remove('press'), 120);
          capture();
        } else {
          scrollToIndex(i, true);
        }
      });
      els.carousel.appendChild(btn);
    });
    els.carousel.addEventListener('scroll', onCarouselScroll, { passive: true });
    // Keep the carousel still while a finger is holding the record button
    els.carousel.addEventListener('touchmove', (e) => { if (state.recording) e.preventDefault(); }, { passive: false });
    window.addEventListener('pointermove', onPressMove);
    window.addEventListener('pointerup', onPressEnd);
    window.addEventListener('pointercancel', onPressEnd);
    window.addEventListener('resize', () => scrollToIndex(state.filterIndex, false));
    requestAnimationFrame(() => scrollToIndex(state.filterIndex, false));
  }

  function items() { return els.carousel.children; }

  function centerOffset(el) {
    const c = els.carousel;
    return el.offsetLeft + el.offsetWidth / 2 - (c.scrollLeft + c.clientWidth / 2);
  }

  function isCentered(i) { return Math.abs(centerOffset(items()[i])) < 8; }

  function scrollToIndex(i, smooth) {
    const el = items()[i];
    if (!el) return;
    const c = els.carousel;
    c.scrollTo({ left: el.offsetLeft + el.offsetWidth / 2 - c.clientWidth / 2, behavior: smooth ? 'smooth' : 'auto' });
    onCarouselScroll();
  }

  function onCarouselScroll() {
    let best = 0, bestD = Infinity;
    Array.from(items()).forEach((el, i) => {
      const off = centerOffset(el);
      const d = Math.abs(off);
      const t = Math.min(1, d / STEP);
      const scale = REST_SCALE + (1 - REST_SCALE) * (1 - t);
      el.firstElementChild.style.transform = `translateX(${Math.sign(off) * SPREAD * t}px) scale(${scale})`;
      el.setAttribute('aria-selected', 'false');
      if (d < bestD) { bestD = d; best = i; }
    });
    items()[best].setAttribute('aria-selected', 'true');
    if (state.filterIndex !== best) {
      state.filterIndex = best;
      syncIntensity();
    }
    els.filterName.textContent = FILTERS[best].name;
  }

  /* ---------------- Intensity ---------------- */

  function loadIntensity() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(INTENSITY_KEY)) || {}; } catch { /* storage unavailable */ }
    return FILTERS.map((f) => (typeof saved[f.id] === 'number' ? saved[f.id] : 1));
  }

  function saveIntensity() {
    const out = {};
    FILTERS.forEach((f, i) => { out[f.id] = state.intensity[i]; });
    try { localStorage.setItem(INTENSITY_KEY, JSON.stringify(out)); } catch { /* storage unavailable */ }
  }

  function syncIntensity() {
    const pct = Math.round(state.intensity[state.filterIndex] * 100);
    els.intensityRange.value = String(pct);
    els.intensityRange.style.setProperty('--fill', `${pct}%`);
    els.intensityValue.textContent = `${pct}%`;
  }

  els.intensityRange.addEventListener('input', () => {
    state.intensity[state.filterIndex] = Number(els.intensityRange.value) / 100;
    syncIntensity();
    saveIntensity();
  });
  syncIntensity();

  /* ---------------- Gallery ---------------- */

  function revokeUrls() {
    state.urls.forEach((u) => URL.revokeObjectURL(u));
    state.urls = [];
  }

  async function openGallery(push = true) {
    stopRecording();
    if (push) history.pushState({ view: 'gallery' }, '');
    els.galleryScreen.hidden = false;
    await renderGallery();
  }

  function closeGallery() {
    els.galleryScreen.hidden = true;
    els.viewer.hidden = true;
    revokeUrls();
  }

  async function renderGallery() {
    revokeUrls();
    state.snaps = await SnapStore.all();
    els.grid.innerHTML = '';
    els.empty.hidden = state.snaps.length > 0;
    state.snaps.forEach((snap) => {
      const url = URL.createObjectURL(snap.blob);
      state.urls.push(url);
      snap.url = url;
      const tile = document.createElement('button');
      tile.className = 'tile';
      if (isVideo(snap)) {
        tile.setAttribute('aria-label', 'Open video');
        if (snap.poster) {
          const posterUrl = URL.createObjectURL(snap.poster);
          state.urls.push(posterUrl);
          tile.innerHTML = `<img src="${posterUrl}" alt="" loading="lazy" />`;
        } else {
          tile.innerHTML = `<video src="${url}" muted playsinline preload="metadata"></video>`;
        }
        tile.insertAdjacentHTML('beforeend', `<span class="tile-badge">▶ ${formatDuration(snap.duration || 0)}</span>`);
      } else {
        tile.setAttribute('aria-label', 'Open snap');
        tile.innerHTML = `<img src="${url}" alt="" loading="lazy" />`;
      }
      tile.addEventListener('click', () => openViewer(snap));
      els.grid.appendChild(tile);
    });
  }

  function filterName(id) {
    const f = FILTERS.find((x) => x.id === id);
    return f ? f.name : 'snap';
  }

  function isVideo(snap) { return snap.kind === 'video'; }

  function openViewer(snap, push = true) {
    if (push) history.pushState({ view: 'viewer' }, '');
    state.current = snap;
    const vid = isVideo(snap);
    els.viewerImg.hidden = vid;
    els.viewerVideo.hidden = !vid;
    if (vid) {
      els.viewerVideo.src = snap.url;
      els.viewerVideo.play().catch(() => {});
    } else {
      els.viewerImg.src = snap.url;
    }
    els.viewerTitle.textContent = filterName(snap.filter);
    const file = new File([snap.blob], fileName(snap), { type: snap.blob.type || 'image/jpeg' });
    els.shareSnap.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    els.viewer.hidden = false;
  }

  function closeViewer() {
    els.viewer.hidden = true;
    els.viewerVideo.pause();
    els.viewerVideo.removeAttribute('src');
    els.viewerVideo.load();
    state.current = null;
  }

  function fileName(snap) {
    const ext = isVideo(snap) ? (snap.blob.type.includes('mp4') ? 'mp4' : 'webm') : 'jpg';
    return `snap-${snap.filter}-${snap.created}.${ext}`;
  }

  const isNativeApp = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  function flashLabel(btn, text) {
    clearTimeout(btn._labelTimer);
    btn.textContent = text;
    btn._labelTimer = setTimeout(() => { btn.textContent = 'Download'; btn.disabled = false; }, 1600);
  }

  async function saveCurrent() {
    const snap = state.current;
    if (!snap) return;

    // Android app: write straight into the phone's gallery
    if (isNativeApp()) {
      const btn = els.saveSnap;
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        await window.Capacitor.nativePromise('GallerySaver', 'save', {
          data: await blobToBase64(snap.blob),
          fileName: fileName(snap),
          mimeType: snap.blob.type.split(';')[0] || 'image/jpeg',
        });
        flashLabel(btn, 'Saved to gallery ✓');
      } catch (err) {
        console.error('Save to gallery failed', err);
        flashLabel(btn, 'Couldn’t save');
      }
      return;
    }

    const a = document.createElement('a');
    a.href = snap.url;
    a.download = fileName(snap);
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function shareCurrent() {
    const snap = state.current;
    if (!snap) return;
    try {
      await navigator.share({ files: [new File([snap.blob], fileName(snap), { type: snap.blob.type || 'image/jpeg' })] });
    } catch { /* cancelled */ }
  }

  async function deleteCurrent() {
    const snap = state.current;
    if (!snap || !confirm(isVideo(snap) ? 'Delete this video?' : 'Delete this snap?')) return;
    await SnapStore.remove(snap.id);
    history.back();
    await renderGallery();
  }

  /* ---------------- Events ---------------- */

  // Double-tap the preview to flip camera (like Snapchat)
  let lastTap = 0;
  els.stage.addEventListener('pointerup', () => {
    const now = Date.now();
    if (now - lastTap < 300) { flipCamera(); lastTap = 0; } else lastTap = now;
  });

  els.openGallery.addEventListener('click', () => openGallery());
  els.closeGallery.addEventListener('click', () => history.back());
  els.closeViewer.addEventListener('click', () => history.back());
  els.saveSnap.addEventListener('click', saveCurrent);
  els.shareSnap.addEventListener('click', shareCurrent);
  els.deleteSnap.addEventListener('click', deleteCurrent);
  els.retryCamera.addEventListener('click', startCamera);
  els.uploadInput.addEventListener('change', (e) => useUploadedImage(e.target.files[0]));

  // MediaRecorder WebM files often report an infinite duration; seek to the end once so the scrubber works
  els.viewerVideo.addEventListener('loadedmetadata', () => {
    const v = els.viewerVideo;
    if (v.duration !== Infinity) return;
    v.addEventListener('timeupdate', function reset() {
      v.removeEventListener('timeupdate', reset);
      v.currentTime = 0;
    });
    v.currentTime = 1e9;
  });

  document.addEventListener('visibilitychange', () => { if (document.hidden) stopRecording(); });

  window.addEventListener('popstate', () => {
    if (!els.viewer.hidden) closeViewer();
    else if (!els.galleryScreen.hidden) closeGallery();
  });

  window.addEventListener('keydown', (e) => {
    if (!els.galleryScreen.hidden || e.target.closest('button, label')) return;
    if (e.code === 'Space') { e.preventDefault(); capture(); }
    if (e.code === 'ArrowRight') scrollToIndex(Math.min(state.filterIndex + 1, FILTERS.length - 1), true);
    if (e.code === 'ArrowLeft') scrollToIndex(Math.max(state.filterIndex - 1, 0), true);
  });

  init();
})();
