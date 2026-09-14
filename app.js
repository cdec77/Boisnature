/* ============================================================
   Maison en Photos — logique applicative
   Les photos ne sont jamais copiées : on ne garde que des
   références (FileSystemHandle) vers le disque de l'utilisateur.
   ============================================================ */

'use strict';

/* ---------- Constantes ---------- */

const DB_NAME = 'maison-photos-db';
const DB_VERSION = 1;
const STORE = 'sources';
const ROOMS_KEY = 'mp_rooms_v1';
const ACTIVE_KEY = 'mp_active_room_v1';

const DEFAULT_ROOMS = [
  { id: 'rangement', name: 'RANGEMENT', emoji: '🧺' },
  { id: 'salle_a_manger', name: 'SALLE À MANGER', emoji: '🍽️' },
  { id: 'chambre', name: 'CHAMBRE', emoji: '🛏️' },
  { id: 'salon', name: 'SALON', emoji: '🛋️' },
  { id: 'terrasse', name: 'TERRASSE', emoji: '🌴' },
  { id: 'bureau', name: 'BUREAU', emoji: '📚' },
  { id: 'sdb', name: 'SALLE DE BAIN', emoji: '🛁' },
];

const EMOJI_CHOICES = ['🛏️','🍽️','🛋️','🪑','🛁','🚪','🏡','🌴','🌺','🪟','🧺','📚','🧸','🚗','🏖️','🎨','🧹','🌿','🔧','📦'];

const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif|tiff?)$/i;
const isImageFile = file => IMAGE_RE.test(file.name || '') || /^image\//i.test(file.type || '');

const IS_ANDROID = /Android/i.test(navigator.userAgent);
const HAS_FS_ACCESS = !IS_ANDROID && 'showDirectoryPicker' in window;
const HAS_FILE_PICKER = !IS_ANDROID && 'showOpenFilePicker' in window;

/* ---------- État global ---------- */

let rooms = [];
let activeRoomId = null;
let currentFiles = [];      // [{name, path, getFile: () => Promise<File>}]
let currentIndex = 0;
let currentObjectUrl = null;
let isPlaying = false;
let playTimer = null;
let slideRequestId = 0;
const sessionFilesByRoom = new Map();
const sessionInputsByRoom = new Map();

/* ---------- Petits utilitaires DOM ---------- */

const $ = (id) => document.getElementById(id);

const panels = {
  empty: $('emptyState'),
  noSource: $('noSourceState'),
  permission: $('permissionState'),
  loading: $('loadingState'),
  noPhotos: $('noPhotosState'),
  slideshow: $('slideshow'),
};

function showPanel(name) {
  Object.entries(panels).forEach(([key, el]) => {
    el.classList.toggle('panel--hidden', key !== name);
  });
}

/* ---------- IndexedDB (stockage des accès aux dossiers) ---------- */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const r = tx.objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------- Persistance des pièces (localStorage) ---------- */

function loadRooms() {
  try {
    const raw = localStorage.getItem(ROOMS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  const clone = DEFAULT_ROOMS.map(r => ({ ...r }));
  localStorage.setItem(ROOMS_KEY, JSON.stringify(clone));
  return clone;
}

function saveRooms() {
  localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms));
}

/* ---------- Rendu de la barre des pièces ---------- */

