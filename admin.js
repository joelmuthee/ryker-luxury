// Ryker Luxury Admin
const ADMIN_PASSWORD = 'ryker123';
const API_BASE = 'https://rykerluxury-api.stawisystems.workers.dev';
const ADMIN_TOKEN = atob('cnlrZXItYWRtaW4tdG9rZW4tMjAyNi1zZWN1cmU=');

let bags = [];
let settings = {};
let editingId = null;
let stagedImage = null; // { base64, ext, dataUrl }
let pendingSaleId = null;
let pendingRestockId = null;

// ====== AUTH ======
const loginScreen = document.getElementById('loginScreen');
const dashboard = document.getElementById('dashboard');
const loginBtn = document.getElementById('loginBtn');
const loginPassword = document.getElementById('loginPassword');
const loginError = document.getElementById('loginError');

function checkAuth() {
  if (sessionStorage.getItem('ryker_auth') === '1') {
    loginScreen.style.display = 'none';
    dashboard.style.display = 'block';
    init();
  }
}
loginBtn.addEventListener('click', login);
loginPassword.addEventListener('keypress', e => { if (e.key === 'Enter') login(); });
function login() {
  if (loginPassword.value === ADMIN_PASSWORD) {
    sessionStorage.setItem('ryker_auth', '1');
    loginError.style.display = 'none';
    checkAuth();
  } else {
    loginError.style.display = 'block';
  }
}
document.getElementById('logoutBtn').addEventListener('click', () => {
  sessionStorage.removeItem('ryker_auth');
  location.reload();
});

// ====== API ======
async function apiUploadImage(base64, ext) {
  const res = await fetch(`${API_BASE}/api/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ base64, ext }),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `Upload failed: ${res.status}`); }
  const data = await res.json();
  return `${API_BASE}${data.path}`;
}

async function apiPublish() {
  const res = await fetch(`${API_BASE}/api/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ bags, settings }),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `Save failed: ${res.status}`); }
}

async function loadData() {
  const res = await fetch(`${API_BASE}/api/bags?_=${Date.now()}`);
  const json = await res.json();
  bags = json.bags || [];
  settings = json.settings || {};
}

// ====== HELPERS ======
const toast = document.getElementById('toast');
function showToast(msg) { toast.textContent = msg; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2800); }

function setSaving(on) {
  const btn = document.getElementById('saveBtn');
  btn.disabled = on;
  btn.textContent = on ? 'Publishing…' : 'Save item';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtKsh(n) { return 'Ksh ' + Number(n || 0).toLocaleString('en-KE'); }

function totalStock(item) {
  if (!item.stock) return 0;
  return Object.values(item.stock).reduce((s, q) => s + (Number(q) || 0), 0);
}

function isSoldOut(item) { return totalStock(item) === 0; }

function allSales(item) { return item.sales || []; }

function totalUnitsSold(item) {
  return allSales(item).reduce((s, r) => s + (Number(r.qty) || 1), 0);
}

function totalRevenue(item) {
  return allSales(item).reduce((s, r) => s + (Number(r.salePrice || item.price) * (Number(r.qty) || 1)), 0);
}

// ====== IMAGES ======
const imageInput = document.getElementById('imageInput');
const imagePreview = document.getElementById('imagePreview');
imageInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    stagedImage = { base64: dataUrl.split(',')[1], ext, dataUrl };
    imagePreview.innerHTML = `<img src="${dataUrl}" style="max-width:180px;border-radius:8px;margin-top:4px;">`;
  };
  reader.readAsDataURL(file);
});

// Additional images: array of { base64, ext, dataUrl } OR { url } (already-uploaded)
let stagedExtras = [];
const extraImagesInput = document.getElementById('extraImagesInput');
const extraImagesPreview = document.getElementById('extraImagesPreview');

function readFileAsStaged(file) {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      resolve({ base64: dataUrl.split(',')[1], ext, dataUrl });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

extraImagesInput?.addEventListener('change', async e => {
  const files = [...e.target.files];
  for (const f of files) {
    if (stagedExtras.length >= 8) break;
    try {
      const staged = await readFileAsStaged(f);
      stagedExtras.push(staged);
    } catch (_) {}
  }
  renderExtraImagesPreview();
  e.target.value = ''; // allow re-selecting the same file
});

function renderExtraImagesPreview() {
  if (!extraImagesPreview) return;
  if (!stagedExtras.length) { extraImagesPreview.innerHTML = ''; return; }
  extraImagesPreview.innerHTML = stagedExtras.map((s, i) => `
    <div class="extra-img-thumb">
      <img src="${s.dataUrl || s.url}" alt="Additional image ${i + 1}">
      <button class="extra-img-remove" data-extra-remove="${i}" aria-label="Remove" title="Remove">×</button>
    </div>
  `).join('');
  extraImagesPreview.querySelectorAll('[data-extra-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.extraRemove, 10);
      stagedExtras.splice(idx, 1);
      renderExtraImagesPreview();
    });
  });
}

// ====== IG QUICK-ADD ======
// State: when a user fetches via IG, we hold the post URL so it's saved on the item.
let stagedInstagramUrl = '';

