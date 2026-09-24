// ===================================================================
// Kargo Kilat — Versi Lite
// Autentikasi: Firebase Authentication (Email & Password)
// Firestore:
//   - buyer/{uid}                        -> profil Pembeli
//   - admin_seller/{uid}                 -> profil Penjual (+ category, lat, lon)
//   - admin_seller/{uid}/products/{id}   -> produk milik toko tsb
//   - admin_seller/{uid}/orders/{id}     -> pesanan masuk toko tsb
//
// Peta & Lokasi (gratis, tanpa server sendiri):
//   - Leaflet + OpenStreetMap  -> peta visual (tanpa API key)
//   - LocationIQ               -> searchAddress() & reverseGeocode()
//   - OpenRouteService         -> calculateDeliveryDistance() (jarak rute jalan)
//
// Firebase SDK dimuat secara DINAMIS (bukan static import) dan dibungkus
// try/catch, supaya navigasi antar layar tetap berfungsi walau koneksi
// ke Firebase gagal — hanya fitur yang butuh server yang akan error.
// ===================================================================

const firebaseConfig = {
  apiKey: 'AIzaSyDCwYLnPoLDDutK4c3ZNqnyrBaTzI0X438',
  authDomain: 'kargokilat2026.firebaseapp.com',
  projectId: 'kargokilat2026',
  storageBucket: 'kargokilat2026.firebasestorage.app',
  messagingSenderId: '557897976616',
  appId: '1:557897976616:web:d8f4468eb5a903d02e1e1d',
  measurementId: 'G-KFLY68WR07',
};

// -------------------------------------------------------------------
// GANTI dengan API key kamu sendiri (keduanya gratis, daftar di situsnya):
//   LocationIQ:        https://locationiq.com
//   OpenRouteService:  https://openrouteservice.org
// -------------------------------------------------------------------
const LOCATIONIQ_API_KEY = 'pk.8fe99f6f6190cc6d424f06a983a0842c';
const OPENROUTESERVICE_API_KEY = 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjA5ZjBmNTY3ZDg0YzQ1NjFiNWNkYzk3ZDlkNzg4ZThmIiwiaCI6Im11cm11cjY0In0=';

const COLLECTION_BY_ROLE = { BUYER: 'buyer', SELLER: 'admin_seller' };
const CATEGORY_LABEL = { warung: 'Warung', resto: 'Resto', toko: 'Toko', apotek: 'Apotek' };
const STATUS_LABEL = { PROSES: 'Proses', KIRIM: 'Kirim', SELESAI: 'Selesai' };

/**
 * Nomor pesanan yang mudah dibaca: DDMMYYYY-XXXX (4 digit acak).
 * Contoh: 21092026-4821
 */
function generateOrderNumber() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const random4 = String(Math.floor(1000 + Math.random() * 9000));
  return `${dd}${mm}${yyyy}-${random4}`;
}

/**
 * Format Firestore Timestamp ({seconds,...}) atau Date jadi "21 September 2026, 14:05".
 */
function formatDateTime(ts) {
  if (!ts) return '';
  const date = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts.seconds ? ts.seconds * 1000 : ts);
  if (isNaN(date.getTime())) return '';
  const datePart = date.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  const timePart = date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  return `${datePart}, ${timePart}`;
}

// Titik tengah default peta jika belum ada lokasi (Monas, Jakarta)
const DEFAULT_LAT = -6.1754;
const DEFAULT_LON = 106.8272;

// Tarif ongkir — sama seperti logika di PRD awal (order_controller.js)
const DELIVERY_BASE_FEE = 5000;
const DELIVERY_RATE_PER_KM = 2000;

// ---------- SERVICE WORKER (cache offline + auto-update) ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => console.log('Service worker terdaftar:', reg.scope))
      .catch((err) => console.warn('Gagal mendaftarkan service worker:', err));
  });
}

// ---------- INSTALL APLIKASI (PWA) ----------
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById('btn-install-app');
  if (btn) btn.hidden = false;
});
window.addEventListener('appinstalled', () => {
  showToast('Aplikasi berhasil dipasang!');
  const btn = document.getElementById('btn-install-app');
  if (btn) btn.hidden = true;
  deferredInstallPrompt = null;
});

// ===================================================================
// GEOCODING — LocationIQ
// ===================================================================

/**
 * Mencari alamat/nama jalan/lokasi. Dipakai untuk kolom "Cari alamat".
 * @param {string} query
 * @returns {Promise<Array<{displayName:string, lat:number, lon:number}>>}
 */
async function searchAddress(query) {
  if (!query || query.trim().length < 3) return [];
  if (LOCATIONIQ_API_KEY === 'YOUR_LOCATIONIQ_API_KEY') {
    throw new Error('LocationIQ API key belum diatur di script.js');
  }

  const url = `https://us1.locationiq.com/v1/search?key=${LOCATIONIQ_API_KEY}&q=${encodeURIComponent(query)}&format=json&countrycodes=id&limit=5`;

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error('Tidak dapat terhubung ke layanan pencarian alamat');
  }

  if (res.status === 429) throw new Error('Batas pencarian LocationIQ tercapai, coba lagi sebentar');
  if (res.status === 401 || res.status === 403) throw new Error('API key LocationIQ tidak valid');
  if (res.status === 404) return []; // tidak ada hasil
  if (!res.ok) throw new Error(`Pencarian alamat gagal (status ${res.status})`);

  const data = await res.json();
  return data.map((item) => ({
    displayName: item.display_name,
    lat: parseFloat(item.lat),
    lon: parseFloat(item.lon),
  }));
}

/**
 * Mengambil alamat lengkap dari koordinat. Dipanggil setiap pin digeser.
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<string>} alamat lengkap
 */
async function reverseGeocode(lat, lon) {
  if (LOCATIONIQ_API_KEY === 'YOUR_LOCATIONIQ_API_KEY') {
    throw new Error('LocationIQ API key belum diatur di script.js');
  }

  const url = `https://us1.locationiq.com/v1/reverse?key=${LOCATIONIQ_API_KEY}&lat=${lat}&lon=${lon}&format=json`;

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error('Tidak dapat terhubung ke layanan alamat');
  }

  if (res.status === 429) throw new Error('Batas permintaan LocationIQ tercapai, coba lagi sebentar');
  if (res.status === 401 || res.status === 403) throw new Error('API key LocationIQ tidak valid');
  if (!res.ok) throw new Error(`Gagal mengambil alamat (status ${res.status})`);

  const data = await res.json();
  return data.display_name || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

// ===================================================================
// ROUTING & ONGKIR — OpenRouteService
// ===================================================================

/**
 * Menghitung jarak rute jalan raya (km) & estimasi waktu tempuh (menit)
 * antara titik merchant dan titik pembeli, plus koordinat rute untuk polyline.
 */