function renderRoomTabs() {
  const nav = $('roomTabs');
  nav.innerHTML = '';
  rooms.forEach(room => {
    const btn = document.createElement('button');
    btn.className = 'signpost' + (room.id === activeRoomId ? ' is-active' : '');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', room.id === activeRoomId ? 'true' : 'false');
    btn.innerHTML = `
      <span class="signpost__icon">${room.emoji}</span>
      <span class="signpost__label">${escapeHtml(room.name)}</span>
      <span class="signpost__edit" title="Modifier la pièce">✎</span>
    `;
    btn.addEventListener('click', () => selectRoom(room.id));
    btn.querySelector('.signpost__edit').addEventListener('click', (e) => {
      e.stopPropagation();
      openEditRoomModal(room.id);
    });
    nav.appendChild(btn);
  });
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

/* ---------- Sélection d'une pièce ---------- */

async function selectRoom(roomId) {
  stopSlideshowTimer();
  releaseCurrentImage();
  currentFiles = [];
  currentIndex = 0;
  activeRoomId = roomId;
  localStorage.setItem(ACTIVE_KEY, roomId);
  renderRoomTabs();
  await refreshRoomView();
}

function getActiveRoom() {
  return rooms.find(r => r.id === activeRoomId) || null;
}

/* ---------- Affichage selon l'état de la source ---------- */

async function refreshRoomView() {
  const room = getActiveRoom();
  if (!room) { showPanel('empty'); return; }

  const record = await idbGet(sourceKey(room.id));
  const session = sessionFilesByRoom.get(room.id) || [];

  if (!record && !session.length) {
    showNoSource(room);
    return;
  }

  const normalized = normalizeRecord(record);
  const handles = normalized.sources.flatMap(s => s.kind === 'directory' ? [s.handle] : s.handles);
  const permissions = await Promise.all(handles.map(async h => {
    try { return await h.queryPermission({ mode: 'read' }); } catch (_) { return 'denied'; }
  }));
  if (permissions.some(p => p !== 'granted')) {
    $('reauthRoomName').textContent = room.name;
    showPanel('permission');
    return;
  }
  await scanAndShow(room, normalized);
}

function sourceKey(roomId) { return `src:${roomId}`; }

function showNoSource(room, wasManual = false) {
  $('noSourceEmoji').textContent = room.emoji;
  $('noSourceTitle').textContent = `Alimenter « ${room.name} »`;
  $('pickFolderBtn').classList.toggle('panel--hidden', !HAS_FS_ACCESS);

  const hint = HAS_FS_ACCESS
    ? "Sur ordinateur et sur Android (Chrome) : choisissez un dossier, sous-dossiers compris — l'appli le retrouvera toute seule à chaque visite."
    : "Sur cet appareil, un navigateur ne peut pas retrouver un dossier tout seul d'une visite à l'autre : sélectionnez vos photos depuis Galerie / Photos / Fichiers, et recommencez si besoin en revenant sur cette pièce.";

  $('platformHint').textContent = wasManual
    ? "Cette pièce avait été alimentée manuellement : sélectionnez à nouveau les photos, elles n'ont jamais quitté votre appareil."
    : hint;

  showPanel('noSource');
}

/* ---------- Choix d'un dossier (File System Access API) ---------- */

$('pickFolderBtn').addEventListener('click', async () => {
  const room = getActiveRoom();
  if (!room || !HAS_FS_ACCESS) return;
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    const record = normalizeRecord(await idbGet(sourceKey(room.id)));
    record.sources.push({ kind: 'directory', handle, excluded: [] });
    await idbSet(sourceKey(room.id), record);
    await scanAndShow(room, record);
  } catch (e) {
    if (e.name !== 'AbortError') console.error(e);
  }
});

/* ---------- Choix de photos (Galerie / Photos / Fichiers) ---------- */

$('pickFilesBtn').addEventListener('click', pickPhotos);
$('addPhotosBtn').addEventListener('click', pickPhotos);

async function pickPhotos() {
  const room = getActiveRoom();
  if (!room) return;
  if (HAS_FILE_PICKER) {
    try {
      const handles = await window.showOpenFilePicker({ multiple: true, types: [{ description: 'Images', accept: { 'image/*': ['.jpg','.jpeg','.png','.webp','.gif','.bmp','.avif','.heic','.heif','.tif','.tiff'] } }] });
      const record = normalizeRecord(await idbGet(sourceKey(room.id)));
      record.sources.push({ kind: 'files', handles });
      await idbSet(sourceKey(room.id), record);
      await scanAndShow(room, record);
    } catch (e) { if (e.name !== 'AbortError') console.error(e); }
  } else {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,.heic,.heif';
    input.multiple = true;
    input.hidden = true;
    document.body.appendChild(input);
    const retainedInputs = sessionInputsByRoom.get(room.id) || [];
    retainedInputs.push(input);
    sessionInputsByRoom.set(room.id, retainedInputs);
    input.addEventListener('change', () => ingestManualPhotos(room.id, Array.from(input.files || [])), { once: true });
    input.click();
  }
}