document.getElementById('igQuickBtn')?.addEventListener('click', async () => {
  const url = document.getElementById('igQuickInput').value.trim();
  const status = document.getElementById('igQuickStatus');
  if (!url) { status.textContent = 'Paste an Instagram URL first.'; status.className = 'ig-quick-status err'; return; }
  if (!/instagram\.com\/(?:p|reel|tv)\//i.test(url)) { status.textContent = 'That doesn\'t look like an IG post URL.'; status.className = 'ig-quick-status err'; return; }

  status.textContent = 'Fetching from Instagram…';
  status.className = 'ig-quick-status';

  try {
    const r = await fetch(`${API_BASE}/api/ig-fetch?url=${encodeURIComponent(url)}`);
    const data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || 'Fetch failed');

    // Download the cover (first image) through the browser, stage as main image
    async function downloadAndStage(url) {
      const r = await fetch(url);
      if (!r.ok) throw new Error('Image download failed');
      const blob = await r.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          resolve({ base64: dataUrl.split(',')[1], ext: 'jpg', dataUrl });
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }

    stagedImage = await downloadAndStage(data.imageUrl);
    imagePreview.innerHTML = `<img src="${stagedImage.dataUrl}" style="max-width:180px;border-radius:8px;margin-top:4px;">`;

    // If carousel, download additional images too
    stagedExtras = [];
    const extras = (data.imageUrls || []).slice(1);
    if (extras.length) {
      status.textContent = `Downloading ${extras.length} more image${extras.length === 1 ? '' : 's'}…`;
      for (const u of extras) {
        try { stagedExtras.push(await downloadAndStage(u)); } catch (_) {}
      }
      renderExtraImagesPreview();
    }

    // Auto-fill description from caption (strip the "username" prefix some IG embeds add)
    const cap = (data.caption || '').replace(/^[a-z0-9._]+\s+/i, '').trim();
    document.getElementById('descInput').value = cap;

    // Suggest a name from the first sentence
    if (!document.getElementById('nameInput').value && cap) {
      const firstLine = cap.split(/[.!?\n]/)[0].trim().slice(0, 60);
      document.getElementById('nameInput').value = firstLine.charAt(0).toUpperCase() + firstLine.slice(1);
    }

    stagedInstagramUrl = data.postUrl;
    status.textContent = '✓ Image and caption loaded. Review the name, category, price and stock, then Save.';
    status.className = 'ig-quick-status ok';
  } catch (err) {
    status.textContent = '✗ ' + err.message + ' — paste image and write description manually instead.';
    status.className = 'ig-quick-status err';
  }
});

// ====== STOCK READ/WRITE ======
function getStockFromForm() {
  const stock = {};
  document.querySelectorAll('.stock-qty').forEach(inp => {
    const size = inp.dataset.size;
    const val = parseInt(inp.value, 10);
    if (!isNaN(val) && val > 0) stock[size] = val;
  });
  return stock;
}

function setStockToForm(stock) {
  document.querySelectorAll('.stock-qty').forEach(inp => {
    const size = inp.dataset.size;
    inp.value = stock && stock[size] > 0 ? stock[size] : '';
  });
}

function clearStockForm() {
  document.querySelectorAll('.stock-qty').forEach(inp => { inp.value = ''; });
}

// ====== AI DESCRIPTION ======
document.getElementById('aiBtn').addEventListener('click', () => {
  const name = document.getElementById('nameInput').value.trim();
  const cat = document.getElementById('categoryInput').value;
  if (!name) { showToast('Enter the item name first.'); return; }
  document.getElementById('descInput').value = generateDescription(name, cat);
});

function generateDescription(name, cat) {
  const lower = name.toLowerCase();
  const colors = { black: 'sleek black', white: 'crisp white', navy: 'deep navy', grey: 'cool grey', gray: 'cool grey', blue: 'rich blue', brown: 'warm brown', khaki: 'classic khaki', beige: 'warm beige', cream: 'soft cream', olive: 'olive green', red: 'bold red' };
  let color = '';
  for (const c in colors) if (lower.includes(c)) { color = colors[c]; break; }

  const catMap = {
    Tshirts: 'tee', Shirts: 'shirt', Polos: 'polo', Jeans: 'jeans', Shorts: 'shorts',
    Joggers: 'joggers', Tracksuits: 'tracksuit', Hoodies: 'hoodie', Jackets: 'jacket', Suits: 'suit',
    Shoes: 'pair of shoes', Sneakers: 'pair of sneakers', Boots: 'pair of boots',
    Caps: 'cap', Belts: 'belt', Watches: 'watch', Jewellery: 'piece', Rings: 'ring', Chains: 'chain', Earrings: 'earrings', Accessories: 'piece',
  };
  const type = catMap[cat] || 'piece';

  const openers = [
    `Sharp ${color || 'premium'} ${type} — made for the man who doesn't settle.`,
    `A clean ${color || 'quality'} ${type} that earns its place in any rotation.`,
    `${color ? color.charAt(0).toUpperCase() + color.slice(1) : 'Premium'} ${type}, new stock. Built to last, styled to stand out.`,
  ];
  const mids = [
    `New item — quality-checked before listing.`,
    `Fresh in. Every detail done right.`,
    `Brand new, ready to wear.`,
  ];
  const closes = [
    `Tap Enquire to chat with us on WhatsApp.`,
    `Available sizes listed — tap Enquire to confirm and pay.`,
    `Pick up at Legend Valley Business Park, Gitanga Road or we deliver.`,
  ];
  return [openers[Math.floor(Math.random() * openers.length)], mids[Math.floor(Math.random() * mids.length)], closes[Math.floor(Math.random() * closes.length)]].join(' ');
}

// ====== SAVE ITEM ======
document.getElementById('saveBtn').addEventListener('click', saveItem);
document.getElementById('cancelBtn').addEventListener('click', resetForm);