async function calculateDeliveryDistance(originLat, originLon, destLat, destLon) {
  if (OPENROUTESERVICE_API_KEY === 'YOUR_OPENROUTESERVICE_API_KEY') {
    throw new Error('OpenRouteService API key belum diatur di script.js');
  }

  const url = `https://api.openrouteservice.org/v2/directions/driving-car?api_key=${OPENROUTESERVICE_API_KEY}&start=${originLon},${originLat}&end=${destLon},${destLat}`;

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error('Tidak dapat terhubung ke layanan rute');
  }

  if (res.status === 429) throw new Error('Batas permintaan OpenRouteService tercapai, coba lagi sebentar');
  if (res.status === 401 || res.status === 403) throw new Error('API key OpenRouteService tidak valid');
  if (res.status === 404) throw new Error('Rute antara kedua titik tidak ditemukan (mungkin terlalu jauh/terpisah pulau)');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Gagal menghitung rute (status ${res.status})`);
  }

  const data = await res.json();
  const feature = data.features?.[0];
  if (!feature) throw new Error('Rute tidak ditemukan');

  const segment = feature.properties.segments[0];
  return {
    distanceKm: segment.distance / 1000,
    durationMinutes: segment.duration / 60,
    // Leaflet pakai urutan [lat, lon], ORS mengembalikan [lon, lat]
    routeCoordinates: feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
  };
}

/**
 * Kalkulasi ongkir sederhana: biaya dasar + (jarak x tarif per km).
 * Pure function, tidak perlu API.
 */
function calculateDeliveryFee(distanceInKm, ratePerKm, baseFee) {
  if (typeof distanceInKm !== 'number' || isNaN(distanceInKm) || distanceInKm < 0) {
    throw new Error('Jarak tidak valid untuk kalkulasi ongkir');
  }
  return Math.round(baseFee + distanceInKm * ratePerKm);
}

// ===================================================================
// KOMPONEN PETA — Leaflet / OpenStreetMap
// ===================================================================

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Membuat komponen "address picker": peta dengan pin yang bisa digeser/diklik,
 * kolom pencarian alamat (autocomplete via LocationIQ), dan tombol "Lokasi saya".
 * onChange({lat, lon, address}) dipanggil setiap posisi berubah.
 */
function initAddressPicker({ searchInputId, suggestionsId, mapContainerId, initialLat, initialLon, onChange }) {
  let lat = initialLat;
  let lon = initialLon;

  const map = L.map(mapContainerId, { attributionControl: false }).setView([lat, lon], 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(map);
  L.control.attribution({ prefix: false, position: 'bottomright' }).addTo(map);

  const marker = L.marker([lat, lon], { draggable: true }).addTo(map);

  async function commitPosition(newLat, newLon) {
    lat = newLat;
    lon = newLon;
    try {
      const address = await reverseGeocode(lat, lon);
      onChange({ lat, lon, address });
    } catch (err) {
      showToast('Gagal mengambil alamat: ' + err.message);
      onChange({ lat, lon, address: null });
    }
  }

  marker.on('dragend', () => {
    const pos = marker.getLatLng();
    commitPosition(pos.lat, pos.lng);
  });
  map.on('click', (e) => {
    marker.setLatLng(e.latlng);
    commitPosition(e.latlng.lat, e.latlng.lng);
  });

  const searchInput = document.getElementById(searchInputId);
  const suggestionsEl = document.getElementById(suggestionsId);

  const runSearch = debounce(async () => {
    const q = searchInput.value.trim();
    if (q.length < 3) { suggestionsEl.innerHTML = ''; return; }
    try {
      const results = await searchAddress(q);
      suggestionsEl.innerHTML = '';
      if (results.length === 0) {
        suggestionsEl.innerHTML = '<div class="suggestion-error">Alamat tidak ditemukan</div>';
        return;
      }
      results.forEach((r) => {
        const item = document.createElement('div');
        item.className = 'suggestion-item';
        item.textContent = r.displayName;
        item.addEventListener('click', () => {
          lat = r.lat; lon = r.lon;
          map.setView([lat, lon], 16);
          marker.setLatLng([lat, lon]);
          searchInput.value = r.displayName;
          suggestionsEl.innerHTML = '';
          onChange({ lat, lon, address: r.displayName });
        });
        suggestionsEl.appendChild(item);
      });
    } catch (err) {
      suggestionsEl.innerHTML = `<div class="suggestion-error">${escapeHtml(err.message)}</div>`;
    }
  }, 500);
  searchInput.addEventListener('input', runSearch);

  return {
    getPosition: () => ({ lat, lon }),
    setPosition: (newLat, newLon) => {
      lat = newLat; lon = newLon;
      map.setView([lat, lon], 16);
      marker.setLatLng([lat, lon]);
    },
    invalidateSize: () => setTimeout(() => map.invalidateSize(), 0),
    locateMe: () => {
      if (!navigator.geolocation) {
        showToast('Geolocation tidak didukung browser ini');
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const newLat = pos.coords.latitude, newLon = pos.coords.longitude;
          map.setView([newLat, newLon], 16);
          marker.setLatLng([newLat, newLon]);
          commitPosition(newLat, newLon);
        },
        (err) => showToast('Gagal mengambil lokasi: ' + err.message),
        { enableHighAccuracy: true, timeout: 10000 }
      );
    },
    destroy: () => { map.remove(); },
  };
}

// Peta rute (Merchant -> Pembeli) untuk layar "Pilih Lokasi Pengiriman"
let lpRouteMapInstance = null;
let lpRouteLayers = [];

function updateRouteMap(storeLatLng, buyerLatLng, routeCoords) {
  const container = document.getElementById('lp-route-map');
  container.hidden = false;

  if (!lpRouteMapInstance) {
    lpRouteMapInstance = L.map('lp-route-map', { attributionControl: false, zoomControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(lpRouteMapInstance);
  } else {
    setTimeout(() => lpRouteMapInstance.invalidateSize(), 0);
  }

  lpRouteLayers.forEach((l) => lpRouteMapInstance.removeLayer(l));
  lpRouteLayers = [];

  const storeMarker = L.marker(storeLatLng, { icon: L.divIcon({ className: 'map-pin', html: '🏬', iconSize: [24, 24] }) }).addTo(lpRouteMapInstance);
  const buyerMarker = L.marker(buyerLatLng, { icon: L.divIcon({ className: 'map-pin', html: '📍', iconSize: [24, 24] }) }).addTo(lpRouteMapInstance);
  lpRouteLayers.push(storeMarker, buyerMarker);

  let bounds = L.latLngBounds([storeLatLng, buyerLatLng]);
  if (routeCoords && routeCoords.length) {
    const polyline = L.polyline(routeCoords, { color: '#141414', weight: 4 }).addTo(lpRouteMapInstance);
    lpRouteLayers.push(polyline);
    bounds = polyline.getBounds();
  }
  lpRouteMapInstance.fitBounds(bounds, { padding: [24, 24] });
}

// ===================================================================
// STATE
// ===================================================================
let currentProfile = null;   // { uid, role, ...fields, email }
let registerRole = 'BUYER';
let isEditingProfile = false;
let firebaseReady = false;
let splashDismissed = false;
let pendingAuthUser = undefined;

let auth, db;
let fbAuthFns = {};
let fbStoreFns = {};

// Peta "Pilih Lokasi" dipakai bersama (Checkout Pembeli & Profil Penjual),
// dibuat baru setiap layar ini dibuka supaya tile peta tidak dimuat sia-sia.
let locationPicker = null;
let locationPickerMode = null;        // 'checkout' | 'profile'
let profilePendingLat = null;         // titik lokasi toko yang sedang diedit (belum tentu tersimpan)
let profilePendingLon = null;

let currentBuyerStore = null;         // toko yang sedang dilihat Pembeli
let currentBuyerProducts = [];
let buyerCart = {};                   // { productId: { product, qty } }
let currentBuyerOrder = null;         // pesanan yang sedang dibuka di detail/rute pengiriman

let checkoutDeliveryLat = null;
let checkoutDeliveryLon = null;
let checkoutDeliveryFee = 0;
let checkoutLastDistanceLabel = 'Belum dihitung';
let checkoutLastDurationLabel = '—';
let selectedPayment = 'QRIS';

let activeChatUnsub = null;           // fungsi unsubscribe listener chat aktif
let activeChatContext = null;         // { sellerUid, orderId, orderNumber, otherPartyLabel, returnScreen }

// ---------- HELPERS UMUM ----------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showError(elId, message) {
  const el = document.getElementById(elId);
  el.textContent = message;
  el.hidden = false;
}
function hideError(elId) {
  document.getElementById(elId).hidden = true;
}

function showToast(message) {
  const phone = document.querySelector('.phone');
  const existing = phone.querySelector('.toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  phone.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

const rupiah = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function emptyStateEl(emoji, text) {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.innerHTML = `<span class="emoji">${emoji}</span><p>${escapeHtml(text)}</p>`;
  return div;
}

function friendlyAuthError(err) {
  const map = {
    'auth/invalid-email': 'Format email tidak valid',
    'auth/user-not-found': 'Email belum terdaftar',
    'auth/wrong-password': 'Password salah',
    'auth/invalid-credential': 'Email atau password salah',
    'auth/email-already-in-use': 'Email sudah terdaftar, silakan masuk',
    'auth/weak-password': 'Password minimal 6 karakter',
    'auth/too-many-requests': 'Terlalu banyak percobaan, coba lagi nanti',
  };
  return map[err.code] || (err.message || 'Terjadi kesalahan, silakan coba lagi');
}

// ===================================================================
// SPLASH SCREEN
// ===================================================================
function goPastSplash() {
  if (splashDismissed) return;
  splashDismissed = true;
  if (pendingAuthUser !== undefined) {
    routeAfterAuth(pendingAuthUser);
  } else {
    showScreen('screen-login');
  }
}

function routeAfterAuth(user) {
  if (user) {
    loadProfileAndShowDashboard(user);
  } else {
    currentProfile = null;
    showScreen('screen-login');
  }
}

// ===================================================================
// MUAT FIREBASE
// ===================================================================
async function setupFirebase() {
  try {
    const [{ initializeApp }, authMod, storeMod] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js'),
      import('https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js'),
    ]);

    fbAuthFns = authMod;
    fbStoreFns = storeMod;

    const app = initializeApp(firebaseConfig);
    auth = fbAuthFns.getAuth(app);
    db = fbStoreFns.getFirestore(app);

    fbAuthFns.onAuthStateChanged(auth, (user) => {
      pendingAuthUser = user;
      if (splashDismissed) routeAfterAuth(user);
    });

    firebaseReady = true;
  } catch (err) {
    console.error('Gagal memuat Firebase:', err);
    firebaseReady = false;
    pendingAuthUser = null;
    if (splashDismissed) showScreen('screen-login');
    showToast('Gagal terhubung ke server. Periksa koneksi internet lalu muat ulang halaman.');
  }
}

function ensureFirebaseReady(errorElId) {
  if (!firebaseReady) {
    if (errorElId) showError(errorElId, 'Layanan belum siap (masalah koneksi). Coba muat ulang halaman.');
    return false;
  }
  return true;
}

// ===================================================================
// LOGIN
// ===================================================================
async function handleLogin() {
  hideError('login-error');
  if (!ensureFirebaseReady('login-error')) return;

  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;

  if (!email || !password) {
    showError('login-error', 'Email dan password wajib diisi');
    return;
  }

  try {
    await fbAuthFns.signInWithEmailAndPassword(auth, email, password);
    document.getElementById('login-email').value = '';
    document.getElementById('login-password').value = '';
  } catch (err) {
    showError('login-error', friendlyAuthError(err));
  }
}

// ===================================================================
// REGISTER
// ===================================================================
async function handleRegister() {
  hideError('register-error');
  if (!ensureFirebaseReady('register-error')) return;

  if (registerRole === 'BUYER') {
    const name = document.getElementById('reg-buyer-name').value.trim();
    const phone = document.getElementById('reg-buyer-phone').value.trim();
    const email = document.getElementById('reg-buyer-email').value.trim();
    const password = document.getElementById('reg-buyer-password').value;

    if (!name || !phone || !email || !password) {
      showError('register-error', 'Semua kolom wajib diisi');
      return;
    }
    if (password.length < 6) {
      showError('register-error', 'Password minimal 6 karakter');
      return;
    }

    try {
      const cred = await fbAuthFns.createUserWithEmailAndPassword(auth, email, password);
      await fbStoreFns.setDoc(fbStoreFns.doc(db, COLLECTION_BY_ROLE.BUYER, cred.user.uid), {
        role: 'BUYER', name, phone, email,
      });
    } catch (err) {
      showError('register-error', friendlyAuthError(err));
    }

  } else {
    const storeName = document.getElementById('reg-seller-store').value.trim();
    const category = document.getElementById('reg-seller-category').value;
    const ownerName = document.getElementById('reg-seller-owner').value.trim();
    const address = document.getElementById('reg-seller-address').value.trim();
    const phone = document.getElementById('reg-seller-phone').value.trim();
    const email = document.getElementById('reg-seller-email').value.trim();
    const password = document.getElementById('reg-seller-password').value;

    if (!storeName || !category || !ownerName || !address || !phone || !email || !password) {
      showError('register-error', 'Semua kolom wajib diisi, termasuk kategori toko');
      return;
    }
    if (password.length < 6) {
      showError('register-error', 'Password minimal 6 karakter');
      return;
    }

    // Titik lokasi toko (lat/lon) SENGAJA tidak diminta di sini —
    // diatur belakangan lewat menu Profil setelah penjual login.
    try {
      const cred = await fbAuthFns.createUserWithEmailAndPassword(auth, email, password);
      await fbStoreFns.setDoc(fbStoreFns.doc(db, COLLECTION_BY_ROLE.SELLER, cred.user.uid), {
        role: 'SELLER', storeName, category, ownerName, address, phone, email,
        paymentMethods: ['QRIS', 'TRANSFER'],
      });
    } catch (err) {
      showError('register-error', friendlyAuthError(err));
    }
  }
}

function handleLogout() {
  if (firebaseReady) fbAuthFns.signOut(auth);
  closeProfile();
}

// ===================================================================
// DASHBOARD
// ===================================================================
async function loadProfileAndShowDashboard(user) {
  let role = 'BUYER';
  let snap = await fbStoreFns.getDoc(fbStoreFns.doc(db, COLLECTION_BY_ROLE.BUYER, user.uid));

  if (!snap.exists()) {
    snap = await fbStoreFns.getDoc(fbStoreFns.doc(db, COLLECTION_BY_ROLE.SELLER, user.uid));
    role = 'SELLER';
  }

  if (!snap.exists()) {
    currentProfile = { uid: user.uid, role: 'BUYER', name: user.email.split('@')[0], phone: '-', email: user.email };
  } else {
    currentProfile = { uid: user.uid, role, ...snap.data(), email: user.email };
  }

  renderDashboard();
  showScreen('screen-dashboard');
}

function renderDashboard() {
  const isSeller = currentProfile.role === 'SELLER';
  const displayName = isSeller ? currentProfile.storeName : currentProfile.name;

  document.getElementById('avatar-initial').textContent = (displayName || '?').charAt(0).toUpperCase();

  if (isSeller) {
    document.getElementById('dashboard-eyebrow').textContent = 'Selamat datang';
    document.getElementById('dashboard-greeting').textContent = `Hello, ${displayName}`;
    document.getElementById('ad-banner-eyebrow').textContent = 'Dasbor toko';
    document.getElementById('ad-banner-title').textContent = 'Kelola pesanan dan produk tokomu di sini';
  } else {
    document.getElementById('dashboard-eyebrow').textContent = 'Dikirim ke';
    document.getElementById('dashboard-greeting').textContent = 'Mendeteksi lokasi...';
    document.getElementById('ad-banner-eyebrow').textContent = 'Promo hari ini';
    document.getElementById('ad-banner-title').textContent = 'Gratis ongkir untuk pesanan pertama kamu';
    detectBuyerLocation();
    fetchTopProducts();
  }

  document.getElementById('dashboard-search-bar').hidden = isSeller;
  document.getElementById('buyer-dashboard-content').hidden = isSeller;
  document.getElementById('seller-dashboard-content').hidden = !isSeller;
}

/**
 * Mengisi "Dikirim ke" di header dashboard Pembeli lewat lokasi GPS device
 * (reverse geocode). Kalau ditolak/tidak tersedia, tampilkan ajakan aktifkan lokasi.
 */
function detectBuyerLocation() {
  if (!navigator.geolocation) {
    document.getElementById('dashboard-greeting').textContent = 'Aktifkan lokasi';
    return;
  }
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const address = await reverseGeocode(pos.coords.latitude, pos.coords.longitude);
        document.getElementById('dashboard-greeting').textContent = address;
      } catch (err) {
        document.getElementById('dashboard-greeting').textContent = 'Lokasi tidak diketahui';
      }
    },
    () => { document.getElementById('dashboard-greeting').textContent = 'Aktifkan lokasi'; },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

/**
 * "Produk Terlaris" di dashboard Pembeli — versi lite: mengambil produk aktif
 * dari semua toko (collectionGroup) dan menampilkan 4 pertama sebagai carousel.
 * Catatan: belum ada penghitungan jumlah terjual per produk di data model saat
 * ini, jadi ini menampilkan produk aktif terbaru, bukan diurutkan dari angka
 * penjualan asli. Tambahkan field seperti `soldCount` di produk kalau mau
 * urutan berdasarkan penjualan sungguhan.
 */
async function fetchTopProducts() {
  const wrap = document.getElementById('top-products');
  wrap.innerHTML = '';
  if (!ensureFirebaseReady()) return;
  try {
    const q = fbStoreFns.query(fbStoreFns.collectionGroup(db, 'products'), fbStoreFns.limit(20));
    const snap = await fbStoreFns.getDocs(q);
    const candidates = snap.docs
      .map(d => ({ id: d.id, ref: d.ref, ...d.data() }))
      .filter(p => p.active !== false)
      .slice(0, 4);

    // Ambil data toko masing-masing produk sekali di awal, supaya tombol
    // checkout cepat di kartu bisa langsung buka toko + keranjang yang benar.
    const withStore = await Promise.all(candidates.map(async (p) => {
      const sellerRef = p.ref?.parent?.parent;
      let store = null;
      if (sellerRef) {
        try {
          const sellerSnap = await fbStoreFns.getDoc(sellerRef);
          if (sellerSnap.exists()) store = { uid: sellerRef.id, ...sellerSnap.data() };
        } catch (e) { /* toko tidak ditemukan, biarkan null */ }
      }
      return { ...p, _store: store };
    }));

    renderTopProducts(withStore);
  } catch (err) {
    wrap.innerHTML = '';
  }
}

function renderTopProducts(products) {
  const wrap = document.getElementById('top-products');
  wrap.innerHTML = '';
  if (products.length === 0) {
    wrap.appendChild(emptyStateEl('🛍️', 'Belum ada produk populer.'));
    return;
  }
  products.forEach(p => {
    const visual = productVisual(p.name);
    const el = document.createElement('div');
    el.className = 'top-product-card';
    el.innerHTML = `
      <div class="thumb ${visual.tint}">${visual.emoji}</div>
      <p class="name">${escapeHtml(p.name)}</p>
      <div class="top-product-footer">
        <p class="price">${rupiah(p.price)}</p>
        <button class="top-checkout-btn" aria-label="Checkout langsung">🛒</button>
      </div>
    `;
    el.querySelector('.top-checkout-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      quickCheckoutTopProduct(p);
    });
    wrap.appendChild(el);
  });
}

/**
 * Tombol checkout cepat di kartu "Produk Terlaris": buka toko produk itu,
 * masukkan 1 item ke keranjang, lalu langsung ke layar checkout.
 */
async function quickCheckoutTopProduct(p) {
  if (!p._store) {
    showToast('Info toko produk ini tidak ditemukan');
    return;
  }
  await openBuyerStore(p._store);
  const matched = currentBuyerProducts.find(cp => cp.id === p.id) || p;
  buyerCart[matched.id] = { product: matched, qty: 1 };
  renderBuyerProductList();
  openCheckoutScreen();
}

// ===================================================================
// PROFIL (overlay)
// ===================================================================
function openProfile() {
  if (!currentProfile) return;
  const isSeller = currentProfile.role === 'SELLER';

  document.getElementById('profile-fields-buyer').hidden = isSeller;
  document.getElementById('profile-fields-seller').hidden = !isSeller;

  if (isSeller) {
    document.getElementById('profile-store-name').value = currentProfile.storeName || '';
    document.getElementById('profile-category').value = currentProfile.category || 'warung';
    document.getElementById('profile-owner-name').value = currentProfile.ownerName || '';
    document.getElementById('profile-address').value = currentProfile.address || '';
    document.getElementById('profile-seller-phone').value = currentProfile.phone || '';
    const acceptedPayments = currentProfile.paymentMethods || ['QRIS', 'TRANSFER'];
    document.getElementById('profile-payment-qris').checked = acceptedPayments.includes('QRIS');
    document.getElementById('profile-payment-transfer').checked = acceptedPayments.includes('TRANSFER');
    profilePendingLat = currentProfile.lat ?? null;
    profilePendingLon = currentProfile.lon ?? null;
    updateProfileLocationPreview();
  } else {
    document.getElementById('profile-name').value = currentProfile.name || '';
    document.getElementById('profile-phone').value = currentProfile.phone || '';
  }
  document.getElementById('profile-email').value = currentProfile.email;
  document.getElementById('profile-new-password').value = '';
  document.getElementById('profile-current-password').value = '';

  setProfileEditing(false);
  hideError('profile-error');
  document.getElementById('profile-success').hidden = true;
  document.getElementById('profile-overlay').hidden = false;
}

function closeProfile() {
  document.getElementById('profile-overlay').hidden = true;
  setProfileEditing(false);
}

function setProfileEditing(editing) {
  if (!currentProfile) return;
  isEditingProfile = editing;
  const isSeller = currentProfile.role === 'SELLER';

  const fieldIds = isSeller
    ? ['profile-store-name', 'profile-category', 'profile-owner-name', 'profile-address', 'profile-seller-phone', 'profile-email', 'profile-new-password', 'profile-payment-qris', 'profile-payment-transfer']
    : ['profile-name', 'profile-phone', 'profile-email', 'profile-new-password'];

  fieldIds.forEach(id => { document.getElementById(id).disabled = !editing; });
  if (isSeller) document.getElementById('btn-open-profile-location').disabled = !editing;
  document.getElementById('profile-current-password-group').hidden = !editing;
  document.getElementById('btn-edit-profile').hidden = editing;
  document.getElementById('btn-save-profile').hidden = !editing;
}

// Tombol "Pilih Lokasi Pengambilan" di Profil Penjual — ringkasan titik lokasi tersimpan/sedang diedit
function updateProfileLocationPreview() {
  const sub = document.getElementById('profile-location-preview-sub');
  if (profilePendingLat == null || profilePendingLon == null) {
    sub.textContent = 'Titik lokasi belum diatur';
    return;
  }
  const address = document.getElementById('profile-address').value;
  sub.textContent = address || `${profilePendingLat.toFixed(5)}, ${profilePendingLon.toFixed(5)}`;
}

async function saveProfile() {
  hideError('profile-error');
  if (!ensureFirebaseReady('profile-error')) return;
  document.getElementById('profile-success').hidden = true;

  const isSeller = currentProfile.role === 'SELLER';
  const newEmail = document.getElementById('profile-email').value.trim();
  const newPassword = document.getElementById('profile-new-password').value;
  const currentPassword = document.getElementById('profile-current-password').value;

  let updatedFields = {};
  if (isSeller) {
    const storeName = document.getElementById('profile-store-name').value.trim();
    const category = document.getElementById('profile-category').value;
    const ownerName = document.getElementById('profile-owner-name').value.trim();
    const address = document.getElementById('profile-address').value.trim();
    const phone = document.getElementById('profile-seller-phone').value.trim();
    if (!storeName || !category || !ownerName || !address || !phone || !newEmail) {
      showError('profile-error', 'Semua kolom wajib diisi');
      return;
    }
    const paymentMethods = [];
    if (document.getElementById('profile-payment-qris').checked) paymentMethods.push('QRIS');
    if (document.getElementById('profile-payment-transfer').checked) paymentMethods.push('TRANSFER');
    if (paymentMethods.length === 0) {
      showError('profile-error', 'Pilih minimal satu jenis pembayaran yang diterima');
      return;
    }
    updatedFields = { storeName, category, ownerName, address, phone, paymentMethods };
    if (profilePendingLat != null && profilePendingLon != null) {
      updatedFields.lat = profilePendingLat;
      updatedFields.lon = profilePendingLon;
    }
  } else {
    const name = document.getElementById('profile-name').value.trim();
    const phone = document.getElementById('profile-phone').value.trim();
    if (!name || !phone || !newEmail) {
      showError('profile-error', 'Nama, No. HP, dan Email wajib diisi');
      return;
    }
    updatedFields = { name, phone };
  }

  const emailChanged = newEmail !== currentProfile.email;
  const passwordChanged = newPassword.length > 0;

  try {
    if (emailChanged || passwordChanged) {
      if (!currentPassword) {
        showError('profile-error', 'Masukkan password saat ini untuk konfirmasi perubahan email/password');
        return;
      }
      const credential = fbAuthFns.EmailAuthProvider.credential(currentProfile.email, currentPassword);
      await fbAuthFns.reauthenticateWithCredential(auth.currentUser, credential);
    }

    if (emailChanged) await fbAuthFns.updateEmail(auth.currentUser, newEmail);
    if (passwordChanged) {
      if (newPassword.length < 6) {
        showError('profile-error', 'Password baru minimal 6 karakter');
        return;
      }
      await fbAuthFns.updatePassword(auth.currentUser, newPassword);
    }

    const collectionName = COLLECTION_BY_ROLE[currentProfile.role];
    await fbStoreFns.updateDoc(fbStoreFns.doc(db, collectionName, currentProfile.uid), updatedFields);

    currentProfile = { ...currentProfile, ...updatedFields, email: newEmail };
    renderDashboard();

    document.getElementById('profile-success').hidden = false;
    document.getElementById('profile-current-password').value = '';
    document.getElementById('profile-new-password').value = '';
    setProfileEditing(false);
  } catch (err) {
    showError('profile-error', friendlyAuthError(err));
  }
}

// ===================================================================
// SISI PEMBELI — kategori & detail toko (data toko REAL dari Firestore)
// ===================================================================
async function openCategory(key) {
  document.getElementById('category-title').textContent = CATEGORY_LABEL[key] || key;
  showScreen('screen-category');

  const list = document.getElementById('category-list');
  list.innerHTML = '';
  list.appendChild(emptyStateEl('⏳', 'Memuat toko...'));

  if (!ensureFirebaseReady()) return;
  try {
    const q = fbStoreFns.query(
      fbStoreFns.collection(db, COLLECTION_BY_ROLE.SELLER),
      fbStoreFns.where('category', '==', key)
    );
    const snap = await fbStoreFns.getDocs(q);
    const stores = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    renderStoreList(stores);
  } catch (err) {
    list.innerHTML = '';
    list.appendChild(emptyStateEl('⚠️', 'Gagal memuat data toko.'));
  }
}

function renderStoreList(stores) {
  const list = document.getElementById('category-list');
  list.innerHTML = '';
  if (stores.length === 0) {
    list.appendChild(emptyStateEl('🏬', 'Belum ada toko yang terdaftar!'));
    return;
  }
  stores.forEach(store => {
    const el = document.createElement('div');
    el.className = 'store-card';
    el.innerHTML = `
      <div>
        <p class="name">${escapeHtml(store.storeName)}</p>
        <p class="meta">${escapeHtml(store.address || '')}</p>
      </div>
      <span class="tag">Buka</span>
    `;
    el.addEventListener('click', () => openBuyerStore(store));
    list.appendChild(el);
  });
}

/**
 * Cari toko lewat kolom pencarian dashboard. Firestore tidak mendukung
 * pencarian substring, jadi semua toko diambil lalu difilter di client
 * berdasarkan nama toko / kategori / alamat yang cocok dengan kata kunci.
 */
async function handleDashboardSearch() {
  const query = document.getElementById('dashboard-search').value.trim();
  if (!query) return;

  document.getElementById('category-title').textContent = `Hasil untuk "${query}"`;
  showScreen('screen-category');

  const list = document.getElementById('category-list');
  list.innerHTML = '';
  list.appendChild(emptyStateEl('⏳', 'Mencari...'));

  if (!ensureFirebaseReady()) return;
  try {
    const snap = await fbStoreFns.getDocs(fbStoreFns.collection(db, COLLECTION_BY_ROLE.SELLER));
    const q = query.toLowerCase();
    const stores = snap.docs
      .map(d => ({ uid: d.id, ...d.data() }))
      .filter(store =>
        (store.storeName || '').toLowerCase().includes(q) ||
        (CATEGORY_LABEL[store.category] || '').toLowerCase().includes(q) ||
        (store.address || '').toLowerCase().includes(q)
      );
    if (stores.length === 0) {
      list.innerHTML = '';
      list.appendChild(emptyStateEl('🔍', `Tidak ada hasil untuk "${query}"`));
      return;
    }
    renderStoreList(stores);
  } catch (err) {
    list.innerHTML = '';
    list.appendChild(emptyStateEl('⚠️', 'Gagal mencari. Coba lagi.'));
  }
}

async function openBuyerStore(store) {
  currentBuyerStore = store;
  buyerCart = {};
  currentBuyerProducts = [];

  document.getElementById('buyer-store-name').textContent = store.storeName;
  document.getElementById('buyer-store-address').textContent = store.address || '';
  showScreen('screen-buyer-store');

  const wrap = document.getElementById('buyer-store-products');
  wrap.innerHTML = '';
  wrap.appendChild(emptyStateEl('⏳', 'Memuat produk...'));
  updateCheckoutCartBar();

  try {
    const snap = await fbStoreFns.getDocs(fbStoreFns.collection(db, COLLECTION_BY_ROLE.SELLER, store.uid, 'products'));
    currentBuyerProducts = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => p.active !== false);
    renderBuyerProductList();
  } catch (err) {
    wrap.innerHTML = '';
    wrap.appendChild(emptyStateEl('⚠️', 'Gagal memuat produk.'));
  }
}

// Thumbnail produk: emoji + warna dipilih otomatis (bukan foto asli), supaya
// tiap produk terlihat beda meski belum ada upload gambar.
const PRODUCT_VISUALS = [
  { emoji: '🍔', tint: 'tint-amber' },
  { emoji: '🍜', tint: 'tint-red' },
  { emoji: '🛒', tint: 'tint-blue' },
  { emoji: '🥗', tint: 'tint-green' },
  { emoji: '🥤', tint: 'tint-amber' },
  { emoji: '🍞', tint: 'tint-red' },
];
function productVisual(name) {
  const sum = String(name || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return PRODUCT_VISUALS[sum % PRODUCT_VISUALS.length];
}

function renderProductViewList(containerId, products) {
  const wrap = document.getElementById(containerId);
  wrap.innerHTML = '';
  if (products.length === 0) {
    wrap.appendChild(emptyStateEl('🛍️', 'Belum ada produk.'));
    return;
  }
  products.forEach(p => {
    const visual = productVisual(p.name);
    const el = document.createElement('div');
    el.className = 'product-view-card';
    el.innerHTML = `
      <div class="product-thumb ${visual.tint}">${visual.emoji}</div>
      <div class="product-info">
        <p class="name">${escapeHtml(p.name)}</p>
        <p class="stock">Stok: ${p.stock ?? 0}</p>
      </div>
      <p class="price">${rupiah(p.price)}</p>
    `;
    wrap.appendChild(el);
  });
}

// ---------- Daftar produk interaktif (dengan keranjang) ----------
function renderBuyerProductList() {
  const wrap = document.getElementById('buyer-store-products');
  wrap.innerHTML = '';
  if (currentBuyerProducts.length === 0) {
    wrap.appendChild(emptyStateEl('🛍️', 'Belum ada produk.'));
    updateCheckoutCartBar();
    return;
  }
  currentBuyerProducts.forEach(p => {
    const qty = buyerCart[p.id]?.qty || 0;
    const visual = productVisual(p.name);
    const el = document.createElement('div');
    el.className = 'product-view-card interactive';
    el.innerHTML = `
      <div class="product-thumb ${visual.tint}">${visual.emoji}</div>
      <div class="product-info">
        <p class="name">${escapeHtml(p.name)}</p>
        <p class="stock">Stok: ${p.stock ?? 0}</p>
      </div>
      <div class="product-actions">
        <p class="price">${rupiah(p.price)}</p>
        <div class="qty-control">
          ${qty > 0 ? `<button class="qty-btn minus" data-id="${p.id}">−</button><span class="qty-value">${qty}</span>` : ''}
          <button class="qty-btn add" data-id="${p.id}">+</button>
        </div>
      </div>
    `;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.qty-btn')) return; // tombol +/- tetap cepat tanpa buka detail
      openProductDetail(p);
    });
    wrap.appendChild(el);
  });
  wrap.querySelectorAll('.qty-btn.add').forEach(btn => btn.addEventListener('click', () => changeBuyerCartQty(btn.dataset.id, 1)));
  wrap.querySelectorAll('.qty-btn.minus').forEach(btn => btn.addEventListener('click', () => changeBuyerCartQty(btn.dataset.id, -1)));
  updateCheckoutCartBar();
}

// ---------- Detail Produk (layar penuh, mirip halaman produk marketplace) ----------
let productDetailItem = null;
let productDetailQty = 1;

function openProductDetail(p) {
  productDetailItem = p;
  const visual = productVisual(p.name);

  const hero = document.getElementById('detail-hero');
  hero.className = 'detail-hero ' + visual.tint;
  document.getElementById('detail-hero-emoji').textContent = visual.emoji;
  document.getElementById('detail-store-name').textContent = currentBuyerStore?.storeName || '';
  document.getElementById('detail-product-name').textContent = p.name;
  document.getElementById('detail-product-price').textContent = rupiah(p.price);
  document.getElementById('detail-product-stock').textContent = `Stok: ${p.stock ?? 0}`;

  const existingQty = buyerCart[p.id]?.qty || 0;
  productDetailQty = existingQty > 0 ? existingQty : 1;
  updateDetailQtyUI();

  showScreen('screen-product-detail');
}

function updateDetailQtyUI() {
  document.getElementById('detail-qty-value').textContent = productDetailQty;
  const total = (productDetailItem?.price || 0) * productDetailQty;
  document.getElementById('detail-add-total').textContent = rupiah(total);
}

function changeDetailQty(delta) {
  if (!productDetailItem) return;
  const next = productDetailQty + delta;
  if (next < 1) return;
  if (delta > 0 && productDetailItem.stock != null && next > productDetailItem.stock) {
    showToast('Stok tidak cukup');
    return;
  }
  productDetailQty = next;
  updateDetailQtyUI();
}

function confirmAddFromDetail() {
  if (!productDetailItem) return;
  buyerCart[productDetailItem.id] = { product: productDetailItem, qty: productDetailQty };
  renderBuyerProductList();
  showScreen('screen-buyer-store');
  showToast('Ditambahkan ke keranjang');
}

function changeBuyerCartQty(productId, delta) {
  const product = currentBuyerProducts.find(p => p.id === productId);
  if (!product) return;
  const current = buyerCart[productId]?.qty || 0;
  const next = Math.max(0, current + delta);

  if (delta > 0 && product.stock != null && next > product.stock) {
    showToast('Stok tidak cukup');
    return;
  }

  if (next === 0) delete buyerCart[productId];
  else buyerCart[productId] = { product, qty: next };
  renderBuyerProductList();
}

function buyerCartTotalQty() {
  return Object.values(buyerCart).reduce((sum, c) => sum + c.qty, 0);
}
function buyerCartSubtotal() {
  return Object.values(buyerCart).reduce((sum, c) => sum + c.qty * c.product.price, 0);
}

function updateCheckoutCartBar() {
  const bar = document.getElementById('btn-go-checkout');
  const qty = buyerCartTotalQty();
  if (qty === 0) { bar.hidden = true; return; }
  bar.hidden = false;
  document.getElementById('checkout-cart-count').textContent = `${qty} item`;
  document.getElementById('checkout-cart-total').textContent = rupiah(buyerCartSubtotal());
}

// ===================================================================
// CHECKOUT
// ===================================================================
function openCheckoutScreen() {
  if (buyerCartTotalQty() === 0) return;
  showScreen('screen-checkout');
  hideError('checkout-error');

  renderCheckoutItems();
  document.getElementById('checkout-name').value = currentProfile?.name || '';
  document.getElementById('checkout-phone').value = currentProfile?.phone || '';
  document.getElementById('checkout-address').value = '';
  renderCheckoutPaymentOptions();

  checkoutDeliveryFee = 0;
  checkoutDeliveryLat = null;
  checkoutDeliveryLon = null;
  checkoutLastDistanceLabel = 'Belum dihitung';
  checkoutLastDurationLabel = '—';
  updateCheckoutTotal();
  updateCheckoutLocationPreview();
}

function renderCheckoutItems() {
  const wrap = document.getElementById('checkout-items');
  wrap.innerHTML = '';
  Object.values(buyerCart).forEach(({ product, qty }) => {
    const el = document.createElement('div');
    el.className = 'cart-line';
    el.innerHTML = `
      <div>
        <p class="name">${escapeHtml(product.name)}</p>
        <p class="line-meta">${qty} x ${rupiah(product.price)}</p>
      </div>
      <p class="line-price">${rupiah(product.price * qty)}</p>
    `;
    wrap.appendChild(el);
  });
  document.getElementById('checkout-subtotal').textContent = rupiah(buyerCartSubtotal());
}

function renderCheckoutPaymentOptions() {
  const allOptions = [
    { id: 'QRIS', label: 'QRIS' },
    { id: 'TRANSFER', label: 'Transfer Bank' },
  ];
  const accepted = currentBuyerStore?.paymentMethods?.length ? currentBuyerStore.paymentMethods : ['QRIS', 'TRANSFER'];
  const options = allOptions.filter(opt => accepted.includes(opt.id));
  if (!options.some(opt => opt.id === selectedPayment)) {
    selectedPayment = options[0]?.id || 'QRIS';
  }

  const wrap = document.getElementById('checkout-payment-options');
  wrap.innerHTML = '';
  options.forEach(opt => {
    const el = document.createElement('div');
    el.className = 'payment-opt' + (selectedPayment === opt.id ? ' selected' : '');
    el.innerHTML = `<span>${opt.label}</span><span class="dot"></span>`;
    el.addEventListener('click', () => {
      selectedPayment = opt.id;
      renderCheckoutPaymentOptions();
    });
    wrap.appendChild(el);
  });
}

// Tombol "Pilih Lokasi Pengiriman" di Checkout — ringkasan alamat + ongkir yang sudah dihitung
function updateCheckoutLocationPreview() {
  const sub = document.getElementById('checkout-location-preview-sub');
  if (checkoutDeliveryLat == null) {
    sub.textContent = 'Atur pin lokasi & hitung ongkir';
    return;
  }
  const addr = document.getElementById('checkout-address').value || `${checkoutDeliveryLat.toFixed(5)}, ${checkoutDeliveryLon.toFixed(5)}`;
  const feeText = checkoutDeliveryFee ? ` · Ongkir ${rupiah(checkoutDeliveryFee)}` : '';
  sub.textContent = addr + feeText;
}

async function updateCheckoutDelivery(lat, lon) {
  checkoutDeliveryLat = lat;
  checkoutDeliveryLon = lon;

  if (!currentBuyerStore?.lat || !currentBuyerStore?.lon) {
    checkoutLastDistanceLabel = 'Toko belum atur lokasi';
    checkoutLastDurationLabel = '—';
    document.getElementById('lp-distance').textContent = checkoutLastDistanceLabel;
    document.getElementById('lp-duration').textContent = checkoutLastDurationLabel;
    checkoutDeliveryFee = 0;
    document.getElementById('lp-fee').textContent = rupiah(0);
    updateCheckoutTotal();
    return;
  }

  hideError('lp-route-error');
  document.getElementById('lp-distance').textContent = 'Menghitung...';
  document.getElementById('lp-duration').textContent = '—';

  try {
    const result = await calculateDeliveryDistance(currentBuyerStore.lat, currentBuyerStore.lon, lat, lon);
    checkoutDeliveryFee = calculateDeliveryFee(result.distanceKm, DELIVERY_RATE_PER_KM, DELIVERY_BASE_FEE);
    checkoutLastDistanceLabel = `${result.distanceKm.toFixed(1)} km`;
    checkoutLastDurationLabel = `${Math.round(result.durationMinutes)} menit`;
    document.getElementById('lp-distance').textContent = checkoutLastDistanceLabel;
    document.getElementById('lp-duration').textContent = checkoutLastDurationLabel;
    document.getElementById('lp-fee').textContent = rupiah(checkoutDeliveryFee);
    updateRouteMap([currentBuyerStore.lat, currentBuyerStore.lon], [lat, lon], result.routeCoordinates);
  } catch (err) {
    showError('lp-route-error', 'Gagal menghitung rute: ' + err.message);
    checkoutDeliveryFee = 0;
    checkoutLastDistanceLabel = 'Gagal dihitung';
    document.getElementById('lp-distance').textContent = checkoutLastDistanceLabel;
  }
  updateCheckoutLocationPreview();
  updateCheckoutTotal();
}

function updateCheckoutTotal() {
  const total = buyerCartSubtotal() + checkoutDeliveryFee;
  document.getElementById('checkout-total').textContent = rupiah(total);
}

/**
 * Buka layar "Pilih Lokasi" bersama, dipakai untuk:
 *  - mode 'checkout': lokasi pengiriman Pembeli (+ ongkir & peta rute)
 *  - mode 'profile' : titik lokasi pengambilan/toko Penjual
 * Peta baru dibuat di sini (bukan saat Checkout/Profil dibuka), supaya
 * tile peta & geolokasi tidak langsung dimuat sebelum benar-benar dibutuhkan.
 */
function openLocationPicker(mode) {
  locationPickerMode = mode;
  const isCheckout = mode === 'checkout';

  document.getElementById('lp-title').textContent = isCheckout ? 'Pilih Lokasi Pengiriman' : 'Pilih Lokasi Pengambilan';
  document.getElementById('lp-ongkir-section').hidden = !isCheckout;
  document.getElementById('lp-search').value = '';
  document.getElementById('lp-suggestions').innerHTML = '';
  hideError('lp-route-error');
  document.getElementById('lp-route-map').hidden = true;

  let initialLat, initialLon, firstTime;
  if (isCheckout) {
    firstTime = checkoutDeliveryLat == null;
    initialLat = checkoutDeliveryLat ?? DEFAULT_LAT;
    initialLon = checkoutDeliveryLon ?? DEFAULT_LON;
    document.getElementById('lp-distance').textContent = checkoutLastDistanceLabel;
    document.getElementById('lp-duration').textContent = checkoutLastDurationLabel;
    document.getElementById('lp-fee').textContent = rupiah(checkoutDeliveryFee);
    document.getElementById('lp-address-readout').textContent = document.getElementById('checkout-address').value || 'Menentukan lokasi...';
    if (!currentBuyerStore?.lat || !currentBuyerStore?.lon) {
      showError('lp-route-error', 'Toko ini belum mengatur titik lokasi, ongkir belum bisa dihitung otomatis. Pesanan tetap bisa dibuat.');
    }
  } else {
    document.getElementById('profile-overlay').hidden = true;
    firstTime = false;
    initialLat = profilePendingLat ?? DEFAULT_LAT;
    initialLon = profilePendingLon ?? DEFAULT_LON;
    document.getElementById('lp-address-readout').textContent = document.getElementById('profile-address').value || `${initialLat.toFixed(5)}, ${initialLon.toFixed(5)}`;
  }

  showScreen('screen-location-picker');

  if (locationPicker) { locationPicker.destroy(); locationPicker = null; }
  locationPicker = initAddressPicker({
    searchInputId: 'lp-search',
    suggestionsId: 'lp-suggestions',
    mapContainerId: 'lp-map',
    initialLat,
    initialLon,
    onChange: ({ lat, lon, address }) => {
      document.getElementById('lp-address-readout').textContent = address || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
      if (isCheckout) {
        document.getElementById('checkout-address').value = address || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        updateCheckoutDelivery(lat, lon);
      } else {
        profilePendingLat = lat;
        profilePendingLon = lon;
        if (address) document.getElementById('profile-address').value = address;
        updateProfileLocationPreview();
      }
    },
  });
  document.getElementById('btn-lp-locate-me').onclick = () => locationPicker.locateMe();

  // Hanya coba deteksi lokasi otomatis saat pertama kali Pembeli membuka pemilih lokasi di checkout ini.
  if (isCheckout && firstTime) locationPicker.locateMe();
}

function closeLocationPicker() {
  if (locationPicker) { locationPicker.destroy(); locationPicker = null; }
  if (locationPickerMode === 'checkout') {
    showScreen('screen-checkout');
    updateCheckoutLocationPreview();
  } else {
    showScreen('screen-dashboard');
    document.getElementById('profile-overlay').hidden = false;
    updateProfileLocationPreview();
  }
  locationPickerMode = null;
}

async function handleConfirmOrder() {
  hideError('checkout-error');
  if (!ensureFirebaseReady('checkout-error')) return;
  if (buyerCartTotalQty() === 0) {
    showError('checkout-error', 'Keranjang kosong');
    return;
  }

  const name = document.getElementById('checkout-name').value.trim();
  const phone = document.getElementById('checkout-phone').value.trim();
  const address = document.getElementById('checkout-address').value.trim();

  if (!name || !phone || !address) {
    showError('checkout-error', 'Nama, No. HP, dan alamat pengiriman wajib diisi');
    return;
  }
  if (checkoutDeliveryLat == null || checkoutDeliveryLon == null) {
    showError('checkout-error', 'Tentukan pin lokasi pengiriman di peta terlebih dahulu');
    return;
  }

  const items = Object.values(buyerCart).map(({ product, qty }) => ({
    productId: product.id, name: product.name, price: product.price, qty,
  }));
  const subtotal = buyerCartSubtotal();
  const total = subtotal + checkoutDeliveryFee;
  const orderNumber = generateOrderNumber();

  try {
    // Buat referensi dokumen dulu supaya ID-nya bisa dipakai bersama
    // di koleksi seller maupun salinan ringkas di koleksi buyer.
    const orderRef = fbStoreFns.doc(fbStoreFns.collection(db, COLLECTION_BY_ROLE.SELLER, currentBuyerStore.uid, 'orders'));
    const orderData = {
      orderNumber,
      buyerUid: currentProfile.uid,
      buyerName: name,
      buyerPhone: phone,
      address,
      deliveryLat: checkoutDeliveryLat,
      deliveryLon: checkoutDeliveryLon,
      items,
      subtotal,
      deliveryFee: checkoutDeliveryFee,
      total,
      paymentMethod: selectedPayment,
      status: 'PROSES',
      createdAt: fbStoreFns.serverTimestamp(),
    };

    await fbStoreFns.setDoc(orderRef, orderData);
    await fbStoreFns.setDoc(
      fbStoreFns.doc(db, COLLECTION_BY_ROLE.BUYER, currentProfile.uid, 'orders', orderRef.id),
      { ...orderData, sellerUid: currentBuyerStore.uid, storeName: currentBuyerStore.storeName }
    );

    buyerCart = {};
    showToast('Pesanan berhasil dibuat!');
    showScreen('screen-dashboard');
  } catch (err) {
    showError('checkout-error', friendlyAuthError(err));
  }
}

// ===================================================================
// SISI PENJUAL — Produk (daftar → tap untuk buka menu edit lengkap)
// ===================================================================
let sellerProductsCache = [];
let editingProduct = null;       // produk yang sedang dibuka di menu edit (null = produk baru)
let editingProductPhotos = [null, null, null]; // data URL 3 slide foto

function buildProductListItem(p) {
  const visual = productVisual(p.name);
  const el = document.createElement('div');
  el.className = 'product-list-row';
  const thumbPhoto = (p.photos || []).find(Boolean);
  el.innerHTML = `
    <div class="thumb ${visual.tint}">${thumbPhoto ? `<img src="${thumbPhoto}" alt="">` : visual.emoji}</div>
    <div class="info">
      <p class="name">${escapeHtml(p.name || '')}</p>
      <p class="price">${rupiah(p.price)}</p>
      <p class="status-dot ${p.active === false ? 'inactive' : ''}">${p.active === false ? '● Tidak aktif' : '● Aktif dijual'}</p>
    </div>
    <span class="chevron">›</span>
  `;
  el.addEventListener('click', () => openProductEditScreen(p));
  return el;
}

function renderProductList(rows) {
  const wrap = document.getElementById('seller-product-rows');
  wrap.innerHTML = '';
  if (rows.length === 0) {
    wrap.appendChild(emptyStateEl('📦', 'Belum ada produk. Tambahkan produk pertamamu.'));
    return;
  }
  rows.forEach(p => wrap.appendChild(buildProductListItem(p)));
}

async function openSellerProducts() {
  showScreen('screen-seller-products');
  const wrap = document.getElementById('seller-product-rows');
  wrap.innerHTML = '';
  wrap.appendChild(emptyStateEl('⏳', 'Memuat produk...'));

  if (!ensureFirebaseReady()) return;
  try {
    const snap = await fbStoreFns.getDocs(fbStoreFns.collection(db, COLLECTION_BY_ROLE.SELLER, currentProfile.uid, 'products'));
    sellerProductsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderProductList(sellerProductsCache);
  } catch (err) {
    wrap.innerHTML = '';
    wrap.appendChild(emptyStateEl('⚠️', 'Gagal memuat produk.'));
  }
}

// ---------- Menu edit produk (nama, foto, deskripsi, harga, qty, diskon, metode bayar, aktif) ----------
function openProductEditScreen(product) {
  editingProduct = product || null;
  editingProductPhotos = [0, 1, 2].map(i => (product?.photos || [])[i] || null);

  document.getElementById('product-edit-title').textContent = product ? 'Edit Produk' : 'Tambah Produk';
  document.getElementById('pe-name').value = product?.name || '';
  document.getElementById('pe-description').value = product?.description || '';
  document.getElementById('pe-price').value = product?.price ?? '';
  document.getElementById('pe-stock').value = product?.stock ?? '';
  document.getElementById('pe-discount').value = product?.discount ?? '';
  document.getElementById('pe-pay-qris').checked = !product || (product.paymentMethods || []).includes('QRIS');
  document.getElementById('pe-pay-transfer').checked = !product || (product.paymentMethods || []).includes('TRANSFER');
  document.getElementById('pe-active').checked = product?.active !== false;

  renderPhotoSlots();
  hideError('product-edit-error');
  document.getElementById('product-edit-success').hidden = true;
  document.getElementById('btn-delete-product').hidden = !product;

  setProductEditing(!product); // produk baru langsung bisa diisi; produk lama mulai terkunci (preview)
  showScreen('screen-seller-product-edit');
}

function renderPhotoSlots() {
  document.querySelectorAll('#pe-photo-slide .photo-slot').forEach((slot, i) => {
    const img = slot.querySelector('.photo-preview');
    const placeholder = slot.querySelector('.photo-placeholder');
    if (editingProductPhotos[i]) {
      img.src = editingProductPhotos[i];
      img.hidden = false;
      placeholder.hidden = true;
    } else {
      img.hidden = true;
      placeholder.hidden = false;
    }
  });
}

function setProductEditing(isEditing) {
  const fieldIds = ['pe-name', 'pe-description', 'pe-price', 'pe-stock', 'pe-discount', 'pe-pay-qris', 'pe-pay-transfer', 'pe-active'];
  fieldIds.forEach(id => { document.getElementById(id).disabled = !isEditing; });
  document.querySelectorAll('.photo-input').forEach(inp => { inp.disabled = !isEditing; });

  document.getElementById('btn-toggle-edit-product').hidden = isEditing;
  document.getElementById('btn-save-product').hidden = !isEditing;
}

async function saveProduct() {
  hideError('product-edit-error');
  document.getElementById('product-edit-success').hidden = true;
  if (!ensureFirebaseReady('product-edit-error')) return;

  const name = document.getElementById('pe-name').value.trim();
  const price = parseInt(document.getElementById('pe-price').value, 10);
  const stock = parseInt(document.getElementById('pe-stock').value, 10) || 0;
  const discount = parseInt(document.getElementById('pe-discount').value, 10) || 0;
  const description = document.getElementById('pe-description').value.trim();
  const active = document.getElementById('pe-active').checked;
  const paymentMethods = [];
  if (document.getElementById('pe-pay-qris').checked) paymentMethods.push('QRIS');
  if (document.getElementById('pe-pay-transfer').checked) paymentMethods.push('TRANSFER');

  if (!name || !price) {
    showError('product-edit-error', 'Nama dan harga jual produk wajib diisi');
    return;
  }

  const data = { name, description, price, stock, discount, paymentMethods, active, photos: editingProductPhotos };

  try {
    if (editingProduct?.id) {
      await fbStoreFns.updateDoc(fbStoreFns.doc(db, COLLECTION_BY_ROLE.SELLER, currentProfile.uid, 'products', editingProduct.id), data);
    } else {
      await fbStoreFns.addDoc(fbStoreFns.collection(db, COLLECTION_BY_ROLE.SELLER, currentProfile.uid, 'products'), data);
    }
  } catch (err) {
    showError('product-edit-error', friendlyAuthError(err));
    return;
  }

  showToast('Produk disimpan');
  await openSellerProducts();
}

async function deleteCurrentProduct() {
  if (!editingProduct?.id) return;
  if (!ensureFirebaseReady('product-edit-error')) return;
  try {
    await fbStoreFns.deleteDoc(fbStoreFns.doc(db, COLLECTION_BY_ROLE.SELLER, currentProfile.uid, 'products', editingProduct.id));
    showToast('Produk dihapus');
    await openSellerProducts();
  } catch (err) {
    showError('product-edit-error', friendlyAuthError(err));
  }
}

function handlePhotoSlotChange(e) {
  const input = e.target;
  const slot = parseInt(input.dataset.slot, 10);
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    editingProductPhotos[slot] = reader.result;
    renderPhotoSlots();
  };
  reader.readAsDataURL(file);
}

// ===================================================================
// SISI PENJUAL — Pesanan (status: Proses/Kirim/Selesai)
// ===================================================================
async function openSellerOrders() {
  showScreen('screen-seller-orders');
  const wrap = document.getElementById('seller-order-rows');
  wrap.innerHTML = '';
  wrap.appendChild(emptyStateEl('⏳', 'Memuat pesanan...'));

  if (!ensureFirebaseReady()) return;
  try {
    const snap = await fbStoreFns.getDocs(fbStoreFns.collection(db, COLLECTION_BY_ROLE.SELLER, currentProfile.uid, 'orders'));
    const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderOrderRows(orders);
  } catch (err) {
    wrap.innerHTML = '';
    wrap.appendChild(emptyStateEl('⚠️', 'Gagal memuat pesanan.'));
  }
}

function renderOrderRows(orders) {
  const wrap = document.getElementById('seller-order-rows');
  wrap.innerHTML = '';
  if (orders.length === 0) {
    wrap.appendChild(emptyStateEl('🧾', 'Belum ada pesanan masuk.'));
    return;
  }
  orders.forEach(o => {
    const status = o.status || 'PROSES';
    const itemsSummary = (o.items || []).map(i => `${i.name} x${i.qty}`).join(', ');
    const orderNumber = o.orderNumber || o.id.slice(-6).toUpperCase();
    const el = document.createElement('div');
    el.className = 'order-row';
    const statusControl = status === 'SELESAI'
      ? `<span class="order-status-tag status-selesai">✓ Selesai — dikonfirmasi pembeli${o.receivedAt ? ` (${escapeHtml(formatDateTime(o.receivedAt))})` : ''}</span>`
      : `<select class="status-select status-${status.toLowerCase()}">
          <option value="PROSES" ${status === 'PROSES' ? 'selected' : ''}>Proses</option>
          <option value="KIRIM" ${status === 'KIRIM' ? 'selected' : ''}>Kirim</option>
        </select>`;
    el.innerHTML = `
      <div class="order-top">
        <div>
          <p class="order-id">${escapeHtml(orderNumber)}</p>
          <p class="order-meta">${escapeHtml(o.buyerName || 'Pembeli')} &middot; ${escapeHtml(o.buyerPhone || '')}</p>
          <p class="order-meta">${escapeHtml(itemsSummary)}</p>
          <p class="order-meta">${escapeHtml(o.address || '')}</p>
        </div>
        <p class="order-total">${o.total ? rupiah(o.total) : ''}</p>
      </div>
      ${statusControl}
      <button type="button" class="chat-btn">💬 Chat dengan Pembeli</button>
    `;
    const select = el.querySelector('.status-select');
    if (select) select.addEventListener('change', () => updateOrderStatus(o.id, select.value, select, o.buyerUid));
    el.querySelector('.chat-btn').addEventListener('click', () => openOrderChat({
      sellerUid: currentProfile.uid,
      orderId: o.id,
      orderNumber,
      otherPartyLabel: o.buyerName || 'Pembeli',
      returnScreen: 'screen-seller-orders',
    }));
    wrap.appendChild(el);
  });
}

async function updateOrderStatus(orderId, newStatus, selectEl, buyerUid) {
  try {
    const update = { status: newStatus };
    // Update kedua salinan pesanan: milik toko (admin_seller) DAN milik pembeli,
    // supaya status yang dilihat Pembeli ikut berubah juga.
    await fbStoreFns.updateDoc(
      fbStoreFns.doc(db, COLLECTION_BY_ROLE.SELLER, currentProfile.uid, 'orders', orderId),
      update
    );
    if (buyerUid) {
      await fbStoreFns.updateDoc(
        fbStoreFns.doc(db, COLLECTION_BY_ROLE.BUYER, buyerUid, 'orders', orderId),
        update
      );
    }
    selectEl.className = 'status-select status-' + newStatus.toLowerCase();
    showToast('Status pesanan diperbarui');
  } catch (err) {
    showToast('Gagal memperbarui status: ' + friendlyAuthError(err));
  }
}

// ===================================================================
// SISI PENJUAL — Toko Saya (preview seperti dilihat Pembeli)
// ===================================================================
async function openSellerStoreView() {
  showScreen('screen-seller-store');
  document.getElementById('seller-store-title').textContent = currentProfile.storeName;

  const wrap = document.getElementById('seller-store-products');
  wrap.innerHTML = '';
  wrap.appendChild(emptyStateEl('⏳', 'Memuat produk...'));

  if (!ensureFirebaseReady()) return;
  try {
    const snap = await fbStoreFns.getDocs(fbStoreFns.collection(db, COLLECTION_BY_ROLE.SELLER, currentProfile.uid, 'products'));
    const products = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => p.active !== false);
    renderProductViewList('seller-store-products', products);
  } catch (err) {
    wrap.innerHTML = '';
    wrap.appendChild(emptyStateEl('⚠️', 'Gagal memuat produk.'));
  }
}

// ===================================================================
// SISI PEMBELI — Pesanan Saya
// ===================================================================
async function openBuyerOrders() {
  showScreen('screen-buyer-orders');
  const wrap = document.getElementById('buyer-order-rows');
  wrap.innerHTML = '';
  wrap.appendChild(emptyStateEl('⏳', 'Memuat pesanan...'));

  if (!ensureFirebaseReady()) return;
  try {
    const snap = await fbStoreFns.getDocs(fbStoreFns.collection(db, COLLECTION_BY_ROLE.BUYER, currentProfile.uid, 'orders'));
    const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    orders.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    renderBuyerOrderRows(orders);
  } catch (err) {
    wrap.innerHTML = '';
    wrap.appendChild(emptyStateEl('⚠️', 'Gagal memuat pesanan.'));
  }
}

function renderBuyerOrderRows(orders) {
  const wrap = document.getElementById('buyer-order-rows');
  wrap.innerHTML = '';
  if (orders.length === 0) {
    wrap.appendChild(emptyStateEl('🧾', 'Belum ada pesanan.'));
    return;
  }
  orders.forEach(o => {
    const status = o.status || 'PROSES';
    const orderNumber = o.orderNumber || o.id.slice(-6).toUpperCase();
    const el = document.createElement('div');
    el.className = 'order-row clickable';
    el.innerHTML = `
      <div class="order-top">
        <div>
          <p class="order-id">${escapeHtml(orderNumber)}</p>
          <p class="order-meta">${escapeHtml(o.storeName || '')}</p>
        </div>
        <span class="order-status-tag status-${status.toLowerCase()}">${STATUS_LABEL[status] || status}</span>
      </div>
      <button type="button" class="chat-btn">💬 Chat dengan Toko</button>
    `;
    el.addEventListener('click', () => openBuyerOrderDetail(o));
    el.querySelector('.chat-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openOrderChat({
        sellerUid: o.sellerUid,
        orderId: o.id,
        orderNumber,
        otherPartyLabel: o.storeName || 'Toko',
        returnScreen: 'screen-buyer-orders',
      });
    });
    wrap.appendChild(el);
  });
}

/**
 * Rute pengiriman satu pesanan (Pembeli): Sedang diproses → Dikirim → Konfirmasi Paket.
 * Tombol "Konfirmasi Paket" hanya aktif saat status KIRIM, dan begitu ditekan,
 * status berubah otomatis jadi SELESAI (dicatat tanggal & jam-nya) dan tidak bisa diubah lagi.
 */
function openBuyerOrderDetail(order) {
  currentBuyerOrder = order;
  const status = order.status || 'PROSES';
  const orderNumber = order.orderNumber || order.id.slice(-6).toUpperCase();

  document.getElementById('bod-order-number').textContent = `#${orderNumber}`;
  document.getElementById('bod-store-name').textContent = order.storeName || 'Toko';

  const order3 = ['PROSES', 'KIRIM', 'SELESAI'];
  const currentIdx = order3.indexOf(status);
  document.querySelectorAll('#bod-tracking-route .tracking-step').forEach(stepEl => {
    const stepIdx = order3.indexOf(stepEl.dataset.step);
    stepEl.classList.remove('done', 'current');
    if (stepIdx < currentIdx) stepEl.classList.add('done');
    else if (stepIdx === currentIdx) stepEl.classList.add(status === 'SELESAI' ? 'done' : 'current');
  });

  const confirmBtn = document.getElementById('btn-confirm-package');
  const confirmedNote = document.getElementById('bod-confirmed-note');
  const receivedDesc = document.getElementById('bod-received-desc');

  if (status === 'SELESAI') {
    confirmBtn.hidden = true;
    confirmedNote.hidden = false;
    confirmedNote.textContent = `Paket sudah diterima, pesanan selesai${order.receivedAt ? ` — ${formatDateTime(order.receivedAt)}` : ''}`;
    receivedDesc.textContent = 'Paket sudah kamu terima';
  } else {
    confirmedNote.hidden = true;
    receivedDesc.textContent = 'Tunggu paket sampai, lalu konfirmasi di sini';
    confirmBtn.hidden = status !== 'KIRIM';
  }

  showScreen('screen-buyer-order-detail');
}