async function ingestManualPhotos(roomId, files) {
  const room = rooms.find(r => r.id === roomId);
  if (!room) return;
  if (!files.length) return;

  const session = sessionFilesByRoom.get(room.id) || [];
  const existingKeys = new Set(session.map(f => f.name + ':' + f.size));
  const items = files
    .filter(isImageFile)
    .filter(f => !existingKeys.has(f.name + ':' + f.size));
  session.push(...items);
  sessionFilesByRoom.set(room.id, session);
  if (activeRoomId !== room.id) return;
  currentFiles = currentFiles.concat(items.map(f => ({ name:f.name, path:f.name, size:f.size, origin:{kind:'session', file:f}, getFile:() => Promise.resolve(f) }))).sort((a,b) => a.path.localeCompare(b.path,'fr'));
  if (!currentFiles.length) { showPanel('noPhotos'); return; }
  currentIndex = 0;
  showPanel('slideshow');
  await showSlide(0);
}

/* ---------- Choix de dossier "manuel" (navigateurs sans File System Access) ---------- */

$('fileInputFolder').addEventListener('change', async (e) => {
  const room = getActiveRoom();
  if (!room) return;
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;

  sessionFilesByRoom.set(room.id, files.filter(isImageFile));
  currentFiles = files
    .filter(isImageFile)
    .map(f => ({ name: f.name, path: f.webkitRelativePath || f.name, origin:{kind:'session', file:f}, getFile: () => Promise.resolve(f) }))
    .sort((a, b) => a.path.localeCompare(b.path, 'fr'));

  if (!currentFiles.length) { showPanel('noPhotos'); return; }
  currentIndex = 0;
  showPanel('slideshow');
  await showSlide(0);
});

// Sur les navigateurs sans File System Access, le bouton "dossier" retombe
// sur la sélection de dossier classique (non persistante).
if (!HAS_FS_ACCESS) {
  $('pickFolderBtn').addEventListener('click', () => $('fileInputFolder').click());
}

/* ---------- Ré-autorisation d'accès (retour sur l'appli) ---------- */

$('reauthorizeBtn').addEventListener('click', async () => {
  const room = getActiveRoom();
  if (!room) return;
  const record = normalizeRecord(await idbGet(sourceKey(room.id)));
  if (!record.sources.length) return;
  try {
    const handles = record.sources.flatMap(s => s.kind === 'directory' ? [s.handle] : s.handles);
    for (const handle of handles) await handle.requestPermission({ mode: 'read' });
    await scanAndShow(room, record);
  } catch (e) { console.error(e); }
});

$('forgetSourceBtn').addEventListener('click', async () => {
  const room = getActiveRoom();
  if (!room) return;
  await idbDelete(sourceKey(room.id));
  showNoSource(room);
});

$('changeSourceEmptyBtn').addEventListener('click', async () => {
  const room = getActiveRoom();
  if (!room) return;
  await idbDelete(sourceKey(room.id));
  showNoSource(room);
});

$('sourceBtn').addEventListener('click', async () => {
  const room = getActiveRoom();
  if (!room) return;
  stopSlideshowTimer();
  if (!confirm(`Retirer toutes les photos de « ${room.name} » ? Les fichiers d'origine ne seront pas supprimés.`)) return;
  await idbDelete(sourceKey(room.id));
  sessionFilesByRoom.delete(room.id);
  (sessionInputsByRoom.get(room.id) || []).forEach(input => input.remove());
  sessionInputsByRoom.delete(room.id);
  currentFiles = [];
  showNoSource(room);
});

/* ---------- Balayage récursif d'un dossier ---------- */