async function saveItem() {
  const name = document.getElementById('nameInput').value.trim();
  const price = parseInt(document.getElementById('priceInput').value, 10);
  const desc = document.getElementById('descInput').value.trim();
  const category = document.getElementById('categoryInput').value || '';
  const branch = document.getElementById('branchInput')?.value || '';
  const stock = getStockFromForm();

  if (!name) { showToast('Item name is required.'); return; }
  if (!price || price < 0) { showToast('Enter a valid price.'); return; }

  setSaving(true);
  try {
    let imagePath = null;
    if (stagedImage) {
      showToast('Uploading image…');
      imagePath = await apiUploadImage(stagedImage.base64, stagedImage.ext);
    }

    // Upload any newly-added extras (ones with base64), keep already-uploaded ones (.url)
    let extraUrls = [];
    if (stagedExtras.length) {
      showToast(`Uploading ${stagedExtras.length} additional image${stagedExtras.length === 1 ? '' : 's'}…`);
      for (const s of stagedExtras) {
        if (s.url) { extraUrls.push(s.url); continue; }
        const p = await apiUploadImage(s.base64, s.ext);
        extraUrls.push(p);
      }
    }

    if (editingId) {
      const bag = bags.find(b => b.id === editingId);
      if (!bag) return;
      bag.name = name;
      bag.category = category;
      bag.description = desc;
      bag.price = price;
      bag.branch = branch || undefined;
      bag.stock = { ...bag.stock, ...stock };
      // On edit, additional images = whatever is currently in stagedExtras (which we pre-populated from the bag)
      bag.images = extraUrls.length ? [imagePath || bag.image, ...extraUrls] : (imagePath ? [imagePath] : (bag.images || []));
      // Strip the lead since image field stays as the primary
      if (bag.images.length) bag.images = bag.images.filter((u, i, a) => u && a.indexOf(u) === i);
      // Remove sizes set to 0 if they are explicitly cleared in the form
      document.querySelectorAll('.stock-qty').forEach(inp => {
        const sz = inp.dataset.size;
        const val = parseInt(inp.value, 10);
        if (!isNaN(val) && val === 0) delete bag.stock[sz];
        else if (inp.value === '') delete bag.stock[sz];
      });
      if (imagePath) bag.image = imagePath;
      await apiPublish();
      showToast('Item updated and live!');
    } else {
      if (!stagedImage) { showToast('Add an item image.'); setSaving(false); return; }
      const id = 'item_' + Date.now();
      const newBag = { id, name, category, description: desc, price, stock, sales: [], image: imagePath, createdAt: new Date().toISOString() };
      if (extraUrls.length) newBag.images = [imagePath, ...extraUrls];
      if (stagedInstagramUrl) newBag.instagramUrl = stagedInstagramUrl;
      if (branch) newBag.branch = branch;
      bags.unshift(newBag);
      await apiPublish();
      showToast('Item added and live!');
    }
    resetForm();
    renderList();
    renderDashboard();
    renderInventory();
  } catch (err) {
    showToast('Error: ' + err.message);
    console.error(err);
  } finally {
    setSaving(false);
  }
}

function resetForm() {
  editingId = null;
  document.getElementById('editingId').value = '';
  document.getElementById('nameInput').value = '';
  document.getElementById('categoryInput').value = '';
  document.getElementById('descInput').value = '';
  document.getElementById('priceInput').value = '';
  const br = document.getElementById('branchInput');
  if (br) br.value = '';
  clearStockForm();
  imageInput.value = '';
  imagePreview.innerHTML = '';
  stagedImage = null;
  stagedExtras = [];
  renderExtraImagesPreview();
  stagedInstagramUrl = '';
  const igInput = document.getElementById('igQuickInput');
  if (igInput) igInput.value = '';
  const igStatus = document.getElementById('igQuickStatus');
  if (igStatus) { igStatus.textContent = ''; igStatus.className = 'ig-quick-status'; }
  document.getElementById('formTitle').textContent = 'Add a new item';
  document.getElementById('cancelBtn').style.display = 'none';
}