async function confirmPackageReceived() {
  if (!currentBuyerOrder || !ensureFirebaseReady()) return;
  const btn = document.getElementById('btn-confirm-package');
  btn.disabled = true;
  try {
    const update = { status: 'SELESAI', receivedAt: fbStoreFns.serverTimestamp() };
    await fbStoreFns.updateDoc(
      fbStoreFns.doc(db, COLLECTION_BY_ROLE.BUYER, currentProfile.uid, 'orders', currentBuyerOrder.id),
      update
    );
    await fbStoreFns.updateDoc(
      fbStoreFns.doc(db, COLLECTION_BY_ROLE.SELLER, currentBuyerOrder.sellerUid, 'orders', currentBuyerOrder.id),
      update
    );
    currentBuyerOrder = { ...currentBuyerOrder, status: 'SELESAI', receivedAt: { seconds: Math.floor(Date.now() / 1000) } };
    showToast('Paket dikonfirmasi diterima');
    openBuyerOrderDetail(currentBuyerOrder);
  } catch (err) {
    showToast('Gagal konfirmasi: ' + friendlyAuthError(err));
    btn.disabled = false;
  }
}

// ===================================================================
// CHAT PESANAN — antara Pembeli dan Penjual per pesanan
// Disimpan di: admin_seller/{sellerUid}/orders/{orderId}/chats/{msgId}
// ===================================================================
function openOrderChat({ sellerUid, orderId, orderNumber, otherPartyLabel, returnScreen }) {
  activeChatContext = { sellerUid, orderId, orderNumber, otherPartyLabel, returnScreen };

  document.getElementById('chat-order-number').textContent = orderNumber;
  document.getElementById('chat-other-party').textContent = otherPartyLabel;
  document.getElementById('chat-messages').innerHTML = '';
  document.getElementById('chat-input').value = '';
  showScreen('screen-order-chat');

  if (activeChatUnsub) { activeChatUnsub(); activeChatUnsub = null; }
  if (!ensureFirebaseReady()) return;

  try {
    const chatCol = fbStoreFns.collection(db, COLLECTION_BY_ROLE.SELLER, sellerUid, 'orders', orderId, 'chats');
    const q = fbStoreFns.query(chatCol, fbStoreFns.orderBy('createdAt', 'asc'));
    activeChatUnsub = fbStoreFns.onSnapshot(
      q,
      (snap) => renderChatMessages(snap.docs.map(d => d.data())),
      (err) => showToast('Gagal memuat chat: ' + err.message)
    );
  } catch (err) {
    showToast('Gagal membuka chat: ' + err.message);
  }
}