async function collectImagesFromHandle(dirHandle, sourceIndex, excluded = []) {
  const results = [];
  async function walk(handle, path) {
    for await (const [name, entry] of handle.entries()) {
      if (entry.kind === 'file') {
        if (IMAGE_RE.test(name)) {
          const itemPath = path + name;
          if (!excluded.includes(itemPath)) results.push({ name, path: itemPath, origin:{kind:'directory', sourceIndex, path:itemPath}, getFile: () => entry.getFile() });
        }
      } else if (entry.kind === 'directory') {
        await walk(entry, path + name + '/');
      }
    }
  }
  await walk(dirHandle, '');
  results.sort((a, b) => a.path.localeCompare(b.path, 'fr'));
  return results;
}

function normalizeRecord(record) {
  if (!record) return { version: 2, sources: [] };
  if (record.sources) return record;
  if (record.type === 'handle' && record.handle) return { version: 2, sources: [{ kind:'directory', handle:record.handle, excluded:[] }] };
  return { version: 2, sources: [] };
}

async function scanAndShow(room, record) {
  showPanel('loading');
  $('loadingDetail').textContent = `Lecture du dossier de « ${room.name} » (sous-dossiers inclus)…`;
  try {
    const groups = await Promise.all(record.sources.map(async (source, sourceIndex) => {
      if (source.kind === 'directory') return collectImagesFromHandle(source.handle, sourceIndex, source.excluded || []);
      const items = [];
      for (let fileIndex = 0; fileIndex < source.handles.length; fileIndex++) {
        const handle = source.handles[fileIndex];
        if (IMAGE_RE.test(handle.name)) items.push({ name:handle.name, path:handle.name, origin:{kind:'file', sourceIndex, fileIndex}, getFile:() => handle.getFile() });
      }
      return items;
    }));
    const session = (sessionFilesByRoom.get(room.id) || []).map(f => ({ name:f.name, path:f.name, size:f.size, origin:{kind:'session', file:f}, getFile:() => Promise.resolve(f) }));
    currentFiles = groups.flat().concat(session).sort((a,b) => a.path.localeCompare(b.path,'fr'));
  } catch (e) {
    console.error(e);
    currentFiles = [];
  }
  if (!currentFiles.length) { showPanel('noPhotos'); return; }
  currentIndex = 0;
  showPanel('slideshow');
  await showSlide(0);
}

$('rescanBtn').addEventListener('click', async () => {
  const room = getActiveRoom();
  if (!room) return;
  const record = await idbGet(sourceKey(room.id));
  if (record) {
    const keepPath = currentFiles[currentIndex] ? currentFiles[currentIndex].path : null;
    await scanAndShow(room, normalizeRecord(record));
    if (keepPath) {
      const idx = currentFiles.findIndex(f => f.path === keepPath);
      if (idx >= 0) await showSlide(idx);
    }
  }
});

$('removePhotoBtn').addEventListener('click', async () => {
  const room = getActiveRoom();
  const item = currentFiles[currentIndex];
  if (!room || !item) return;
  if (!confirm(`Retirer « ${item.name} » de cette pièce ? Le fichier d'origine sera conservé.`)) return;
  if (item.origin.kind === 'session') {
    const session = sessionFilesByRoom.get(room.id) || [];
    sessionFilesByRoom.set(room.id, session.filter(f => f !== item.origin.file));
  } else {
    const record = normalizeRecord(await idbGet(sourceKey(room.id)));
    const source = record.sources[item.origin.sourceIndex];
    if (item.origin.kind === 'directory') {
      source.excluded = Array.from(new Set([...(source.excluded || []), item.origin.path]));
    } else {
      source.handles.splice(item.origin.fileIndex, 1);
      if (!source.handles.length) record.sources.splice(item.origin.sourceIndex, 1);
    }
    await idbSet(sourceKey(room.id), record);
  }
  await refreshRoomView();
});

/* ---------- Diaporama ---------- */

function releaseCurrentImage() {
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
}