function editItem(id) {
  const bag = bags.find(b => b.id === id);
  if (!bag) return;
  editingId = id;
  document.getElementById('editingId').value = id;
  document.getElementById('nameInput').value = bag.name;
  document.getElementById('categoryInput').value = bag.category || '';
  document.getElementById('descInput').value = bag.description || '';
  document.getElementById('priceInput').value = bag.price;
  const br = document.getElementById('branchInput');
  if (br) br.value = bag.branch || '';
  setStockToForm(bag.stock || {});
  stagedImage = null;
  imagePreview.innerHTML = `<img src="${bag.image}" style="max-width:180px;border-radius:8px;">`;
  // Pre-populate stagedExtras from the bag's images[] (skip the lead image which is the main)
  stagedExtras = ((bag.images && bag.images.length > 1) ? bag.images.slice(1) : []).map(url => ({ url }));
  renderExtraImagesPreview();
  document.getElementById('formTitle').textContent = 'Edit item';
  document.getElementById('cancelBtn').style.display = 'inline-block';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteItem(id) {
  if (!confirm('Delete this item? This cannot be undone.')) return;
  bags = bags.filter(b => b.id !== id);
  try {
    await apiPublish();
    renderList();
    renderDashboard();
    renderInventory();
    showToast('Item deleted.');
  } catch (err) { showToast('Error: ' + err.message); }
}

// ====== RECORD SALE MODAL ======
const saleModal = document.getElementById('saleModal');
const saleSizeInput = document.getElementById('saleSizeInput');
const saleQtyInput = document.getElementById('saleQtyInput');
const salePriceInput = document.getElementById('salePriceInput');
const buyerName = document.getElementById('buyerName');
const buyerPhone = document.getElementById('buyerPhone');
const buyerNotes = document.getElementById('buyerNotes');

function openSaleModal(id) {
  const bag = bags.find(b => b.id === id);
  if (!bag) return;
  pendingSaleId = id;
  document.getElementById('saleModalTitle').textContent = `Record sale: ${bag.name}`;
  saleSizeInput.innerHTML = '';
  const stock = bag.stock || {};
  const hasSizes = Object.keys(stock).length > 0;
  if (hasSizes) {
    Object.entries(stock).filter(([, q]) => q > 0).forEach(([sz, q]) => {
      const opt = document.createElement('option');
      opt.value = sz;
      opt.textContent = `${sz} (${q} in stock)`;
      saleSizeInput.appendChild(opt);
    });
    if (!saleSizeInput.options.length) {
      showToast('All sizes are out of stock.'); return;
    }
  } else {
    const opt = document.createElement('option'); opt.value = 'One size'; opt.textContent = 'One size'; saleSizeInput.appendChild(opt);
  }
  saleQtyInput.value = 1;
  salePriceInput.value = bag.price;
  buyerName.value = '';
  buyerPhone.value = '';
  buyerNotes.value = '';
  saleModal.style.display = 'flex';
  buyerName.focus();
}

function closeSaleModal() { saleModal.style.display = 'none'; pendingSaleId = null; }

document.getElementById('saleSaveBtn').addEventListener('click', async () => {
  const bag = bags.find(b => b.id === pendingSaleId);
  if (!bag) return;
  const size = saleSizeInput.value;
  const qty = parseInt(saleQtyInput.value, 10) || 1;
  const salePrice = parseInt(salePriceInput.value, 10) || bag.price;

  // Reduce stock
  if (bag.stock && bag.stock[size] !== undefined) {
    bag.stock[size] = Math.max(0, bag.stock[size] - qty);
  }

  // Record sale
  if (!bag.sales) bag.sales = [];
  bag.sales.push({
    size,
    qty,
    salePrice,
    buyerName: buyerName.value.trim(),
    buyerPhone: buyerPhone.value.trim(),
    notes: buyerNotes.value.trim(),
    soldAt: new Date().toISOString(),
  });

  closeSaleModal();
  try {
    await apiPublish();
    renderList();
    renderDashboard();
    renderInventory();
    showToast(`Sale recorded — ${qty}× ${size} sold.`);
    if (buyerName.value.trim() || buyerPhone.value.trim()) sendBuyerToGHL(bag, bag.sales[bag.sales.length - 1]);
  } catch (err) { showToast('Error: ' + err.message); }
});

document.getElementById('saleCancelBtn').addEventListener('click', closeSaleModal);
saleModal.addEventListener('click', e => { if (e.target === saleModal) closeSaleModal(); });

// ====== RESTOCK MODAL ======
const restockModal = document.getElementById('restockModal');
const restockSizeInput = document.getElementById('restockSizeInput');
const restockQtyInput = document.getElementById('restockQtyInput');

function openRestockModal(id) {
  const bag = bags.find(b => b.id === id);
  if (!bag) return;
  pendingRestockId = id;
  document.getElementById('restockModalTitle').textContent = `Restock: ${bag.name}`;
  restockSizeInput.innerHTML = '';
  const ALL_SIZES = ['XS','S','M','L','XL','XXL','3XL','28','30','32','34','36','38','40','UK6','UK7','UK8','UK9','UK10','UK11','UK12'];
  ALL_SIZES.forEach(sz => {
    const opt = document.createElement('option'); opt.value = sz;
    const cur = bag.stock?.[sz] || 0;
    opt.textContent = `${sz} (currently ${cur})`;
    restockSizeInput.appendChild(opt);
  });
  restockQtyInput.value = 5;
  restockModal.style.display = 'flex';
}

function closeRestockModal() { restockModal.style.display = 'none'; pendingRestockId = null; }

document.getElementById('restockSaveBtn').addEventListener('click', async () => {
  const bag = bags.find(b => b.id === pendingRestockId);
  if (!bag) return;
  const size = restockSizeInput.value;
  const qty = parseInt(restockQtyInput.value, 10) || 0;
  if (qty <= 0) { showToast('Enter a quantity to add.'); return; }
  if (!bag.stock) bag.stock = {};
  bag.stock[size] = (bag.stock[size] || 0) + qty;
  closeRestockModal();
  try {
    await apiPublish();
    renderList();
    renderInventory();
    showToast(`+${qty} ${size} added to stock.`);
  } catch (err) { showToast('Error: ' + err.message); }
});

document.getElementById('restockCancelBtn').addEventListener('click', closeRestockModal);
restockModal.addEventListener('click', e => { if (e.target === restockModal) closeRestockModal(); });

// ====== GHL INTEGRATION ======
const GHL_RECAPTCHA_KEY = '6LeDBFwpAAAAAJe8ux9-imrqZ2ueRsEtdiWoDDpX';
async function getCaptchaToken() {
  if (!window.grecaptcha?.enterprise) return '';
  return new Promise(resolve => {
    grecaptcha.enterprise.ready(async () => {
      try { resolve(await grecaptcha.enterprise.execute(GHL_RECAPTCHA_KEY, { action: 'submit' })); }
      catch (e) { resolve(''); }
    });
  });
}
async function sendBuyerToGHL(bag, sale) {
  try {
    const captchaV3 = await getCaptchaToken();
    await fetch(`${API_BASE}/api/buyer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: sale.buyerName, phone: sale.buyerPhone,
        notes: sale.notes,
        bag_name: `${bag.name} (${sale.size})`,
        bag_price: sale.salePrice || bag.price,
        captchaV3,
      }),
    });
  } catch (err) { console.warn('GHL submit failed:', err); }
}

// ====== DASHBOARD ======
function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function startOfWeek(d) { const x = startOfDay(d); const dow = (x.getDay() + 6) % 7; x.setDate(x.getDate() - dow); return x; }
function startOfMonth(d) { const x = new Date(d.getFullYear(), d.getMonth(), 1); x.setHours(0,0,0,0); return x; }
function relTime(iso) {
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (sec < 60) return 'just now';
  if (sec < 3600) return Math.floor(sec/60) + 'm ago';
  if (sec < 86400) return Math.floor(sec/3600) + 'h ago';
  const days = Math.floor(sec/86400);
  if (days === 1) return 'yesterday';
  if (days < 30) return days + 'd ago';
  return new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
}

function renderDashboard() {
  const now = new Date();
  const buckets = [
    { label: 'Today',      since: startOfDay(now) },
    { label: 'This week',  since: startOfWeek(now) },
    { label: 'This month', since: startOfMonth(now) },
    { label: 'All time',   since: null },
  ].map(b => {
    let count = 0, revenue = 0;
    bags.forEach(bag => {
      (bag.sales || []).forEach(s => {
        if (!b.since || new Date(s.soldAt) >= b.since) {
          count += Number(s.qty) || 1;
          revenue += (Number(s.salePrice || bag.price)) * (Number(s.qty) || 1);
        }
      });
    });
    return { ...b, count, revenue };
  });

  document.getElementById('kpiGrid').innerHTML = buckets.map(b => `
    <div class="kpi-card">
      <div class="kpi-label">${b.label}</div>
      <div class="kpi-count">${b.count} <span class="kpi-unit">units</span></div>
      <div class="kpi-revenue">${fmtKsh(b.revenue)}</div>
    </div>`).join('');

  // Top categories by units sold
  const catUnits = {}, catRev = {};
  bags.forEach(bag => {
    const cat = bag.category || 'Other';
    (bag.sales || []).forEach(s => {
      catUnits[cat] = (catUnits[cat] || 0) + (Number(s.qty) || 1);
      catRev[cat] = (catRev[cat] || 0) + (Number(s.salePrice || bag.price)) * (Number(s.qty) || 1);
    });
  });
  const cats = Object.entries(catUnits).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxU = cats[0]?.[1] || 1;
  document.getElementById('topCats').innerHTML = cats.length
    ? cats.map(([cat, n]) => `
        <div class="cat-bar">
          <div class="cat-bar-row"><span class="cat-bar-name">${escapeHtml(cat)}</span><span class="cat-bar-meta">${n} sold · ${fmtKsh(catRev[cat])}</span></div>
          <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${(n/maxU)*100}%"></div></div>
        </div>`).join('')
    : '<p style="color:#999;font-size:13px;">No sales yet — record your first sale to populate.</p>';

  // Recent sales (all bags, last 6 individual sale records)
  const allSaleRecords = [];
  bags.forEach(bag => (bag.sales || []).forEach(s => allSaleRecords.push({ bag, s })));
  const recent = allSaleRecords.sort((a, b) => new Date(b.s.soldAt) - new Date(a.s.soldAt)).slice(0, 6);
  document.getElementById('recentSales').innerHTML = recent.length
    ? recent.map(({ bag, s }) => `
        <div class="recent-row">
          <img src="${bag.image}" alt="${escapeHtml(bag.name)}">
          <div>
            <div class="recent-name">${escapeHtml(bag.name)} · ${escapeHtml(s.size || '')} × ${s.qty || 1}</div>
            <div class="recent-meta">${fmtKsh(s.salePrice || bag.price)} · ${s.buyerName ? escapeHtml(s.buyerName) : 'No buyer saved'} · ${relTime(s.soldAt)}</div>
          </div>
        </div>`).join('')
    : '<p style="color:#999;font-size:13px;">No sales recorded yet.</p>';
}

// ====== INVENTORY ======
// State for the inventory table view
let invFilter = 'attention'; // 'attention' | 'all'
let invShowAll = false;       // false = cap at INV_PAGE_SIZE
const INV_PAGE_SIZE = 15;

function renderInventory() {
  let totalItems = bags.length;
  let totalUnits = 0, totalValue = 0, lowStock = 0, outOfStock = 0;

  bags.forEach(bag => {
    const units = totalStock(bag);
    totalUnits += units;
    totalValue += units * (bag.price || 0);
    if (units === 0) outOfStock++;
    else if (units <= 5) lowStock++;
  });

  document.getElementById('invKpiGrid').innerHTML = [
    { label: 'Total items', val: totalItems, sub: 'SKUs listed', cls: '' },
    { label: 'Units in stock', val: totalUnits.toLocaleString(), sub: 'across all sizes', cls: 'success' },
    { label: 'Inventory value', val: fmtKsh(totalValue), sub: 'at listed prices', cls: '' },
    { label: 'Low stock', val: lowStock, sub: '≤ 5 units remaining', cls: lowStock > 0 ? 'warn' : '' },
    { label: 'Out of stock', val: outOfStock, sub: 'need restocking', cls: outOfStock > 0 ? 'danger' : '' },
  ].map(k => `
    <div class="inv-kpi ${k.cls}">
      <div class="inv-kpi-label">${k.label}</div>
      <div class="inv-kpi-val">${k.val}</div>
      <div class="inv-kpi-sub">${k.sub}</div>
    </div>`).join('');

  // Build the filter bar
  const attentionBags = bags.filter(b => totalStock(b) <= 5);
  const filterBar = document.getElementById('invFilterBar');
  if (filterBar) {
    filterBar.innerHTML = `
      <button class="pill ${invFilter==='attention'?'active':''}" data-inv-filter="attention">
        Needs attention <span class="admin-nav-count">${attentionBags.length}</span>
      </button>
      <button class="pill ${invFilter==='all'?'active':''}" data-inv-filter="all">
        All items <span class="admin-nav-count">${bags.length}</span>
      </button>
    `;
    filterBar.querySelectorAll('[data-inv-filter]').forEach(b => {
      b.addEventListener('click', () => {
        invFilter = b.dataset.invFilter;
        invShowAll = false;
        renderInventory();
      });
    });
  }

  // Apply filter, sort by lowest stock first
  const filtered = (invFilter === 'attention' ? attentionBags : bags)
    .slice()
    .sort((a, b) => totalStock(a) - totalStock(b));

  // Cap rendering unless showAll is set
  const cap = invShowAll ? filtered.length : Math.min(INV_PAGE_SIZE, filtered.length);
  const sorted = filtered.slice(0, cap);

  // Update sort/count label
  const lbl = document.getElementById('invSortLabel');
  if (lbl) lbl.textContent = `showing ${sorted.length} of ${filtered.length} · sorted low → high`;

  document.getElementById('invTableBody').innerHTML = sorted.map(bag => {
    const units = totalStock(bag);
    const soldUnits = totalUnitsSold(bag);
    const stockEntries = Object.entries(bag.stock || {});
    const stockCells = stockEntries.length
      ? stockEntries.map(([sz, q]) => {
          const cls = q === 0 ? 'zero' : q <= 3 ? 'low' : 'ok';
          return `<span class="stock-cell ${cls}">${escapeHtml(sz)}: ${q}</span>`;
        }).join('')
      : '<span style="color:#999;font-size:12px;">No sizes set</span>';

    const statusCls = units === 0 ? 'zero' : units <= 5 ? 'low' : 'ok';
    const statusLabel = units === 0 ? 'Out of stock' : units <= 5 ? 'Low stock' : 'In stock';

    return `
    <tr>
      <td><img class="item-img" src="${bag.image}" alt="${escapeHtml(bag.name)}"></td>
      <td>
        <div style="font-weight:600;font-size:13px;">${escapeHtml(bag.name)}</div>
        <div style="font-size:11px;color:#999;margin-top:2px;">${soldUnits} sold · ${fmtKsh(totalRevenue(bag))} revenue</div>
      </td>
      <td style="font-size:13px;">${escapeHtml(bag.category || '—')}</td>
      <td style="font-size:13px;font-weight:600;">${fmtKsh(bag.price)}</td>
      <td><div class="stock-cells">${stockCells}</div></td>
      <td style="font-weight:700;font-size:14px;">${units}</td>
      <td><span class="stock-pill ${statusCls}">${statusLabel}</span></td>
      <td>
        <button class="restock-btn" onclick="openRestockModal('${bag.id}')">+ Restock</button>
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--ink-faint);">${invFilter === 'attention' ? '🎉 Nothing needs attention — all items have healthy stock.' : 'No items yet.'}</td></tr>`;

  // Show-more toggle
  const toggle = document.getElementById('invShowMore');
  if (toggle) {
    if (filtered.length <= INV_PAGE_SIZE) {
      toggle.style.display = 'none';
    } else {
      toggle.style.display = 'block';
      toggle.textContent = invShowAll
        ? `Show fewer (top ${INV_PAGE_SIZE})`
        : `Show all ${filtered.length} items ↓`;
      toggle.onclick = () => { invShowAll = !invShowAll; renderInventory(); };
    }
  }
}

// ====== ITEM LIST ======
let bulkSelected = new Set();

function renderList() {
  const list = document.getElementById('adminList');
  document.getElementById('bagCount').textContent = bags.length;
  const navCount = document.getElementById('navItemCount');
  if (navCount) navCount.textContent = bags.length;
  renderBulkBar();
  list.innerHTML = bags.map(bag => {
    const units = totalStock(bag);
    const sold = totalUnitsSold(bag);
    const stockSummary = Object.entries(bag.stock || {}).map(([sz, q]) => `${sz}:${q}`).join(' · ') || 'No stock set';
    const checked = bulkSelected.has(bag.id);
    return `
    <div class="admin-card ${checked ? 'bulk-selected' : ''}">
      <label class="bulk-check" title="Select for bulk actions">
        <input type="checkbox" data-bulk="${escapeHtml(bag.id)}" ${checked ? 'checked' : ''}>
      </label>
      <img src="${bag.image}" alt="${escapeHtml(bag.name)}">
      <div class="admin-card-body">
        <div class="admin-card-name">${escapeHtml(bag.name)}</div>
        ${bag.category ? `<div style="margin:3px 0;"><span style="background:#f0ede8;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:600;">${escapeHtml(bag.category)}</span></div>` : ''}
        <div class="admin-card-price">${fmtKsh(bag.price)}</div>
        <div class="admin-card-stock">${units} in stock · ${sold} sold | ${stockSummary}</div>
        <div class="admin-card-actions">
          <button onclick="editItem('${bag.id}')">Edit</button>
          <button onclick="openSaleModal('${bag.id}')" style="background:#f0faf4;border-color:#b0d8c0;color:#1a7a40;">Record sale</button>
          <button onclick="openRestockModal('${bag.id}')">Restock</button>
          <button class="danger" onclick="deleteItem('${bag.id}')">Delete</button>
        </div>
      </div>
    </div>`;
  }).join('');

  // Wire up the new checkboxes
  list.querySelectorAll('input[data-bulk]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) bulkSelected.add(cb.dataset.bulk);
      else bulkSelected.delete(cb.dataset.bulk);
      cb.closest('.admin-card').classList.toggle('bulk-selected', cb.checked);
      renderBulkBar();
    });
  });
}