function goBackFromChat() {
  const target = activeChatContext?.returnScreen || 'screen-dashboard';
  if (activeChatUnsub) { activeChatUnsub(); activeChatUnsub = null; }
  activeChatContext = null;
  showScreen(target);
}

function renderChatMessages(messages) {
  const wrap = document.getElementById('chat-messages');
  wrap.innerHTML = '';
  if (messages.length === 0) {
    wrap.appendChild(emptyStateEl('💬', 'Belum ada pesan. Mulai obrolan sekarang.'));
    return;
  }
  messages.forEach(m => {
    const mine = m.senderRole === currentProfile?.role;
    const el = document.createElement('div');
    el.className = 'chat-bubble ' + (mine ? 'mine' : 'theirs');
    el.innerHTML = `<span class="sender">${escapeHtml(m.senderName || '')}</span>${escapeHtml(m.message || '')}`;
    wrap.appendChild(el);
  });
  wrap.scrollTop = wrap.scrollHeight;
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !activeChatContext) return;
  if (!ensureFirebaseReady()) { showToast('Layanan belum siap, coba muat ulang halaman'); return; }

  const { sellerUid, orderId } = activeChatContext;
  const senderName = currentProfile.role === 'SELLER' ? currentProfile.storeName : currentProfile.name;

  input.value = '';
  try {
    await fbStoreFns.addDoc(
      fbStoreFns.collection(db, COLLECTION_BY_ROLE.SELLER, sellerUid, 'orders', orderId, 'chats'),
      {
        senderRole: currentProfile.role,
        senderUid: currentProfile.uid,
        senderName,
        message: text,
        createdAt: fbStoreFns.serverTimestamp(),
      }
    );
  } catch (err) {
    showToast('Gagal mengirim pesan: ' + friendlyAuthError(err));
    input.value = text; // kembalikan teks jika gagal terkirim
  }
}