async function showSlide(i) {
  if (!currentFiles.length) return;
  resetZoom();
  const requestId = ++slideRequestId;
  currentIndex = ((i % currentFiles.length) + currentFiles.length) % currentFiles.length;
  const item = currentFiles[currentIndex];

  const img = $('slideImg');
  const errorBox = $('slideError');
  errorBox.classList.add('panel--hidden');
  img.classList.remove('img-error');

  try {
    const file = await item.getFile();
    const bytes = await file.arrayBuffer();
    if (requestId !== slideRequestId) return;
    const type = file.type || mimeFromName(item.name);
    const localBlob = new Blob([bytes], { type });
    const isHeic = /\.(heic|heif)$/i.test(item.name) || /image\/(heic|heif)/i.test(file.type);
    let displayBlob = localBlob;
    if (isHeic) {
      if (typeof window.heic2any !== 'function') throw new Error('Le convertisseur HEIC n’est pas disponible hors connexion.');
      displayBlob = await window.heic2any({ blob: localBlob, toType: 'image/jpeg', quality: 0.9 });
      if (Array.isArray(displayBlob)) displayBlob = displayBlob[0];
    }
    if (requestId !== slideRequestId) return;
    releaseCurrentImage();
    currentObjectUrl = URL.createObjectURL(displayBlob);
    img.onerror = () => {
      errorBox.textContent = `Impossible d’afficher « ${item.name} » (${type || 'format inconnu'}).`;
      errorBox.classList.remove('panel--hidden');
    };
    img.onload = () => errorBox.classList.add('panel--hidden');
    img.src = currentObjectUrl;
    img.alt = item.name;
  } catch (e) {
    img.removeAttribute('src');
    errorBox.textContent = `Impossible de lire « ${item.name} » : ${e.message || 'accès refusé'}`;
    errorBox.classList.remove('panel--hidden');
  }

  $('counter').textContent = `${currentIndex + 1} / ${currentFiles.length}`;
}

function mimeFromName(name) {
  if (/\.png$/i.test(name)) return 'image/png';
  if (/\.webp$/i.test(name)) return 'image/webp';
  if (/\.gif$/i.test(name)) return 'image/gif';
  if (/\.avif$/i.test(name)) return 'image/avif';
  if (/\.hei[cf]$/i.test(name)) return 'image/heic';
  return 'image/jpeg';
}

function nextSlide() { showSlide(currentIndex + 1); }
function prevSlide() { showSlide(currentIndex - 1); }

$('nextBtn').addEventListener('click', nextSlide);
$('prevBtn').addEventListener('click', prevSlide);

$('shuffleBtn').addEventListener('click', () => {
  if (currentFiles.length < 3) return;
  const keep = currentFiles[currentIndex];
  for (let i = currentFiles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [currentFiles[i], currentFiles[j]] = [currentFiles[j], currentFiles[i]];
  }
  currentIndex = currentFiles.indexOf(keep);
  $('counter').textContent = `${currentIndex + 1} / ${currentFiles.length}`;
});

function stopSlideshowTimer() {
  isPlaying = false;
  $('playBtn').textContent = '▶';
  $('playBtn').classList.remove('is-on');
  if (playTimer) { clearInterval(playTimer); playTimer = null; }
}

function startSlideshowTimer() {
  isPlaying = true;
  $('playBtn').textContent = '⏸';
  $('playBtn').classList.add('is-on');
  const seconds = Number($('speedRange').value) || 4;
  if (playTimer) clearInterval(playTimer);
  playTimer = setInterval(nextSlide, seconds * 1000);
}

$('playBtn').addEventListener('click', () => {
  if (isPlaying) stopSlideshowTimer(); else startSlideshowTimer();
});

$('speedRange').addEventListener('change', () => {
  if (isPlaying) startSlideshowTimer();
});

$('fullscreenBtn').addEventListener('click', () => {
  const el = $('slideshow');
  if (!document.fullscreenElement) {
    (el.requestFullscreen || el.webkitRequestFullscreen || function(){}).call(el);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen || function(){}).call(document);
  }
});