function renderBulkBar() {
  const bar = document.getElementById('bulkActions');
  if (!bar) return;
  if (bulkSelected.size === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  document.getElementById('bulkCount').textContent = bulkSelected.size;
}

function bulkClear() { bulkSelected.clear(); renderList(); }

function bulkSelectAll() {
  bags.forEach(b => bulkSelected.add(b.id));
  renderList();
}

async function bulkDelete() {
  if (!confirm(`Delete ${bulkSelected.size} item(s)? This cannot be undone.`)) return;
  bags = bags.filter(b => !bulkSelected.has(b.id));
  bulkSelected.clear();
  try {
    await apiPublish();
    renderList();
    renderInventory();
    renderDashboard();
    showToast(`Deleted.`);
  } catch (err) {
    showToast('Sync failed: ' + err.message);
  }
}

async function bulkSetCategory() {
  const cat = prompt('Set category for selected items to:\n(use exact name e.g. Polos, Shirts, Jeans, Caps)');
  if (!cat) return;
  bags.forEach(b => { if (bulkSelected.has(b.id)) b.category = cat; });
  try {
    await apiPublish();
    renderList();
    renderInventory();
    showToast(`Set ${bulkSelected.size} item(s) to "${cat}".`);
    bulkSelected.clear();
    renderList();
  } catch (err) {
    showToast('Sync failed: ' + err.message);
  }
}


// ====== INIT ======
window.editItem = editItem;
window.deleteItem = deleteItem;
window.openSaleModal = openSaleModal;
window.openRestockModal = openRestockModal;
window.bulkClear = bulkClear;
window.bulkSelectAll = bulkSelectAll;
window.bulkDelete = bulkDelete;
window.bulkSetCategory = bulkSetCategory;

// ====== WHATSAPP BROADCAST ======
let broadcastSelectedIds = [];
let broadcastRecipientsState = {};  // phone -> { name, included }

function pastBuyers() {
  // Pull unique past buyers from sales history across all items
  const map = new Map();
  for (const bag of bags) {
    for (const s of (bag.sales || [])) {
      if (!s.buyerPhone) continue;
      const phone = String(s.buyerPhone).replace(/[^0-9]/g, '');
      if (phone.length < 9) continue;
      const existing = map.get(phone);
      const soldAt = new Date(s.soldAt || 0).getTime();
      if (!existing || soldAt > existing.soldAt) {
        map.set(phone, { phone, name: s.buyerName || '', soldAt, lastBought: bag.name });
      }
    }
  }
  return [...map.values()].sort((a, b) => b.soldAt - a.soldAt);
}

function renderBroadcastSelected() {
  const wrap = document.getElementById('broadcastSelectedItems');
  if (!wrap) return;
  if (!broadcastSelectedIds.length) { wrap.innerHTML = '<p style="color:var(--ink-faint);font-size:13px;margin:6px 0;">No items selected — message will be text-only.</p>'; return; }
  wrap.innerHTML = broadcastSelectedIds.map(id => {
    const b = bags.find(x => x.id === id);
    if (!b) return '';
    return `<div class="set-chip"><img src="${b.image}" alt=""><span>${escapeHtml(b.name)}</span><button data-bc-remove="${escapeHtml(id)}" aria-label="Remove">×</button></div>`;
  }).join('');
  wrap.querySelectorAll('[data-bc-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      broadcastSelectedIds = broadcastSelectedIds.filter(id => id !== btn.dataset.bcRemove);
      renderBroadcastSelected();
      renderBroadcastPicker();
      renderBroadcastPreview();
    });
  });
}