// ===================================================================
// EVENT WIRING — dijalankan segera, TIDAK menunggu Firebase selesai dimuat
// ===================================================================
document.addEventListener('DOMContentLoaded', () => {
  // Splash
  document.getElementById('screen-splash').addEventListener('click', goPastSplash);
  setTimeout(goPastSplash, 2200);

  // Install PWA
  document.getElementById('btn-install-app').addEventListener('click', async () => {
    if (!deferredInstallPrompt) {
      showToast('Instalasi tidak tersedia di browser ini');
      return;
    }
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    document.getElementById('btn-install-app').hidden = true;
  });

  // Login / Register
  document.getElementById('btn-login').addEventListener('click', handleLogin);
  document.getElementById('btn-register').addEventListener('click', handleRegister);
  document.getElementById('link-to-register').addEventListener('click', (e) => {
    e.preventDefault();
    showScreen('screen-register');
  });
  document.getElementById('link-to-login').addEventListener('click', (e) => {
    e.preventDefault();
    showScreen('screen-login');
  });
  document.querySelectorAll('.back').forEach(btn => {
    btn.addEventListener('click', () => showScreen(btn.dataset.back));
  });

  // Role toggle di halaman Daftar
  const roleToggle = document.getElementById('register-role-toggle');
  roleToggle.querySelectorAll('.role-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      roleToggle.querySelectorAll('.role-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      registerRole = btn.dataset.role;
      document.getElementById('register-fields-buyer').hidden = registerRole !== 'BUYER';
      document.getElementById('register-fields-seller').hidden = registerRole !== 'SELLER';
    });
  });

  // Profil
  document.getElementById('btn-open-profile').addEventListener('click', openProfile);
  document.getElementById('btn-dashboard-location').addEventListener('click', () => {
    if (currentProfile && currentProfile.role !== 'SELLER') detectBuyerLocation();
  });
  document.getElementById('btn-close-profile').addEventListener('click', closeProfile);
  document.getElementById('btn-edit-profile').addEventListener('click', () => setProfileEditing(true));
  document.getElementById('btn-save-profile').addEventListener('click', saveProfile);
  document.getElementById('btn-open-profile-location').addEventListener('click', () => openLocationPicker('profile'));
  document.getElementById('btn-logout').addEventListener('click', handleLogout);

  // Pilih Lokasi (dipakai bersama Checkout Pembeli & Profil Penjual)
  document.getElementById('btn-lp-back').addEventListener('click', closeLocationPicker);
  document.getElementById('btn-lp-save').addEventListener('click', closeLocationPicker);
  document.getElementById('btn-open-checkout-location').addEventListener('click', () => openLocationPicker('checkout'));

  // Pembeli: kategori & checkout
  document.querySelectorAll('.category-tile[data-category]').forEach(tile => {
    tile.addEventListener('click', () => openCategory(tile.dataset.category));
  });
  document.getElementById('btn-go-checkout').addEventListener('click', openCheckoutScreen);
  document.getElementById('btn-confirm-order').addEventListener('click', handleConfirmOrder);
  document.getElementById('tile-buyer-orders').addEventListener('click', openBuyerOrders);

  // Pembeli: pencarian dari dashboard
  document.getElementById('dashboard-search-bar').addEventListener('click', (e) => {
    if (e.target.closest('.search-icon')) handleDashboardSearch();
  });
  document.getElementById('dashboard-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleDashboardSearch(); }
  });

  // Pembeli: detail pesanan & konfirmasi paket
  document.getElementById('btn-confirm-package').addEventListener('click', confirmPackageReceived);
  document.getElementById('bod-chat-btn').addEventListener('click', () => {
    if (currentBuyerOrder) {
      openOrderChat({
        sellerUid: currentBuyerOrder.sellerUid,
        orderId: currentBuyerOrder.id,
        orderNumber: currentBuyerOrder.orderNumber || currentBuyerOrder.id.slice(-6).toUpperCase(),
        otherPartyLabel: currentBuyerOrder.storeName || 'Toko',
        returnScreen: 'screen-buyer-order-detail',
      });
    }
  });

  // Detail produk (layar penuh)
  document.getElementById('detail-qty-minus').addEventListener('click', () => changeDetailQty(-1));
  document.getElementById('detail-qty-add').addEventListener('click', () => changeDetailQty(1));
  document.getElementById('btn-detail-add-to-cart').addEventListener('click', confirmAddFromDetail);

  // Chat pesanan
  document.getElementById('btn-chat-back').addEventListener('click', goBackFromChat);
  document.getElementById('btn-chat-send').addEventListener('click', sendChatMessage);
  document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendChatMessage(); }
  });

  // Penjual: menu toko
  document.getElementById('tile-seller-produk').addEventListener('click', openSellerProducts);
  document.getElementById('tile-seller-pesanan').addEventListener('click', openSellerOrders);
  document.getElementById('tile-seller-toko').addEventListener('click', openSellerStoreView);
  document.getElementById('btn-add-product-row').addEventListener('click', () => openProductEditScreen(null));
  document.getElementById('btn-toggle-edit-product').addEventListener('click', () => setProductEditing(true));
  document.getElementById('btn-save-product').addEventListener('click', saveProduct);
  document.getElementById('btn-delete-product').addEventListener('click', deleteCurrentProduct);
  document.querySelectorAll('.photo-input').forEach(inp => inp.addEventListener('change', handlePhotoSlotChange));

  // Firebase dimuat setelah semua listener UI terpasang.
  setupFirebase();
});