/* Navigation clavier */
document.addEventListener('keydown', (e) => {
  if ($('photoSelection').open || !$('modalOverlay').classList.contains('panel--hidden')) return;
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (panels.slideshow.classList.contains('panel--hidden')) return;
  if (e.key === 'ArrowRight') nextSlide();
  else if (e.key === 'ArrowLeft') prevSlide();
  else if (e.key === ' ') { e.preventDefault(); isPlaying ? stopSlideshowTimer() : startSlideshowTimer(); }
});

/* ---------- Gestion des pièces : ajout / édition ---------- */

function buildEmojiGrid(selected, onPick) {
  const wrap = document.createElement('div');
  wrap.className = 'emoji-grid';
  EMOJI_CHOICES.forEach(em => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = em;
    if (em === selected) b.classList.add('is-selected');
    b.addEventListener('click', () => {
      wrap.querySelectorAll('button').forEach(x => x.classList.remove('is-selected'));
      b.classList.add('is-selected');
      onPick(em);
    });
    wrap.appendChild(b);
  });
  return wrap;
}

function closeModal() { $('modalOverlay').classList.add('panel--hidden'); }
$('modalCancel').addEventListener('click', closeModal);
$('modalOverlay').addEventListener('click', (e) => { if (e.target.id === 'modalOverlay') closeModal(); });

function openAddRoomModal() {
  $('modalTitle').textContent = 'Nouvelle pièce';
  const body = $('modalBody');
  body.innerHTML = '';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Nom de la pièce (ex. Bureau, Garage…)';
  input.maxLength = 30;
  body.appendChild(input);

  let chosenEmoji = EMOJI_CHOICES[0];
  body.appendChild(buildEmojiGrid(chosenEmoji, (em) => { chosenEmoji = em; }));

  $('modalOverlay').classList.remove('panel--hidden');
  input.focus();

  $('modalConfirm').onclick = () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    const id = 'room_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    rooms.push({ id, name, emoji: chosenEmoji });
    saveRooms();
    closeModal();
    selectRoom(id);
  };
}

function openEditRoomModal(roomId) {
  const room = rooms.find(r => r.id === roomId);
  if (!room) return;

  $('modalTitle').textContent = 'Modifier la pièce';
  const body = $('modalBody');
  body.innerHTML = '';

  const input = document.createElement('input');
  input.type = 'text';
  input.value = room.name;
  input.maxLength = 30;
  body.appendChild(input);

  let chosenEmoji = room.emoji;
  body.appendChild(buildEmojiGrid(chosenEmoji, (em) => { chosenEmoji = em; }));

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn btn--ghost';
  deleteBtn.style.marginTop = '14px';
  deleteBtn.style.color = '#B23A24';
  deleteBtn.textContent = '🗑️ Supprimer cette pièce';
  deleteBtn.addEventListener('click', async () => {
    if (rooms.length <= 1) { alert("Il doit rester au moins une pièce."); return; }
    if (!confirm(`Supprimer la pièce « ${room.name} » ? Les photos sur votre appareil ne seront pas touchées.`)) return;
    rooms = rooms.filter(r => r.id !== roomId);
    saveRooms();
    await idbDelete(sourceKey(roomId));
    closeModal();
    selectRoom(rooms[0].id);
  });
  body.appendChild(deleteBtn);

  $('modalOverlay').classList.remove('panel--hidden');

  $('modalConfirm').onclick = () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    room.name = name;
    room.emoji = chosenEmoji;
    saveRooms();
    closeModal();
    renderRoomTabs();
    if (roomId === activeRoomId) refreshRoomView();
  };
}

$('addRoomBtn').addEventListener('click', openAddRoomModal);

/* ---------- Démarrage ---------- */

