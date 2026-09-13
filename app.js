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
  { id: 'chambre',   name: 'Chambre',        emoji: '🛏️' },
  { id: 'cuisine',   name: 'Cuisine',        emoji: '🍽️' },
  { id: 'sejour',    name: 'Séjour',         emoji: '🛋️' },
  { id: 'salon',     name: 'Salon',          emoji: '🪑' },
  { id: 'sdb',       name: 'Salle de Bain',  emoji: '🛁' },
  { id: 'vestibule', name: 'Vestibule',      emoji: '🚪' },
];

const EMOJI_CHOICES = ['🛏️','🍽️','🛋️','🪑','🛁','🚪','🏡','🌴','🌺','🪟','🧺','📚','🧸','🚗','🏖️','🎨','🧹','🌿','🔧','📦'];

const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif|tiff?)$/i;

const HAS_FS_ACCESS = 'showDirectoryPicker' in window;

/* ---------- État global ---------- */

let rooms = [];
let activeRoomId = null;
let currentFiles = [];      // [{name, path, getFile: () => Promise<File>}]
let currentIndex = 0;
let currentObjectUrl = null;
let isPlaying = false;
let playTimer = null;

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

  if (!record) {
    showNoSource(room);
    return;
  }

  if (record.type === 'manual') {
    showNoSource(room, true);
    return;
  }

  if (record.type === 'handle') {
    showPanel('loading');
    $('loadingDetail').textContent = `Vérification de l'accès au dossier de « ${room.name} »…`;

    let perm;
    try {
      perm = await record.handle.queryPermission({ mode: 'read' });
    } catch (e) {
      perm = 'denied';
    }

    if (perm === 'granted') {
      await scanAndShow(room, record.handle);
    } else {
      $('reauthRoomName').textContent = room.name;
      showPanel('permission');
    }
  }
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
    await idbSet(sourceKey(room.id), { type: 'handle', handle });
    await scanAndShow(room, handle);
  } catch (e) {
    if (e.name !== 'AbortError') console.error(e);
  }
});

/* ---------- Choix de photos (Galerie / Photos / Fichiers) ---------- */

$('pickFilesBtn').addEventListener('click', () => $('fileInputPhotos').click());

$('fileInputPhotos').addEventListener('change', async (e) => {
  const room = getActiveRoom();
  if (!room) return;
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;

  await idbSet(sourceKey(room.id), { type: 'manual' });

  const existingKeys = new Set(currentFiles.map(f => f.name + f.size));
  const items = files
    .filter(f => IMAGE_RE.test(f.name))
    .filter(f => !existingKeys.has(f.name + f.size))
    .map(f => ({ name: f.name, path: f.name, size: f.size, getFile: () => Promise.resolve(f) }));

  currentFiles = currentFiles.concat(items).sort((a, b) => a.path.localeCompare(b.path, 'fr'));
  if (!currentFiles.length) { showPanel('noPhotos'); return; }
  currentIndex = 0;
  showPanel('slideshow');
  await showSlide(0);
});

/* ---------- Choix de dossier "manuel" (navigateurs sans File System Access) ---------- */

$('fileInputFolder').addEventListener('change', async (e) => {
  const room = getActiveRoom();
  if (!room) return;
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;

  await idbSet(sourceKey(room.id), { type: 'manual' });

  currentFiles = files
    .filter(f => IMAGE_RE.test(f.name))
    .map(f => ({ name: f.name, path: f.webkitRelativePath || f.name, getFile: () => Promise.resolve(f) }))
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
  const record = await idbGet(sourceKey(room.id));
  if (!record || record.type !== 'handle') return;
  try {
    const perm = await record.handle.requestPermission({ mode: 'read' });
    if (perm === 'granted') {
      await scanAndShow(room, record.handle);
    }
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
  await idbDelete(sourceKey(room.id));
  showNoSource(room);
});

/* ---------- Balayage récursif d'un dossier ---------- */

async function collectImagesFromHandle(dirHandle) {
  const results = [];
  async function walk(handle, path) {
    for await (const [name, entry] of handle.entries()) {
      if (entry.kind === 'file') {
        if (IMAGE_RE.test(name)) {
          results.push({ name, path: path + name, getFile: () => entry.getFile() });
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

async function scanAndShow(room, handle) {
  showPanel('loading');
  $('loadingDetail').textContent = `Lecture du dossier de « ${room.name} » (sous-dossiers inclus)…`;
  try {
    currentFiles = await collectImagesFromHandle(handle);
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
  if (record && record.type === 'handle') {
    const keepPath = currentFiles[currentIndex] ? currentFiles[currentIndex].path : null;
    await scanAndShow(room, record.handle);
    if (keepPath) {
      const idx = currentFiles.findIndex(f => f.path === keepPath);
      if (idx >= 0) await showSlide(idx);
    }
  }
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
  currentIndex = ((i % currentFiles.length) + currentFiles.length) % currentFiles.length;
  const item = currentFiles[currentIndex];

  const img = $('slideImg');
  img.classList.remove('img-error');

  try {
    const file = await item.getFile();
    releaseCurrentImage();
    currentObjectUrl = URL.createObjectURL(file);
    img.onerror = () => { img.alt = `Image illisible dans ce navigateur : ${item.name}`; };
    img.src = currentObjectUrl;
    img.alt = item.name;
  } catch (e) {
    img.removeAttribute('src');
    img.alt = `Impossible de lire « ${item.name} » (fichier déplacé ou supprimé ?)`;
  }

  $('counter').textContent = `${currentIndex + 1} / ${currentFiles.length}`;
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
  if (panels.slideshow.classList.contains('panel--hidden')) return;
  if (e.key === 'ArrowRight') nextSlide();
  else if (e.key === 'ArrowLeft') prevSlide();
  else if (e.key === ' ') { e.preventDefault(); isPlaying ? stopSlideshowTimer() : startSlideshowTimer(); }
});

/* Balayage tactile */
(function setupSwipe() {
  const frame = document.querySelector('.slideshow__frame');
  let startX = null;
  frame.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
  frame.addEventListener('touchend', (e) => {
    if (startX === null) return;
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 45) (dx < 0 ? nextSlide() : prevSlide());
    startX = null;
  }, { passive: true });
})();

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

init();