function renderBroadcastPicker() {
  const picker = document.getElementById('broadcastItemPicker');
  if (!picker) return;
  const q = (document.getElementById('broadcastItemSearch')?.value || '').toLowerCase().trim();
  const matches = bags
    .filter(b => !broadcastSelectedIds.includes(b.id))
    .filter(b => !q || `${b.name} ${b.category || ''}`.toLowerCase().includes(q))
    .slice(0, 40);
  picker.innerHTML = matches.length
    ? matches.map(b => `
        <button class="set-pick" data-bc-add="${escapeHtml(b.id)}" type="button">
          <img src="${b.image}" alt="">
          <div class="set-pick-body">
            <div class="set-pick-name">${escapeHtml(b.name)}</div>
            <div class="set-pick-meta">${escapeHtml(b.category || '')}${b.price > 0 ? ' · ' + fmtKsh(b.price) : ''}</div>
          </div>
        </button>`).join('')
    : '<p style="color:var(--ink-faint);font-size:13px;padding:8px 0;">No matches.</p>';
  picker.querySelectorAll('[data-bc-add]').forEach(b => {
    b.addEventListener('click', () => {
      broadcastSelectedIds.push(b.dataset.bcAdd);
      renderBroadcastSelected();
      renderBroadcastPicker();
      renderBroadcastPreview();
    });
  });
}