async function init() {
  rooms = loadRooms();
  const savedActive = localStorage.getItem(ACTIVE_KEY);
  activeRoomId = rooms.find(r => r.id === savedActive) ? savedActive : (rooms[0] ? rooms[0].id : null);

  renderRoomTabs();
  if (activeRoomId) {
    await refreshRoomView();
  } else {
    showPanel('empty');
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}


/* ---------- Zoom et déplacement de la photo ---------- */
const zoom = { scale: 1, x: 0, y: 0 };
const pointers = new Map();
let gesture = null;
let swipeStart = null;
let multiTouch = false;
const photoFrame = document.querySelector('.slideshow__frame');

function paintZoom() {
  const img = $('slideImg');
  const maxX = Math.max(0, (img.offsetWidth * zoom.scale - photoFrame.clientWidth) / 2);
  const maxY = Math.max(0, (img.offsetHeight * zoom.scale - photoFrame.clientHeight) / 2);
  zoom.x = Math.max(-maxX, Math.min(maxX, zoom.x));
  zoom.y = Math.max(-maxY, Math.min(maxY, zoom.y));
  img.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
  $('zoomResetBtn').textContent = `${Math.round(zoom.scale * 100)} %`;
}

function resetZoom() {
  zoom.scale = 1;
  zoom.x = 0;
  zoom.y = 0;
  paintZoom();
}

function setZoom(scale) {
  stopSlideshowTimer();
  zoom.scale = Math.max(1, Math.min(5, scale));
  paintZoom();
}

function pointerGeometry() {
  const points = [...pointers.values()];
  const a = points[0];
  const b = points[1] || a;
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    distance: Math.hypot(a.x - b.x, a.y - b.y),
    scale: zoom.scale,
    tx: zoom.x,
    ty: zoom.y,
  };
}

photoFrame.addEventListener('pointerdown', e => {
  if (e.target.closest('button') || e.button > 0) return;
  photoFrame.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    swipeStart = { x: e.clientX, y: e.clientY, scale: zoom.scale };
    multiTouch = false;
  } else {
    multiTouch = true;
    stopSlideshowTimer();
  }
  gesture = pointerGeometry();
});

photoFrame.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId) || !gesture) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const next = pointerGeometry();
  if (pointers.size > 1 && gesture.distance > 0) {
    zoom.scale = Math.max(1, Math.min(5, gesture.scale * next.distance / gesture.distance));
    const rect = photoFrame.getBoundingClientRect();
    const ratio = zoom.scale / gesture.scale;
    zoom.x = next.x - rect.left - rect.width / 2 - (gesture.x - rect.left - rect.width / 2 - gesture.tx) * ratio;
    zoom.y = next.y - rect.top - rect.height / 2 - (gesture.y - rect.top - rect.height / 2 - gesture.ty) * ratio;
  } else if (zoom.scale > 1) {
    zoom.x = gesture.tx + next.x - gesture.x;
    zoom.y = gesture.ty + next.y - gesture.y;
  }
  paintZoom();
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (!pointers.size) {
    if (e.type === 'pointerup' && !multiTouch && swipeStart && swipeStart.scale === 1) {
      const dx = e.clientX - swipeStart.x;
      const dy = e.clientY - swipeStart.y;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) dx < 0 ? nextSlide() : prevSlide();
    }
    swipeStart = null;
    gesture = null;
  } else {
    gesture = pointerGeometry();
  }
}

photoFrame.addEventListener('pointerup', endPointer);
photoFrame.addEventListener('pointercancel', endPointer);
photoFrame.addEventListener('lostpointercapture', endPointer);
photoFrame.addEventListener('dblclick', e => {
  if (!e.target.closest('button')) setZoom(zoom.scale > 1 ? 1 : 2);
});
$('slideImg').addEventListener('load', paintZoom);
window.addEventListener('resize', paintZoom);
$('zoomInBtn').addEventListener('click', () => setZoom(zoom.scale + 0.5));
$('zoomOutBtn').addEventListener('click', () => setZoom(zoom.scale - 0.5));
$('zoomResetBtn').addEventListener('click', resetZoom);

/* ---------- Sélection multiple ---------- */
const selectedPhotos = new Set();
let selectionFiles = [];
let thumbnailUrls = [];
let selectionGeneration = 0;
let thumbnailObserver = null;

function updateSelection() {
  $('selectionCount').textContent = `${selectedPhotos.size} / ${selectionFiles.length} sélectionnée(s)`;
  $('removeSelectedBtn').disabled = selectedPhotos.size === 0;
  $('photoGrid').querySelectorAll('input').forEach((input, index) => {
    input.checked = selectedPhotos.has(index);
  });
}