function renderBroadcastRecipients() {
  const wrap = document.getElementById('broadcastRecipients');
  if (!wrap) return;
  const buyers = pastBuyers();
  // Initialize state for new buyers
  for (const b of buyers) {
    if (!(b.phone in broadcastRecipientsState)) {
      broadcastRecipientsState[b.phone] = { name: b.name, included: true };
    }
  }
  if (!buyers.length) {
    wrap.innerHTML = '<p style="color:var(--ink-faint);font-size:13px;padding:8px 0;">No past buyers yet — once you record sales with buyer phones, they\'ll show up here.</p>';
    return;
  }
  wrap.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:8px;">
      <button class="btn-admin" type="button" data-bc-recip="all" style="padding:4px 10px;font-size:11px;">Select all</button>
      <button class="btn-admin" type="button" data-bc-recip="none" style="padding:4px 10px;font-size:11px;">Deselect all</button>
      <span style="font-size:12px;color:var(--ink-faint);margin-left:auto;align-self:center;" id="broadcastSelectedCount"></span>
    </div>
    ${buyers.map(b => {
      const st = broadcastRecipientsState[b.phone];
      return `
        <label class="broadcast-recipient${st.included ? ' on' : ''}">
          <input type="checkbox" data-bc-toggle="${b.phone}" ${st.included ? 'checked' : ''}>
          <span class="broadcast-recipient-name">${escapeHtml(b.name || 'Unknown buyer')}</span>
          <span class="broadcast-recipient-phone">+${b.phone}</span>
          <span class="broadcast-recipient-meta">last: ${escapeHtml(b.lastBought)}</span>
        </label>`;
    }).join('')}
  `;
  wrap.querySelectorAll('[data-bc-toggle]').forEach(cb => {
    cb.addEventListener('change', () => {
      broadcastRecipientsState[cb.dataset.bcToggle].included = cb.checked;
      cb.closest('.broadcast-recipient').classList.toggle('on', cb.checked);
      updateBroadcastCount();
    });
  });
  wrap.querySelectorAll('[data-bc-recip]').forEach(btn => {
    btn.addEventListener('click', () => {
      const on = btn.dataset.bcRecip === 'all';
      buyers.forEach(b => { broadcastRecipientsState[b.phone].included = on; });
      renderBroadcastRecipients();
    });
  });
  updateBroadcastCount();
}

function updateBroadcastCount() {
  const el = document.getElementById('broadcastSelectedCount');
  if (!el) return;
  const n = Object.values(broadcastRecipientsState).filter(s => s.included).length;
  el.textContent = `${n} selected`;
}

function buildBroadcastMessage(recipientName) {
  const subject = (document.getElementById('broadcastSubject')?.value || '').trim();
  const items = broadcastSelectedIds.map(id => bags.find(b => b.id === id)).filter(Boolean);
  const itemsBlock = items.length
    ? '\n\n' + items.map((b, i) => `${i + 1}. *${b.name}*${b.price > 0 ? ' — ' + fmtKsh(b.price) : ''}`).join('\n')
    : '';
  const lookUrl = 'https://rykerluxury.essenceautomations.com';
  const greet = recipientName ? `Hi ${recipientName.split(' ')[0]}! ` : 'Hi! ';
  return `${greet}It's Ryker Luxury — ${subject || 'fresh stock just landed'}.${itemsBlock}\n\nTap to browse: ${lookUrl}\n\nReply here to enquire. 🤍`;
}