function cleanSelection() {
  selectionGeneration++;
  thumbnailObserver?.disconnect();
  thumbnailUrls.forEach(url => URL.revokeObjectURL(url));
  thumbnailUrls = [];
  $('photoGrid').replaceChildren();
  selectedPhotos.clear();
}

$('selectPhotosBtn').addEventListener('click', () => {
  stopSlideshowTimer();
  cleanSelection();
  selectionFiles = currentFiles.slice();
  const generation = selectionGeneration;
  thumbnailObserver = new IntersectionObserver(entries => {
    entries.filter(entry => entry.isIntersecting).forEach(async entry => {
      thumbnailObserver.unobserve(entry.target);
      const index = Number(entry.target.dataset.index);
      try {
        const file = await selectionFiles[index].getFile();
        if (generation !== selectionGeneration) return;
        const url = URL.createObjectURL(file);
        thumbnailUrls.push(url);
        entry.target.src = url;
      } catch (_) { entry.target.alt = 'Aperçu indisponible'; }
    });
  }, { root: $('photoGrid'), rootMargin: '100px' });
  selectionFiles.forEach((item, index) => {
    const label = document.createElement('label');
    label.className = 'photo-card';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('aria-label', `Sélectionner ${item.path}`);
    checkbox.addEventListener('change', () => {
      checkbox.checked ? selectedPhotos.add(index) : selectedPhotos.delete(index);
      updateSelection();
    });
    const img = document.createElement('img');
    img.alt = item.name;
    img.dataset.index = index;
    img.onerror = () => { img.alt = `Aperçu indisponible : ${item.name}`; };
    const name = document.createElement('span');
    name.textContent = item.path;
    label.append(checkbox, img, name);
    $('photoGrid').appendChild(label);
    thumbnailObserver.observe(img);
  });
  updateSelection();
  $('photoSelection').showModal();
});

$('closeSelectionBtn').addEventListener('click', () => $('photoSelection').close());
$('photoSelection').addEventListener('close', cleanSelection);
$('selectAllBtn').addEventListener('click', () => {
  selectionFiles.forEach((_, index) => selectedPhotos.add(index));
  updateSelection();
});
$('clearSelectionBtn').addEventListener('click', () => {
  selectedPhotos.clear();
  updateSelection();
});

// Filtrer les indices en une passe évite les décalages lors des retraits multiples.
async function removePhotoItems(roomId, items) {
  const record = normalizeRecord(await idbGet(sourceKey(roomId)));
  const sessionRemoved = new Set(items.filter(i => i.origin.kind === 'session').map(i => i.origin.file));
  record.sources = record.sources.map((source, sourceIndex) => {
    const removed = items.filter(i => i.origin.sourceIndex === sourceIndex);
    if (source.kind === 'directory') {
      return { ...source, excluded: [...new Set([...(source.excluded || []), ...removed.map(i => i.origin.path)])] };
    }
    const indices = new Set(removed.map(i => i.origin.fileIndex));
    return { ...source, handles: source.handles.filter((_, index) => !indices.has(index)) };
  }).filter(source => source.kind === 'directory' || source.handles.length);
  await idbSet(sourceKey(roomId), record);
  sessionFilesByRoom.set(roomId, (sessionFilesByRoom.get(roomId) || []).filter(file => !sessionRemoved.has(file)));
}

$('removeSelectedBtn').addEventListener('click', async () => {
  const roomId = activeRoomId;
  const items = [...selectedPhotos].map(index => selectionFiles[index]);
  if (!items.length || !confirm(`Retirer ${items.length} photo(s) de cette pièce ? Les fichiers d’origine seront conservés.`)) return;
  $('removeSelectedBtn').disabled = true;
  try {
    await removePhotoItems(roomId, items);
    $('photoSelection').close();
    if (activeRoomId === roomId) await refreshRoomView();
  } catch (error) {
    alert(`Le retrait a échoué : ${error.message}`);
    updateSelection();
  }
});

init();