function renderBroadcastPreview() {
  const preview = document.getElementById('broadcastPreview');
  if (!preview) return;
  preview.value = buildBroadcastMessage('{First name}');
}

document.getElementById('broadcastSubject')?.addEventListener('input', renderBroadcastPreview);
document.getElementById('broadcastItemSearch')?.addEventListener('input', renderBroadcastPicker);

document.getElementById('broadcastCopyBtn')?.addEventListener('click', () => {
  navigator.clipboard.writeText(buildBroadcastMessage(''));
  showToast('Message copied — paste it into your WhatsApp broadcast.');
});

document.getElementById('broadcastStartBtn')?.addEventListener('click', () => {
  const recipients = pastBuyers().filter(b => broadcastRecipientsState[b.phone]?.included);
  if (!recipients.length) { showToast('Pick at least one recipient.'); return; }
  if (!confirm(`Open ${recipients.length} WhatsApp window${recipients.length === 1 ? '' : 's'}, one per buyer. Send each one manually. OK?`)) return;
  let i = 0;
  function next() {
    if (i >= recipients.length) {
      document.getElementById('broadcastStatus').textContent = `✓ Opened ${recipients.length} WhatsApp window${recipients.length === 1 ? '' : 's'}.`;
      return;
    }
    const r = recipients[i++];
    const msg = buildBroadcastMessage(r.name);
    window.open(`https://wa.me/${r.phone}?text=${encodeURIComponent(msg)}`, '_blank');
    document.getElementById('broadcastStatus').textContent = `Opening ${i} of ${recipients.length}…`;
    // Throttle so browser doesn't block popups
    setTimeout(next, 700);
  }
  next();
});

// ====== ANALYTICS ======
const ANALYTICS_KEY = 'ryker_analytics';
function loadAnalytics() {
  try { return JSON.parse(localStorage.getItem(ANALYTICS_KEY) || '{}'); }
  catch { return {}; }
}
function renderAnalytics() {
  const stats = loadAnalytics();
  const grid = document.getElementById('analyticsKpiGrid');
  if (!grid) return;

  const totalViews = Object.values(stats.itemViews || {}).reduce((a, b) => a + b, 0);
  const totalEnquiries = Object.values(stats.itemEnquiries || {}).reduce((a, b) => a + b, 0);
  const totalWishlist = Object.values(stats.itemWishlist || {}).reduce((a, b) => a + b, 0);
  const totalIgClicks = Object.values(stats.itemIgClicks || {}).reduce((a, b) => a + b, 0);

  grid.innerHTML = [
    { label: 'Item views', val: totalViews.toLocaleString(), sub: 'lightbox opens', cls: '' },
    { label: 'Enquiries', val: totalEnquiries.toLocaleString(), sub: 'WhatsApp clicks', cls: 'success' },
    { label: 'Saved by buyers', val: totalWishlist.toLocaleString(), sub: 'wishlist hearts', cls: '' },
    { label: 'IG clicks', val: totalIgClicks.toLocaleString(), sub: 'View on IG taps', cls: '' },
  ].map(k => `
    <div class="inv-kpi ${k.cls}">
      <div class="inv-kpi-label">${k.label}</div>
      <div class="inv-kpi-val">${k.val}</div>
      <div class="inv-kpi-sub">${k.sub}</div>
    </div>`).join('');

  function topN(map = {}, n = 6) {
    return Object.entries(map)
      .map(([id, count]) => ({ id, count, bag: bags.find(b => b.id === id) }))
      .filter(x => x.bag)
      .sort((a, b) => b.count - a.count)
      .slice(0, n);
  }

  function renderTopList(list, emptyMsg) {
    if (!list.length) return `<p style="color:#999;font-size:13px;">${emptyMsg}</p>`;
    return list.map(x => `
      <div class="recent-row">
        <img src="${x.bag.image}" alt="${escapeHtml(x.bag.name)}">
        <div class="recent-body">
          <div class="recent-name">${escapeHtml(x.bag.name)}</div>
          <div class="recent-meta">${x.count} ${x.count === 1 ? 'time' : 'times'} · ${escapeHtml(x.bag.category || '')}</div>
        </div>
      </div>`).join('');
  }

  document.getElementById('analyticsTopViews').innerHTML = renderTopList(topN(stats.itemViews), 'No views yet.');
  document.getElementById('analyticsTopEnquiries').innerHTML = renderTopList(topN(stats.itemEnquiries), 'No enquiries yet.');
}

async function init() {
  showToast('Loading…');
  await loadData();
  renderList();
  renderDashboard();
  renderInventory();
  renderBroadcastSelected();
  renderBroadcastPicker();
  renderBroadcastRecipients();
  renderBroadcastPreview();
  renderAnalytics();
}

checkAuth();
