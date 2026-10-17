/* ═══════════════════════════════════════════════════════
   MAPLE'S BEAN — Coffee Roastery Front-End
   Auth & data layer: Firebase (Realtime DB + Auth)
═══════════════════════════════════════════════════════ */

/* ── Firebase / session / captcha live in shared.js (MBCore) ── */
let db = MBCore.db, auth = MBCore.auth, googleProvider = MBCore.googleProvider, firebaseReady = MBCore.ready;

/* Firebase Realtime Database is the only data backend. */
const PHP_BACKUP_ENABLED = MBCore.PHP_BACKUP;

/* ── Helpers ── */
const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const peso = n => "₱" + Number(n).toLocaleString("en-PH");
const ts   = () => new Date().toLocaleTimeString("en-PH",{hour:"2-digit",minute:"2-digit"});
const sanitize = s => String(s).replace(/</g,"&lt;").replace(/>/g,"&gt;");
const escAttr = s => String(s ?? "").replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;");
const PH_VAT_STANDARD = 12;

function roundMoney(n) { return Math.round(Number(n) * 100) / 100; }

/** Philippines BIR-style VAT (default 12%, VAT-inclusive retail prices). */
function computePhVat(amount, options = {}) {
  const rate = options.rate ?? PH_VAT_STANDARD;
  const vatType = options.vatType ?? "standard";
  const inclusive = options.inclusive !== false;
  const lineTotal = Number(amount) || 0;
  if (vatType === "exempt") {
    return { vatType, vatRate: 0, vatableSales: roundMoney(lineTotal), vatAmount: 0, totalInclusive: roundMoney(lineTotal), label: "VAT Exempt (PH)" };
  }
  if (vatType === "zero") {
    return { vatType, vatRate: 0, vatableSales: roundMoney(lineTotal), vatAmount: 0, totalInclusive: roundMoney(lineTotal), label: "Zero-rated VAT (PH)" };
  }
  if (inclusive) {
    const vatable = lineTotal / (1 + rate / 100);
    const vat = lineTotal - vatable;
    return {
      vatType: "standard", vatRate: rate,
      vatableSales: roundMoney(vatable), vatAmount: roundMoney(vat),
      totalInclusive: roundMoney(lineTotal), label: `VAT ${rate}% (BIR / Philippines)`
    };
  }
  const vat = lineTotal * (rate / 100);
  return {
    vatType: "standard", vatRate: rate,
    vatableSales: roundMoney(lineTotal), vatAmount: roundMoney(vat),
    totalInclusive: roundMoney(lineTotal + vat), label: `VAT ${rate}% (BIR / Philippines)`
  };
}

function cartVatBreakdown(items) {
  let vatable = 0, vat = 0, total = 0;
  items.forEach(it => {
    const p = PRODUCTS.find(x => x.id === it.id);
    const b = computePhVat(it.price * it.qty, {
      rate: p?.vatRate ?? PH_VAT_STANDARD,
      vatType: p?.vatType ?? "standard",
      inclusive: p?.vatInclusive !== false
    });
    vatable += b.vatableSales;
    vat += b.vatAmount;
    total += b.totalInclusive;
  });
  return { vatableSales: roundMoney(vatable), vatAmount: roundMoney(vat), totalInclusive: roundMoney(total) };
}

let mirrorPhpTimer;
function mirrorFirebaseToPhp() {
  if (!PHP_BACKUP_ENABLED || !firebaseReady || backendMode !== "firebase") return;
  clearTimeout(mirrorPhpTimer);
  mirrorPhpTimer = setTimeout(() => {
    fetch("api/firebase-sync.php", { method: "POST", credentials: "include" }).catch(() => {});
  }, 2500);
}

/* ── State ── */
let PRODUCTS      = [];
let activeCat     = "all";
let sortMode      = "featured";
let maxPrice      = 25000;
let searchQuery   = "";
const cart        = JSON.parse(localStorage.getItem("ht_cart") || "[]");
const wishlist    = JSON.parse(localStorage.getItem("ht_wish") || "[]");
let recentlyViewed = JSON.parse(localStorage.getItem("ht_recent") || "[]");
let currentProduct = null;
let currentQty = 1, currentSize = null, currentColor = null, currentImgIdx = 0;
let promoApplied  = 0;
let currentUser   = null;
let userProfile   = null;
function normalizeFirebaseRole(role) {
  const r = String(role || "customer").trim().toLowerCase().replace(/[ -]/g, "_");
  if (r === "super_admin" || r === "superadmin") return "superadmin";
  if (["admin","staff","seller","customer"].includes(r)) return r;
  return "customer";
}

let editingProductId = null;

/* ═══════════════════════════════════════════════════════
   FIREBASE-ONLY BACKEND
   Firebase Realtime Database is the sole remote data source.
═══════════════════════════════════════════════════════ */
let backendMode = 'firebase';
let phpSessionReady = false;

async function phpRequest(path, options = {}, timeout = 5000) {
  if (!PHP_BACKUP_ENABLED) throw new Error('PHP backup disabled');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(path, {
      credentials: 'include',
      cache: 'no-store',
      ...options,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) throw new Error(body.error || `PHP request failed (${res.status})`);
    return body.data ?? body;
  } finally { clearTimeout(timer); }
}

async function syncPhpSession(u, profile = {}) {
  if (!u) return false;
  try {
    await phpRequest('api/auth.php', {
      method: 'POST',
      body: JSON.stringify({
        action: 'firebase_sync',
        firebaseUid: u.uid,
        email: u.email || '',
        username: profile.username || u.displayName || (u.email || '').split('@')[0],
        phone: profile.phone || ''
      })
    }, 4000);
    phpSessionReady = true;
    return true;
  } catch (e) {
    phpSessionReady = false;
    return false;
  }
}

async function phpProductsFallback() {
  return await phpRequest('api/products.php', { method: 'GET' }, 5000);
}

async function phpCreateOrderFallback(payload) {
  return await phpRequest('api/orders.php', { method: 'POST', body: JSON.stringify(payload) }, 7000);
}

function setBackendMode(mode) {
  backendMode = mode;
  document.documentElement.dataset.backend = mode;
  const badge = document.querySelector('#backendStatus');
  if (badge) {
    badge.textContent = mode === 'firebase' ? 'LIVE · FIREBASE' : 'BACKUP · PHP';
    badge.className = 'backend-status ' + (mode === 'firebase' ? 'is-live' : 'is-backup');
  }
    void 0;
}


/* ── DEMO SEED ── */
const SEED = [
  {id:"mb001",name:"Benguet Arabica — Light Roast",price:750,stock:14,category:"beans",sizes:["250g","500g","1kg"],colors:[],images:["https://images.unsplash.com/photo-1497515114629-f71d768fd07c?w=900&q=85","https://images.unsplash.com/photo-1442550528053-c431ecb55509?w=900&q=85"],featured:true,sale:false,createdAt:Date.now()-50000,desc:"Bright and floral single-origin from the Cordillera highlands. Notes of citrus and jasmine."},
  {id:"mb002",name:"Benguet Arabica — Light Roast",price:750,stock:14,category:"beans",sizes:["250g","500g","1kg"],colors:[],images:["https://images.unsplash.com/photo-1497515114629-f71d768fd07c?w=900&q=85","https://images.unsplash.com/photo-1442550528053-c431ecb55509?w=900&q=85"],featured:true,sale:false,createdAt:Date.now()-50000,desc:"Bright and floral single-origin from the Cordillera highlands. Notes of citrus and jasmine."},
  {id:"mb003",name:"Midnight Espresso Blend",price:820,stock:0,category:"beans",sizes:["250g","500g","1kg"],colors:[],images:["https://images.unsplash.com/photo-1510707577719-ae7c14805e3a?w=900&q=85"],featured:false,sale:false,createdAt:Date.now()-200000,desc:"Dark roast espresso blend built for crema. Notes of dark chocolate and roasted hazelnut."},
  {id:"mb004",name:"Butter Croissant (Box of 4)",price:380,stock:24,category:"pastries",sizes:["OS"],colors:[],images:["https://images.unsplash.com/photo-1555507036-ab1f4038808a?w=900&q=85"],featured:true,sale:false,createdAt:Date.now()-300000,desc:"Laminated all-butter croissants, baked fresh every morning. Flaky, buttery, golden."},
  {id:"mb005",name:"Cinnamon Roll — Single",price:150,oldPrice:180,stock:15,category:"pastries",sizes:["OS"],colors:[],images:["https://images.unsplash.com/photo-1583527976767-cbb88e0c2e2c?w=900&q=85"],featured:false,sale:true,createdAt:Date.now()-10000,desc:"Soft brioche swirl with cinnamon sugar and cream cheese glaze."},
  {id:"mb006",name:"Maple's Bean Ceramic Mug",price:520,stock:18,category:"drinkware",sizes:["12oz"],colors:["#1a1a1a","#dcdcdc","#5a4a3a"],images:["https://images.unsplash.com/photo-1577937927133-66ef06acdf18?w=900&q=85"],featured:true,sale:false,createdAt:Date.now()-20000,desc:"Matte-glazed stoneware mug with the Maple's Bean mark. Dishwasher and microwave safe."},
  {id:"mb007",name:"Insulated Travel Tumbler",price:980,stock:9,category:"drinkware",sizes:["16oz","20oz"],colors:["#1a1a1a","#5a5040"],images:["https://images.unsplash.com/photo-1606471191009-63994c53433b?w=900&q=85"],featured:false,sale:false,createdAt:Date.now()-40000,desc:"Double-walled stainless steel tumbler that keeps your brew hot for hours. Leak-proof lid."},
  {id:"mb008",name:"Roaster's Logo Tote Bag",price:450,stock:20,category:"merch",sizes:["OS"],colors:["#dcdcdc","#1a1a1a"],images:["https://images.unsplash.com/photo-1591561954557-26941169b49e?w=900&q=85"],featured:true,sale:false,createdAt:Date.now()-15000,desc:"Heavy canvas tote with the roaster's mark. Fits two bags of beans and a thermos with room to spare."}
];
/* ════════════════════════════════
   PRODUCTS / RENDER
════════════════════════════════ */
function attachRealtimeProducts() {
  async function applyProducts(list, mode = 'firebase') {
    PRODUCTS = list?.length ? list : SEED;
    setBackendMode(mode);
    localStorage.setItem('mb_products_cache', JSON.stringify(PRODUCTS));
    renderProducts();
    renderRecentlyViewed();
  }

  async function loadFirebaseOnce() {
    if (!firebaseReady || !db) throw new Error('Remote service unavailable');
    const snap = await db.ref('mb_products').once('value');
    const val = snap.val();
    if (!val) {
      SEED.forEach(p => db.ref('mb_products/' + p.id).set(p).catch(() => {}));
      return SEED;
    }
    return Object.keys(val).map(k => ({ id:k, ...val[k] }));
  }

  async function loadPhpFallback() {
    const list = await phpProductsFallback();
    return Array.isArray(list) ? list : [];
  }

  (async () => {
    try {
      const list = await loadFirebaseOnce();
      await applyProducts(list, 'firebase');

      // Firebase realtime is primary while connected. If its listener errors,
      // immediately switch to PHP/MySQL instead of replacing the product list with demo data.
      db.ref('mb_products').on('value', snap => {
        const val = snap.val();
        if (val) applyProducts(Object.keys(val).map(k => ({id:k,...val[k]})), 'firebase');
      }, async () => {
        try { await applyProducts(await loadPhpFallback(), 'php'); }
        catch (e) {
          const cached = JSON.parse(localStorage.getItem('mb_products_cache') || '[]');
          await applyProducts(cached.length ? cached : SEED, 'php');
        }
      });
    } catch (firebaseError) {
      void 0;
      try {
        await applyProducts(await loadPhpFallback(), 'php');
      } catch (phpError) {
        void 0;
        const cached = JSON.parse(localStorage.getItem('mb_products_cache') || '[]');
        await applyProducts(cached.length ? cached : SEED, 'php');
      }
    }
  })();
}

function filterProducts() {
  return PRODUCTS.filter(p => {
    if (p.price > maxPrice) return false;
    if (searchQuery && !p.name.toLowerCase().includes(searchQuery)) return false;
    if (activeCat === "all")      return true;
    if (activeCat === "new")      return p.category === "new" || (Date.now()-(p.createdAt||0) < 864e5*30);
    if (activeCat === "best")     return (p.stock||0) < 10 && (p.stock||0) > 0;
    if (activeCat === "featured") return p.featured;
    return p.category === activeCat;
  }).sort((a,b) => {
    if (sortMode==="new")  return (b.createdAt||0)-(a.createdAt||0);
    if (sortMode==="low")  return a.price-b.price;
    if (sortMode==="high") return b.price-a.price;
    return (b.featured?1:0)-(a.featured?1:0);
  });
}

function stockTag(stock) {
  if (stock <= 0) return `<span>Sold Out</span>`;
  if (stock < 5)  return `<span class="low">Low Stock</span>`;
  return `<span>In Stock</span>`;
}

function starRating(rating, count) {
  if (!rating) return "";
  const filled = Math.round(Number(rating));
  const stars = "★".repeat(filled) + "☆".repeat(5 - filled);
  const num = Number(rating).toFixed(1);
  return `<div class="card-rating" aria-label="${num} out of 5 stars">
    <span class="card-rating-stars">${stars}</span>
    <span class="card-rating-count">${num} (${count || 0})</span>
  </div>`;
}

function productCard(p) {
  const inWish = wishlist.includes(p.id);
  return `
  <div class="card" data-id="${p.id}">
    <div class="card-media">
      ${p.stock<=0?`<div class="sold-overlay">SOLD OUT</div>`:""}
      <div class="card-badge">
        ${p.sale?`<span class="sale">Sale</span>`:""}
        ${stockTag(p.stock||0)}
      </div>
      <button class="wishlist-btn ${inWish?"active":""}" data-wish="${p.id}"><span class="wish-heart">${inWish?"♥":"♡"}</span></button>
      <img src="${p.images?.[0]||""}" alt="${sanitize(p.name)}" loading="lazy"/>
      ${p.stock>0?`<button class="quick-add" data-add="${p.id}">Quick Add</button>`:""}
    </div>
    <div class="card-info">
      <div><h3>${sanitize(p.name)}</h3><div class="card-cat">${p.category}</div></div>
      ${starRating(p.avgRating, p.reviewCount)}
      <div class="card-price">${p.oldPrice?`<del>${peso(p.oldPrice)}</del>`:""}${peso(p.price)}<small class="card-vat-note">incl. 12% VAT</small></div>
    </div>
  </div>`;
}

function renderProducts() {
  const list = filterProducts();
  const grid = $("#productGrid");
  if (grid) grid.innerHTML = list.map(productCard).join("");
  const empty = $("#emptyState");
  if (empty) empty.hidden = list.length > 0;
  const feat = $("#featuredGrid");
  if (feat) feat.innerHTML = PRODUCTS.filter(p=>p.featured).slice(0,4).map(productCard).join("");
  attachCardEvents();
  updateBadges();
}

function attachCardEvents() {
  $$(".card").forEach(c => {
    c.addEventListener("click", e => {
      if (e.target.closest("[data-wish],[data-add]")) return;
      openProduct(c.dataset.id);
    });
  });
  $$("[data-wish]").forEach(b => b.addEventListener("click", e => { e.stopPropagation(); toggleWish(b.dataset.wish); }));
  $$("[data-add]").forEach(b => b.addEventListener("click", e => { e.stopPropagation(); quickAdd(b.dataset.add); }));
}

/* ════════════════════════════════
   CART / WISHLIST (LOGIN REQUIRED TO BUY)
════════════════════════════════ */
function persist() {
  localStorage.setItem("ht_cart", JSON.stringify(cart));
  localStorage.setItem("ht_wish", JSON.stringify(wishlist));
}
function updateBadges() {
  const cc = $("#cartCount"), wc = $("#wishCount");
  if (cc) cc.textContent = cart.reduce((s,i) => s+i.qty, 0);
  if (wc) wc.textContent = wishlist.length;
  renderCart(); renderWish();
}

function requireLogin(action) {
  if (!currentUser) {
    toast("Please sign in to continue");
    openAuth(action);
    return false;
  }
  return true;
}

function toggleWish(id) {
  const i = wishlist.indexOf(id);
  if (i >= 0) { wishlist.splice(i,1); toast("Removed from wishlist"); }
  else { wishlist.push(id); toast("Added to wishlist"); }
  persist(); renderProducts();
}

function quickAdd(id) {
  if (!requireLogin()) return;
  const p = PRODUCTS.find(x => x.id===id);
  if (!p || p.stock<=0) return;
  addToCart(p, 1, p.sizes?.[0]||null, p.colors?.[0]||null);
  toast("Added to bag");
}

function priceForSize(p, size) {
  const exact = p && p.sizePrices && size != null ? p.sizePrices[size] : undefined;
  return exact !== undefined && exact !== null && exact !== "" ? Number(exact) : (Number(p && p.price) || 0);
}
function updateModalPrice() {
  if (!currentProduct) return;
  const el = $("#modalPrice");
  if (el) el.textContent = peso(priceForSize(currentProduct, currentSize || currentProduct.sizes?.[0] || null) * (currentQty || 1));
}

function addToCart(p, qty, size, color) {
  if (!requireLogin()) return;
  const key = p.id + (size||"") + (color||"");
  const unitPrice = priceForSize(p, size || p.sizes?.[0] || null);
  const ex = cart.find(i => i.key===key);
  if (ex) { ex.qty = Math.min(ex.qty+qty, p.stock||99); ex.price = unitPrice; }
  else cart.push({ key, id:p.id, name:p.name, price:unitPrice, image:p.images?.[0]||"", size, color, qty });
  persist(); updateBadges();
  // Save to MySQL + Firebase backup for abandoned cart recovery
  if (currentUser) {
    if (usePhpPrimary()) {
      MB_API.saveCart(cart).catch(() => {});
    } else if (firebaseReady) {
      db.ref("carts/"+currentUser.uid).set({ items: cart, updatedAt: Date.now(), email: currentUser.email });
    }
  }
}

function removeFromCart(key) { const i = cart.findIndex(x=>x.key===key); if(i>=0){cart.splice(i,1);} persist(); updateBadges(); }
function changeQty(key, delta) {
  const it = cart.find(x=>x.key===key);
  if (!it) return;
  it.qty = Math.max(1, it.qty+delta);
  persist(); updateBadges();
}

function renderCart() {
  const breakdown = cartVatBreakdown(cart);
  const total = Math.max(0, breakdown.totalInclusive - promoApplied);
  const el = $("#cartItems");
  if (!el) return;
  el.innerHTML = cart.length ? cart.map(i => `
    <div class="cart-line">
      <img src="${i.image}" alt="${sanitize(i.name)}">
      <div>
        <h4>${sanitize(i.name)}</h4>
        <div class="meta">${i.size||""} ${i.color?`<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${i.color};border:1px solid rgba(255,255,255,.3)"></span>`:""}
        </div>
        <div class="qty-mini">
          <button onclick="changeQty('${i.key}',-1)">−</button>
          <span>${i.qty}</span>
          <button onclick="changeQty('${i.key}',1)">+</button>
        </div>
      </div>
      <div>
        <div class="price">${peso(i.price*i.qty)}</div>
        <span class="rm" onclick="removeFromCart('${i.key}')">Remove</span>
      </div>
    </div>`).join("") : `<p style="color:var(--mute);padding:24px 0;text-align:center;font-size:12px;letter-spacing:.1em">Your bag is empty.</p>`;
  const st = $("#subTotal"), vs = $("#vatableSales"), tx = $("#tax"), tt = $("#total");
  if (st) st.textContent = peso(breakdown.vatableSales);
  if (vs) vs.textContent = peso(breakdown.vatableSales);
  if (tx) tx.textContent = peso(breakdown.vatAmount);
  if (tt) tt.textContent = peso(total);
}

function renderWish() {
  const items = PRODUCTS.filter(p => wishlist.includes(p.id));
  const el = $("#wishItems");
  if (!el) return;
  el.innerHTML = items.length ? items.map(p => `
    <div class="cart-line">
      <img src="${p.images?.[0]||""}" alt="${sanitize(p.name)}">
      <div>
        <h4>${sanitize(p.name)}</h4>
        <div class="meta">${p.category}</div>
        <button onclick="quickAdd('${p.id}');closeWishFn()" class="btn btn-primary" style="padding:8px 14px;font-size:10px;margin-top:8px">Add to Bag</button>
      </div>
      <div>
        <div class="price">${peso(p.price)}</div>
        <span class="rm" onclick="toggleWish('${p.id}')">Remove</span>
      </div>
    </div>`).join("") : `<p style="color:var(--mute);padding:24px 0;text-align:center;font-size:12px;letter-spacing:.1em">Your wishlist is empty.</p>`;
}

/* ════════════════════════════════
   RECENTLY VIEWED
════════════════════════════════ */
function trackRecentlyViewed(id) {
  recentlyViewed = recentlyViewed.filter(x => x !== id);
  recentlyViewed.unshift(id);
  recentlyViewed = recentlyViewed.slice(0, 6);
  localStorage.setItem("ht_recent", JSON.stringify(recentlyViewed));
}

function recentCard(p) {
  return `
  <div class="recent-card" data-id="${p.id}">
    <div class="rc-media"><img src="${p.images?.[0]||""}" alt="${sanitize(p.name)}" loading="lazy"/></div>
    <div class="rc-name">${sanitize(p.name)}</div>
    <div class="rc-price">${peso(p.price)}</div>
  </div>`;
}

function renderRecentlyViewed() {
  const el = $("#recentGrid");
  if (!el) return;
  const items = recentlyViewed.map(id => PRODUCTS.find(p=>p.id===id)).filter(Boolean);
  const section = $("#recentSection");
  if (!items.length) { if (section) section.style.display="none"; return; }
  if (section) section.style.display="";
  el.innerHTML = items.map(recentCard).join("");
  $$(".recent-card").forEach(c => c.addEventListener("click", () => openProduct(c.dataset.id)));
}

/* ════════════════════════════════
   PRODUCT MODAL
════════════════════════════════ */
function openProduct(id) {
  const p = PRODUCTS.find(x=>x.id===id);
  if (!p) return;
  currentProduct = p; currentQty = 1; currentSize = null; currentColor = null; currentImgIdx = 0;
  trackRecentlyViewed(id);

  const cat = $("#modalCat"), name = $("#modalName"), price = $("#modalPrice"),
        desc = $("#modalDesc"), stock = $("#modalStock");
  if (cat)   cat.textContent   = p.category;
  if (name)  name.textContent  = p.name;
  if (price) price.textContent = peso(priceForSize(p, currentSize || p.sizes?.[0] || null) * currentQty);
  if (desc)  desc.textContent  = p.desc||"";
  if (stock) {
    if (p.stock<=0) { stock.textContent="Sold Out"; stock.className="modal-stock out"; }
    else if (p.stock<5) { stock.textContent=`Low Stock — ${p.stock} left`; stock.className="modal-stock low"; }
    else { stock.textContent="In Stock"; stock.className="modal-stock"; }
  }

  const imgs = p.images || [];
  const gallery = $("#modalGallery");
  if (gallery) {
    gallery.innerHTML = imgs.map((src,i) => `<img src="${src}" alt="" class="${i===0?"active":""}">`).join("") +
      `<div class="gallery-dots">${imgs.map((_,i)=>`<span data-dot="${i}" class="${i===0?"active":""}"></span>`).join("")}</div>`;
    $$("[data-dot]").forEach(d => d.addEventListener("click",()=>{
      currentImgIdx = +d.dataset.dot;
      $$("#modalGallery img").forEach((im,i)=>im.classList.toggle("active",i===currentImgIdx));
      $$("[data-dot]").forEach((x,i)=>x.classList.toggle("active",i===currentImgIdx));
    }));
  }

  const sizes = $("#modalSizes"), colors = $("#modalColors"), qty = $("#qtyVal");
  if (sizes)  sizes.innerHTML  = (p.sizes||[]).map(s=>`<button onclick="selectSize('${s}')" data-s="${s}">${s}</button>`).join("");
  if (colors) colors.innerHTML = (p.colors||[]).map(c=>`<button class="color" style="background:${c}" data-color="${c}" onclick="selectColor('${c}')"></button>`).join("");
  if (qty)    qty.textContent  = 1;
  if (p.sizes && p.sizes.length) selectSize(p.sizes[0]);   // default size, price updates with qty

  // Share button
  const shareBtn = $("#modalShare");
  if (shareBtn) {
    shareBtn.onclick = () => {
      const url = window.location.origin + window.location.pathname + "?product=" + p.id;
      if (navigator.share) {
        navigator.share({ title: p.name, text: `Check out ${p.name} on Maple's Bean`, url });
      } else {
        navigator.clipboard.writeText(url).then(()=>toast("Link copied"));
      }
    };
  }

  // Reviews
  loadProductReviews(id);

  $("#productModal").classList.add("open"); document.body.style.overflow="hidden";
}

function selectSize(s) { currentSize=s; $$("#modalSizes button").forEach(b=>b.classList.toggle("active",b.dataset.s===s)); updateModalPrice(); }
function selectColor(c) { currentColor=c; $$("#modalColors button").forEach(b=>b.classList.toggle("active",b.dataset.color===c)); }

/* ════════════════════════════════
   PRODUCT REVIEWS — Clickable stars + comment
════════════════════════════════ */
const RATING_LABELS = ["Tap a star to rate", "Poor — wouldn't buy again", "Fair — has its issues", "Good — solid choice", "Great — highly recommend", "Excellent — perfection in a cup"];

function initStarPicker() {
  const picker = $("#starPicker");
  if (!picker || picker.dataset.init === "1") return;
  picker.dataset.init = "1";

  const stars = picker.querySelectorAll(".star-btn");
  const text = $("#ratingText");
  const hidden = $("#reviewRating");

  function paint(n) {
    stars.forEach((s, i) => {
      const idx = i + 1;
      s.classList.toggle("active", idx <= n);
      s.setAttribute("aria-checked", idx === n ? "true" : "false");
    });
    if (text) {
      text.textContent = RATING_LABELS[n] || RATING_LABELS[0];
      text.classList.toggle("selected", n > 0);
    }
    if (hidden) hidden.value = String(n);
    updateSubmitState();
  }

  stars.forEach((s, i) => {
    const idx = i + 1;
    s.addEventListener("mouseenter", () => {
      stars.forEach((x, j) => x.classList.toggle("prev-active", j < idx));
      if (text) {
        text.textContent = RATING_LABELS[idx];
        text.classList.add("selected");
      }
    });
    s.addEventListener("mouseleave", () => {
      const current = parseInt(hidden?.value || "0", 10);
      stars.forEach((x, j) => x.classList.toggle("prev-active", j < current));
      if (text) {
        text.textContent = RATING_LABELS[current] || RATING_LABELS[0];
        text.classList.toggle("selected", current > 0);
      }
    });
    s.addEventListener("click", () => paint(idx));
    s.addEventListener("keydown", e => {
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        const cur = parseInt(hidden?.value || "0", 10);
        const next = Math.max(1, cur - 1);
        paint(next);
        stars[next - 1].focus();
      } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        const cur = parseInt(hidden?.value || "0", 10);
        const next = Math.min(5, cur + 1);
        paint(next);
        stars[next - 1].focus();
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        paint(idx);
      }
    });
  });

  // Char counter for the textarea
  const ta = $("#reviewText");
  const counter = $("#charCount");
  const counterWrap = counter?.parentElement;
  if (ta && counter) {
    ta.addEventListener("input", () => {
      const len = ta.value.length;
      counter.textContent = String(len);
      if (counterWrap) counterWrap.classList.toggle("over", len > 500);
      updateSubmitState();
    });
  }

  paint(0);
}

function updateSubmitState() {
  const btn = $("#submitReviewBtn");
  if (!btn) return;
  const rating = parseInt($("#reviewRating")?.value || "0", 10);
  const text = $("#reviewText")?.value.trim() || "";
  const ok = rating >= 1 && text.length >= 3;
  btn.disabled = !ok;
  if (ok) {
    btn.textContent = `Submit Review (${rating} star${rating === 1 ? "" : "s"})`;
  } else {
    btn.textContent = "Submit Review";
  }
}

function resetReviewForm() {
  const hidden = $("#reviewRating");
  const ta = $("#reviewText");
  const counter = $("#charCount");
  if (hidden) hidden.value = "0";
  if (ta) ta.value = "";
  if (counter) counter.textContent = "0";
  initStarPicker();
}

async function loadProductReviews(productId) {
  const el = $("#reviewsList");
  const summary = $("#reviewsSummary");
  const form = $("#reviewForm");
  if (!el) return;

  el.innerHTML = `<p class="empty-reviews">Loading reviews…</p>`;
  if (summary) summary.innerHTML = "";

  let reviews = [];
  try {
    if (usePhpPrimary()) {
      reviews = await MB_API.getReviews(productId);
    } else if (firebaseReady) {
      const snap = await db.ref("reviews/"+productId).once("value");
      const val = snap.val() || {};
      reviews = Object.values(val).sort((a, b) => b.createdAt - a.createdAt);
    } else {
      // Local fallback so reviews still work without Firebase
      reviews = JSON.parse(localStorage.getItem("mb_reviews_" + productId) || "[]")
        .sort((a, b) => b.createdAt - a.createdAt);
    }
  } catch (e) {
    void 0;
  }

  renderReviews(reviews);

  if (form) {
    form.style.display = currentUser ? "" : "none";
    const loginPrompt = $("#reviewLoginPrompt");
    if (loginPrompt) loginPrompt.style.display = currentUser ? "none" : "";
    if (currentUser) {
      initStarPicker();
      resetReviewForm();
    }
  }
}

function renderReviews(reviews) {
  const el = $("#reviewsList");
  const summary = $("#reviewsSummary");
  if (!el) return;

  if (!reviews.length) {
    el.innerHTML = `<p class="empty-reviews">No reviews yet. Be the first to share your brew!</p>`;
    if (summary) summary.innerHTML = "";
    return;
  }

  // Average + summary
  const avg = reviews.reduce((s, r) => s + (Number(r.rating) || 0), 0) / reviews.length;
  const rounded = Math.round(avg * 2) / 2;
  const fullStars = Math.floor(rounded);
  const hasHalf = rounded - fullStars >= 0.5;
  const starsHTML = "★".repeat(fullStars) + (hasHalf ? "★" : "") + "☆".repeat(5 - fullStars - (hasHalf ? 1 : 0));

  if (summary) {
    summary.innerHTML = `
      <span class="rs-avg">${avg.toFixed(1)}</span>
      <span class="rs-stars" aria-label="${avg.toFixed(1)} out of 5">${starsHTML}</span>
      <span class="rs-count">${reviews.length} review${reviews.length === 1 ? "" : "s"}</span>
    `;
  }

  el.innerHTML = reviews.map(r => {
    const name = sanitize(r.username || r.userName || (r.email ? r.email.split("@")[0] : "Anonymous"));
    const initial = name.charAt(0).toUpperCase();
    const rating = Math.max(1, Math.min(5, Math.round(Number(r.rating) || 5)));
    const userStars = "★".repeat(rating) + "☆".repeat(5 - rating);
    const date = r.createdAt ? new Date(r.createdAt).toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" }) : "";
    const verified = r.verified || r.uid ? '<span class="verified">Verified buyer</span>' : "";
    return `
      <div class="review-item">
        <div class="review-item-head">
          <div class="review-item-name">
            <span class="review-item-avatar">${sanitize(initial)}</span>
            ${name}${verified}
          </div>
          <span class="review-item-stars" aria-label="${rating} out of 5">${userStars}</span>
        </div>
        <p class="review-item-text">${sanitize(r.text || "")}</p>
        <div class="review-item-meta">${date}</div>
      </div>
    `;
  }).join("");
}

async function submitReview() {
  if (!requireLogin()) return;
  const rating = parseInt($("#reviewRating")?.value || "0", 10);
  const text = $("#reviewText")?.value.trim();
  const productId = currentProduct?.id;

  if (rating < 1 || rating > 5) { toast("Please select a rating from 1 to 5 stars", true); return; }
  if (!text || text.length < 3) { toast("Please write a comment (at least 3 characters)", true); return; }
  if (!productId) { toast("Product not found", true); return; }

  const review = {
    uid: currentUser.uid,
    username: userProfile?.username || currentUser.displayName || (currentUser.email || "").split("@")[0] || "Coffee Lover",
    email: currentUser.email || "",
    rating: rating,
    text: text,
    createdAt: Date.now(),
  };

  try {
    if (usePhpPrimary()) {
      await MB_API.createReview({ productId, rating, text });
    } else if (firebaseReady) {
      const ref = db.ref("reviews/" + productId).push();
      await ref.set(review);
      // Recalculate avg rating on the product
      const snap = await db.ref("reviews/" + productId).once("value");
      const val = snap.val() || {};
      const all = Object.values(val);
      const avg = all.reduce((s, r) => s + (Number(r.rating) || 0), 0) / all.length;
      await db.ref("mb_products/" + productId).update({
        avgRating: Math.round(avg * 10) / 10,
        reviewCount: all.length,
      });
    } else {
      // Local fallback
      const key = "mb_reviews_" + productId;
      const list = JSON.parse(localStorage.getItem(key) || "[]");
      list.push(review);
      localStorage.setItem(key, JSON.stringify(list));
    }

    resetReviewForm();
    toast("Thanks — your review is live");
    await loadProductReviews(productId);
    // Refresh product card so the rating badge updates too
    if (typeof renderProducts === "function") renderProducts();
  } catch (e) {
    void 0;
    toast("Could not submit review — please try again", true);
  }
}

/* ════════════════════════════════
   CHECKOUT (LOGIN REQUIRED)
════════════════════════════════ */
function openCheckout() {
  if (!requireLogin()) return;
  if (!cart.length) { toast("Your bag is empty"); return; }
  const breakdown = cartVatBreakdown(cart);
  const total = Math.max(0, breakdown.totalInclusive - promoApplied);
  const ci = $("#checkoutItems"), ct = $("#checkoutTotal");
  const cv = $("#checkoutVatable"), cx = $("#checkoutVat");
  if (ci) ci.innerHTML = cart.map(i=>`<div class="row"><span>${sanitize(i.name)} × ${i.qty}</span><span>${peso(i.price*i.qty)}</span></div>`).join("");
  if (cv) cv.textContent = peso(breakdown.vatableSales);
  if (cx) cx.textContent = peso(breakdown.vatAmount);
  if (ct) ct.textContent = peso(total);

  // Pre-fill if user has profile
  if (currentUser) {
    const nm = $("#coName"), em = $("#coEmail"), ph = $("#coPhone");
    if (nm && !nm.value) nm.value = userProfile?.username || currentUser.displayName || "";
    if (em && !em.value) em.value = currentUser.email || "";
    if (ph && !ph.value) ph.value = userProfile?.phone || "";
  }

  $("#checkoutModal").classList.add("open"); closeCartFn(); document.body.style.overflow="hidden";
}

async function placeOrder() {
  if (!requireLogin()) return;
  const name    = (document.getElementById("coName")?.value||"").trim();
  const email   = (document.getElementById("coEmail")?.value||"").trim();
  const phone   = (document.getElementById("coPhone")?.value||"").trim();
  const city    = (document.getElementById("coCity")?.value||"").trim();
  const address = (document.getElementById("coAddress")?.value||"").trim();
  const postal  = (document.getElementById("coPostal")?.value||"").trim();
  const country = (document.getElementById("coCountry")?.value||"Philippines").trim();
  const notes   = (document.getElementById("coNotes")?.value||"").trim();

  if (!name || !email || !phone || !city || !address || !postal) {
    toast("Please fill in all shipping details"); return;
  }

  const breakdown = cartVatBreakdown(cart);
  const total    = Math.max(0, breakdown.totalInclusive - promoApplied);
  const vat      = { ...breakdown, promoApplied, netTotal: total };
  const payMethod = document.querySelector('.pay-grid input[name="pay"]:checked')?.value || "Cash on Delivery";
  const shipping  = { name, email, phone, city, address, postal, country, notes };
  const delivery  = {
    courier: "", trackingNumber: "", eta: "",
    history: [{ status: "processing", at: Date.now(), note: "Order received — preparing for delivery" }]
  };

  try {
    if (usePhpPrimary()) {
      const result = await MB_API.createOrder({
        items: cart, total, sub: breakdown.vatableSales, vat, payMethod, shipping, delivery
      });
      if (result?.loyaltyPointsEarned) {
        toast(`Order placed! +${result.loyaltyPointsEarned} loyalty points earned`);
        if (userProfile) userProfile.loyaltyPoints = (userProfile.loyaltyPoints||0) + result.loyaltyPointsEarned;
        const lpEl = $("#loyaltyPoints");
        if (lpEl) lpEl.textContent = userProfile?.loyaltyPoints || 0;
      } else {
        toast("Order placed!");
      }
    } else if (firebaseReady) {
      const ref = db.ref("orders").push();
      await ref.set({
        items: cart, total, subtotal: breakdown.vatableSales, vat, payMethod, shipping, delivery,
        createdAt: Date.now(), status: "processing",
        user: currentUser?.uid||"guest",
        email: currentUser?.email || email
      });
      mirrorFirebaseToPhp();
      for (const it of cart) {
        const p = PRODUCTS.find(x=>x.id===it.id); if (!p) continue;
        await db.ref("mb_products/"+it.id+"/stock").set(Math.max(0,(p.stock||0)-it.qty));
      }
      if (currentUser) {
        const points = Math.floor(total / 100);
        const snapU = await db.ref("users/"+currentUser.uid+"/loyaltyPoints").once("value");
        const current = snapU.val() || 0;
        await db.ref("users/"+currentUser.uid+"/loyaltyPoints").set(current + points);
        toast(`Order placed! +${points} loyalty points earned`);
      }
      if (firebaseReady && currentUser) db.ref("carts/"+currentUser.uid).remove();
    } else {
      toast("Order placed — confirmation sent!");
    }
  } catch(e) { void 0; toast("Order error — try again"); return; }

  cart.length=0; persist(); updateBadges();
  closeModal("#checkoutModal");
}

/* ════════════════════════════════
   AUTH
════════════════════════════════ */
let pendingActionAfterLogin = null;

function openAuth(action) {
  if (currentUser) { openProfile(); return; }
  if (action) pendingActionAfterLogin = action;
  const m = $("#authModal");
  if (m) { m.classList.add("open"); document.body.style.overflow="hidden"; }
}

function setAuthMode(m) {
  const signin = m === "signin";
  const t = $("#authTitle"), sf = $("#signinForm"), spf = $("#signupForm"), ta = $("#toggleAuth");
  if (t)  t.textContent  = signin ? "Sign In" : "Create Account";
  if (sf) sf.style.display = signin ? "" : "none";
  if (spf) spf.style.display = signin ? "none" : "";
  if (ta) ta.textContent = signin ? "Create an account" : "Already a member?";
  const am = $("#authMsg");
  if (am) am.textContent = "";
}

/* Shown when another device/browser already holds this account's session. */
function showAuthBlocked() {
  const m = $("#authModal");
  if (m) { m.classList.add("open"); document.body.style.overflow = "hidden"; }
  setAuthMode("signin");
  const am = $("#authMsg");
  if (am) am.textContent = MBCore.SESSION_BLOCKED_MSG;
}

/* After a successful login: close the modal, then send staff / admin /
   super admin to their own dashboard page. Everyone else stays in the shop. */
async function afterLogin(u, msg) {
  closeModal("#authModal");
  toast(msg);
  try {
    const snap = await db.ref("users/" + u.uid).once("value");
    const role = await MBCore.resolveRole(u, snap.val() || {});
    const page = MBCore.dashboardFor(role);
    if (page) { window.location.href = page; return; }
  } catch (e) {}
  if (pendingActionAfterLogin) { pendingActionAfterLogin(); pendingActionAfterLogin = null; }
}

document.addEventListener("DOMContentLoaded", () => {
  const signinForm = $("#signinForm");
  const signupForm = $("#signupForm");

  // Basic CAPTCHA on both forms (see shared.js)
  // One shared CAPTCHA that appears in its own popup modal after the form is filled in.
  const capModal = MBCore.createCaptcha($("#captchaHost"));
  let captchaDone = null;
  const captchaErr = () => $("#captchaError");
  function askCaptcha(onSuccess) {
    captchaDone = onSuccess;
    capModal.refresh();
    const ce = captchaErr(); if (ce) ce.textContent = "";
    $("#captchaModal").classList.add("open");
    document.body.style.overflow = "hidden";
    setTimeout(() => { const i = $("#captchaHost .captcha-input"); if (i) i.focus(); }, 120);
  }
  function closeCaptcha() {
    $("#captchaModal").classList.remove("open");
    // authModal is still open underneath, keep page scroll locked
    document.body.style.overflow = $("#authModal")?.classList.contains("open") ? "hidden" : "";
    captchaDone = null;
  }
  function verifyCaptcha() {
    if (capModal.check()) {
      const fn = captchaDone;
      closeCaptcha();
      if (fn) fn();
    } else {
      const ce = captchaErr(); if (ce) ce.textContent = "Incorrect code. Here is a new one.";
    }
  }
  $("#captchaVerify")?.addEventListener("click", verifyCaptcha);
  $("#captchaClose")?.addEventListener("click", closeCaptcha);
  $("#captchaHost")?.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); verifyCaptcha(); } });

  // Reset any stale error state from a previous session.
  const clearAuthMsg = () => { const am = $("#authMsg"); if (am) am.textContent = ""; };

  // Opened from a dashboard that needs a login (?login=1) or after a forced sign-out.
  const qs = new URLSearchParams(window.location.search);
  if (qs.get("login") === "1") setTimeout(() => openAuth(), 400);
  if (qs.get("kicked") === "1") {
    setTimeout(() => toast("You were signed out because this account was opened on another device.", true), 600);
  }

  if (signinForm) signinForm.addEventListener("submit", e => {
    e.preventDefault();
    clearAuthMsg();
    const am = $("#authMsg");
    const email = $("#siEmail")?.value.trim();
    const pass  = $("#siPass")?.value;

    if (!email || !pass) {
      if (am) am.textContent = "Email and password are required.";
      return;
    }
    askCaptcha(async () => {
      if (!firebaseReady) {
        if (am) am.textContent = "Sign-in is offline. Check the Firebase setup in shared.js.";
        return;
      }
      try {
        const cred = await auth.signInWithEmailAndPassword(email, pass);
        const ok = await MBCore.claimSession(cred.user);
        if (!ok) {
          await auth.signOut();
          if (am) am.textContent = MBCore.SESSION_BLOCKED_MSG;
          return;
        }
        await afterLogin(cred.user, "Welcome back");
      } catch (err) {
        const msg = friendlyAuthError(err.code) || err.message || "Sign-in failed.";
        if (am) am.textContent = msg;
      }
    });
  });

  if (signupForm) signupForm.addEventListener("submit", e => {
    e.preventDefault();
    clearAuthMsg();
    const am = $("#authMsg");
    const username = sanitize($("#suUser")?.value.trim() || "");
    const email    = $("#suEmail")?.value.trim();
    const phone    = $("#suPhone")?.value.trim();
    const pass     = $("#suPass")?.value;
    const confirm  = $("#suConfirm")?.value;

    if (!username)        { if (am) am.textContent = "Username required."; return; }
    if (!email)           { if (am) am.textContent = "Email required."; return; }
    if (pass.length < 6)  { if (am) am.textContent = "Password must be at least 6 characters."; return; }
    if (pass !== confirm) { if (am) am.textContent = "Passwords do not match."; return; }
    if (phone && !phone.match(/^\+?[\d\s\-]{7,}/)) {
      if (am) am.textContent = "Enter a valid phone number."; return;
    }
    askCaptcha(async () => {
      if (!firebaseReady) {
        if (am) am.textContent = "Registration is offline. Check the Firebase setup in shared.js.";
        return;
      }
      try {
        const cred = await auth.createUserWithEmailAndPassword(email, pass);
        await cred.user.updateProfile({ displayName: username });
        await db.ref("users/" + cred.user.uid).set({
          username, email, phone,
          role: "customer",
          createdAt: Date.now(),
          loyaltyPoints: 0,
        });
        await MBCore.claimSession(cred.user);
        closeModal("#authModal");
        toast("Welcome to Maple's Bean");
        if (pendingActionAfterLogin) { pendingActionAfterLogin(); pendingActionAfterLogin = null; }
      } catch (err) {
        const msg = friendlyAuthError(err.code) || err.message || "Registration failed.";
        if (am) am.textContent = msg;
      }
    });
  });

  const googleBtn = $("#googleBtn");
  if (googleBtn) googleBtn.addEventListener("click", async () => {
    const am = $("#authMsg");
    if (!firebaseReady) {
      if (am) am.textContent = "Google sign-in is not configured.";
      return;
    }
    try {
      let result;
      try {
        // Popup works in normal browser tabs.
        result = await auth.signInWithPopup(googleProvider);
      } catch (popupErr) {
        // Some embedded/restricted environments do not support popups.
        if (["auth/operation-not-supported-in-this-environment", "auth/popup-blocked"].includes(popupErr && popupErr.code)) {
          await auth.signInWithRedirect(googleProvider);
          return; // Browser navigates to Google and returns to this page.
        }
        throw popupErr;
      }
      const u = result.user;
      const ok = await MBCore.claimSession(u);
      if (!ok) {
        await auth.signOut();
        if (am) am.textContent = MBCore.SESSION_BLOCKED_MSG;
        return;
      }
      const snap = await db.ref("users/" + u.uid).once("value");
      if (!snap.exists()) {
        await db.ref("users/" + u.uid).set({
          username: u.displayName || (u.email || "").split("@")[0],
          email: u.email,
          phone: "",
          role: "customer",
          createdAt: Date.now(),
          loyaltyPoints: 0,
        });
      }
      await afterLogin(u, "Welcome");
    } catch (err) {
      // Keep errors out of the browser console; show a safe message in the UI.
      const msg = friendlyAuthError(err && err.code) || "Google sign-in failed. Please try again.";
      if (am) am.textContent = msg;
    }
  });

  const toggleAuth = $("#toggleAuth");
  if (toggleAuth) toggleAuth.addEventListener("click", e => {
    e.preventDefault();
    const sf = $("#signinForm");
    const mode = sf?.style.display==="none" ? "signin" : "signup";
    setAuthMode(mode);
    capModal.refresh();
  });

  const authClose = $("#authClose");
  if (authClose) authClose.addEventListener("click", () => closeModal("#authModal"));
});

function friendlyAuthError(code) {
  const map = {
    "auth/user-not-found":           "No account found with that email.",
    "auth/wrong-password":           "Incorrect password.",
    "auth/invalid-login-credentials":"Incorrect email or password.",
    "auth/invalid-credential":       "Incorrect email or password.",
    "auth/email-already-in-use":     "That email is already registered.",
    "auth/weak-password":            "Password must be at least 6 characters.",
    "auth/invalid-email":            "Invalid email address.",
    "auth/too-many-requests":        "Too many attempts. Please try again later.",
    "auth/network-request-failed":   "Network error. Check your connection.",
    "auth/popup-blocked":            "Pop-up was blocked. Please allow pop-ups and try again.",
    "auth/popup-closed-by-user":     null,
    "auth/cancelled-popup-request":  null,
    "auth/operation-not-allowed":    "This sign-in method is not enabled.",
    "auth/internal-error":           "An internal error occurred. Please try again.",
    "auth/user-disabled":            "This account has been disabled.",
    "auth/requires-recent-login":    "Please sign out and sign back in to continue.",
  };
  const msg = map[code];
  if (msg === null) return "";
  return msg || `Something went wrong (${code}). Please try again.`;
}

/* ── Auth State Observer ── */
if (firebaseReady) {
  // Another device took over this account (our session had gone stale).
  MBCore.setKickHandler(() => {
    auth.signOut().then(() => {
      toast("You were signed out because this account was opened on another device.", true);
    });
  });

  auth.onAuthStateChanged(async u => {
    if (u) {
      // One session per account: refuse if another device/browser is signed in.
      const ok = await MBCore.claimSession(u);
      if (!ok) {
        currentUser = null; userProfile = null;
        updateNavForUser(null);
        try { await auth.signOut(); } catch (e) {}
        showAuthBlocked();
        return;
      }
      currentUser = u;
      try {
        const snap = await db.ref("users/"+u.uid).once("value");
        userProfile = snap.val() || {};
        // Only the ONE pinned super admin keeps the "superadmin" role.
        userProfile.role = await MBCore.resolveRole(u, userProfile);
        try { localStorage.setItem("mb_last_firebase_auth", JSON.stringify({uid:u.uid,email:u.email,role:userProfile.role,at:Date.now()})); } catch(e) {}
        if (PHP_BACKUP_ENABLED) syncPhpSession(u, userProfile).catch(() => {});
      } catch(e) { userProfile = {}; }
      updateNavForUser(u);
      const presRef = db.ref("presence/"+u.uid);
      presRef.set({ online:true, lastSeen:Date.now(), email:u.email });
      presRef.onDisconnect().update({ online:false, lastSeen:Date.now() });
    } else {
      currentUser = null;
      userProfile = null;
      updateNavForUser(null);
    }
    updateLiveVisitorCount();
  });
}

function updateNavForUser(u) {
  const btn = $("#authBtn");
  if (!btn) return;
  if (u) {
    btn.title = userProfile?.username || u.email;
    btn.style.background = "rgba(255,255,255,.1)";
    btn.textContent = (userProfile?.username || u.email||"?")[0].toUpperCase();
  } else {
    btn.title = "Account";
    btn.style.background = "";
    btn.textContent = "◔";
  }
}

/* ════════════════════════════════
   LIVE VISITOR COUNT
════════════════════════════════ */
function updateLiveVisitorCount() {
  if (!firebaseReady) return;
  db.ref("presence").on("value", snap => {
    const val = snap.val() || {};
    const online = Object.values(val).filter(v=>v.online).length;
    const el = $("#liveVisitors");
    if (el) el.textContent = online > 0 ? `${online} online now` : "";
  });
}

/* ════════════════════════════════
   PROFILE MODAL
════════════════════════════════ */
function openProfile() {
  if (!currentUser) { openAuth(); return; }
  const u = currentUser;
  const p = userProfile || {};
  const pn = $("#profileName"), pe = $("#profileEmail"), pa = $("#profileAvatar");
  const du = $("#detUser"), dp = $("#detPhone"), de = $("#detEmail");
  if (pn) pn.textContent  = p.username || u.displayName || "Member";
  if (pe) pe.textContent  = u.email;
  if (pa) pa.textContent  = (p.username||u.email||"?")[0].toUpperCase();
  if (du) du.value = p.username||"";
  if (dp) dp.value = p.phone||"";
  if (de) de.value = u.email;

  const role = normalizeFirebaseRole(p.role);
  const snb = $("#sellerNavBtn");
  if (snb) snb.style.display = (role==="seller"||role==="admin") ? "" : "none";

  // Staff / admin / super admin work in their own dashboard PAGE (not a modal).
  const dash = MBCore.dashboardFor(role);
  const dl = $("#dashboardLink");
  if (dl) {
    if (dash) { dl.href = dash; dl.textContent = (role==="superadmin"?"Super Admin":role==="admin"?"Admin":"Staff") + " Dashboard ↗"; dl.style.display = ""; }
    else dl.style.display = "none";
  }
  // The super admin account can never be deleted.
  const dab0 = $("#deleteAccBtn");
  if (dab0) dab0.style.display = role==="superadmin" ? "none" : "";

  // Show loyalty points
  const lp = p.loyaltyPoints || 0;
  const lpEl = $("#loyaltyPoints");
  if (lpEl) lpEl.textContent = lp;

  loadMyOrders();
  if (role==="seller"||role==="admin") loadSellerPanel();

  openPane("orders");
  $("#profileModal").classList.add("open");
  document.body.style.overflow = "hidden";
}

function openPane(name) {
  $$(".pane").forEach(p => p.classList.remove("active"));
  $$(".pnav").forEach(b => b.classList.remove("active"));
  const capName = name.charAt(0).toUpperCase()+name.slice(1);
  const pane = $("#pane"+capName);
  if (pane) pane.classList.add("active");
  const nav = document.querySelector(`[data-pane="${name}"]`);
  if (nav) nav.classList.add("active");

  if (name==="seller") loadSellerPanel();
  if (name==="security") checkFirstLoginPasswordPrompt();
}

/* ── First-login "update your password?" prompt ── */
function pwPromptKey(uid) { return "mb_pwPrompted_"+uid; }

function checkFirstLoginPasswordPrompt() {
  const banner = $("#pwFirstLoginBanner");
  if (!banner) return;
  const seen = currentUser && localStorage.getItem(pwPromptKey(currentUser.uid));
  banner.style.display = (currentUser && !seen) ? "" : "none";
}

function markPwPromptDone(uid) {
  const id = uid || currentUser?.uid;
  if (id) localStorage.setItem(pwPromptKey(id), "1");
  const banner = $("#pwFirstLoginBanner");
  if (banner) banner.style.display = "none";
}

function goUpdatePasswordFromPrompt() {
  markPwPromptDone();
  $("#secNew")?.focus();
}

/* ── My Orders ── */
async function loadMyOrders() {
  const el = $("#ordersList");
  if (!el) return;
  if (!currentUser) { el.innerHTML=`<p class="muted">Sign in to see orders.</p>`; return; }
  try {
    let orders = [];
    if (usePhpPrimary()) {
      const list = await MB_API.getOrders();
      orders = list.map(o => [o.id, o]);
    } else if (firebaseReady) {
      const snap = await db.ref("orders").orderByChild("user").equalTo(currentUser.uid).once("value");
      const val  = snap.val();
      if (!val) { el.innerHTML=`<p class="muted">No orders yet.</p>`; return; }
      orders = Object.entries(val).sort((a,b)=>b[1].createdAt-a[1].createdAt);
    } else {
      el.innerHTML=`<p class="muted">No orders yet.</p>`; return;
    }
    if (!orders.length) { el.innerHTML=`<p class="muted">No orders yet.</p>`; return; }
    el.innerHTML = `<table class="admin-table buyer-orders-table">
      <thead><tr><th>Order</th><th>Date</th><th>Items</th><th>Total (incl. VAT)</th><th>Delivery</th><th></th></tr></thead>
      <tbody>${orders.map(([id,o])=>{
        const del = o.delivery || {};
        return `<tr>
        <td class="mono-muted">${id.slice(-8)}</td>
        <td>${new Date(o.createdAt).toLocaleDateString("en-PH")}</td>
        <td>${(o.items||[]).length}</td>
        <td>${peso(o.total||0)}</td>
        <td><span class="status-badge status-${o.status||"processing"}">${o.status||"processing"}</span>
          <div class="admin-sub">${sanitize(del.trackingNumber||"Tracking pending")}</div></td>
        <td><button type="button" class="admin-link-btn" onclick="showOrderTracking('${id}','${o.status||"processing"}')">Track delivery</button></td>
      </tr>`;
      }).join("")}</tbody>
    </table>`;
  } catch(e) { void 0; }
}

async function showOrderTracking(orderId, status) {
  let delivery = {};
  if (firebaseReady && db) {
    try {
      const snap = await db.ref("orders/" + orderId + "/delivery").once("value");
      delivery = snap.val() || {};
    } catch (e) { /* ignore */ }
  }
  const steps = ["processing","fulfilled","shipped","delivered"];
  const stepLabels = ["Order Placed","Preparing","Out for Delivery","Delivered"];
  const current = Math.max(0, steps.indexOf(status));
  const modal = document.createElement("div");
  modal.className = "modal open delivery-track-modal";
  modal.style.cssText = "z-index:100001";
  const courier = delivery.courier || "—";
  const tracking = delivery.trackingNumber || "Pending";
  const eta = delivery.eta || "Est. 2–5 business days (PH)";
  modal.innerHTML = `<div class="modal-inner delivery-track-inner">
    <button class="icon-btn modal-close" onclick="this.closest('.modal').remove();document.body.style.overflow=''">✕</button>
    <div class="delivery-track-body">
      <span class="eyebrow">Buyer delivery tracking</span>
      <h2>Track Your Order</h2>
      <p class="delivery-track-id">Order #${sanitize(orderId.slice(-10))}</p>
      <div class="delivery-meta-cards">
        <div class="delivery-meta-card"><span>Courier</span><strong>${sanitize(courier)}</strong></div>
        <div class="delivery-meta-card"><span>Tracking #</span><strong>${sanitize(tracking)}</strong></div>
        <div class="delivery-meta-card"><span>ETA</span><strong>${sanitize(eta)}</strong></div>
      </div>
      <div class="delivery-timeline">
        ${steps.map((s,i)=>`
          <div class="delivery-step ${i<=current?"done":""} ${i===current?"current":""}">
            <div class="delivery-step-dot"></div>
            <div class="delivery-step-text">
              <strong>${stepLabels[i]}</strong>
              ${i===current?`<small>Current step</small>`:""}
            </div>
          </div>`).join("")}
      </div>
    </div>
  </div>`;
  document.body.appendChild(modal);
  document.body.style.overflow="hidden";
}

/* ── Account Details Save ── */
async function saveDetails() {
  if (!currentUser) return;
  const username = sanitize($("#detUser")?.value.trim()||"");
  const phone    = $("#detPhone")?.value.trim()||"";
  if (!username) { toast("Username required"); return; }
  try {
    if (usePhpPrimary()) {
      const session = await MB_API.updateProfile({ username, phone });
      syncUserFromSession(session);
    } else if (firebaseReady) {
      await currentUser.updateProfile({ displayName: username });
      await db.ref("users/"+currentUser.uid).update({ username, phone });
      userProfile = { ...userProfile, username, phone };
    }
    const pn = $("#profileName");
    if (pn) pn.textContent = username;
    toast("Details saved");
  } catch(e) { toast("Error: "+e.message); }
}

/* ── Change Password ── */
async function changePassword() {
  if (!currentUser) return;
  const oldPass = $("#secOld")?.value;
  const newPass = $("#secNew")?.value;
  const conf    = $("#secConfirm")?.value;
  if (newPass !== conf) { toast("Passwords don't match"); return; }
  if ((newPass||"").length < 6)  { toast("Minimum 6 characters"); return; }
  try {
    const uidForFlag = currentUser.uid;
    if (usePhpPrimary()) {
      await MB_API.updateProfile({ username: userProfile?.username || currentUser.displayName, phone: userProfile?.phone || "", password: newPass });
      try { await MB_API.logout(); } catch(e){}
    } else if (firebaseReady) {
      const cred = firebase.auth.EmailAuthProvider.credential(currentUser.email, oldPass);
      await currentUser.reauthenticateWithCredential(cred);
      await currentUser.updatePassword(newPass);
      await auth.signOut();
    }
    ["secOld","secNew","secConfirm"].forEach(id=>{const e=$( "#"+id); if(e) e.value="";});
    markPwPromptDone(uidForFlag);
    currentUser = null; userProfile = null;
    closeModal("#profileModal");
    toast("Password updated — please sign in again");
    setAuthMode("signin");
    openAuth();
  } catch(e) { toast(friendlyAuthError(e.code)||e.message); }
}

/* ── Sign Out ── */
async function signOut() {
  if (usePhpPrimary()) { try { await MB_API.logout(); } catch(e){} }
  if (firebaseReady) await MBCore.signOutEverywhere();   // frees the one-session lock
  currentUser = null; userProfile = null;
  closeModal("#profileModal");
  toast("Signed out");
}

/* ════════════════════════════════
   ADMIN PANEL
════════════════════════════════ */
async function phpAdminGet(path) {
  return await phpRequest(path, { credentials: "include" }, 7000);
}

async function phpAdminMutation(path, method, body) {
  return await phpRequest(path, { method, credentials: "include", body: JSON.stringify(body || {}) }, 8000);
}

/* ── Product form (Seller panel) ── */
function updateProductVatPreview() {
  const price = parseFloat($("#pfPrice")?.value) || 0;
  const rate = parseFloat($("#pfVatRate")?.value) || PH_VAT_STANDARD;
  const vatType = $("#pfVatType")?.value || "standard";
  const inclusive = $("#pfVatInclusive")?.value !== "exclusive";
  const box = $("#pfVatPreview");
  if (!box) return;
  const b = computePhVat(price, { rate, vatType, inclusive });
  box.innerHTML = `
    <div class="vat-preview-row"><span>${b.label}</span><strong>${peso(b.vatAmount)}</strong></div>
    <div class="vat-preview-row"><span>VATable sales</span><strong>${peso(b.vatableSales)}</strong></div>
    <div class="vat-preview-row"><span>Selling price (${inclusive ? "incl." : "excl."} VAT)</span><strong>${peso(b.totalInclusive)}</strong></div>
    <p class="vat-preview-note">Philippines standard rate is 12% (BIR). Prices on the shop are VAT-inclusive unless you choose exclusive.</p>`;
}

function openProductForm(id) {
  editingProductId = id || null;
  const p = id ? PRODUCTS.find(x=>x.id===id) : null;
  const els = {
    prodFormTitle: p ? "Edit Product" : "Add Product",
    pfName: p?.name||"", pfPrice: p?.price||"", pfOldPrice: p?.oldPrice||"",
    pfStock: p?.stock ?? "", pfSupplier: p?.supplier||"", pfSupplierSku: p?.supplierSku||"",
    pfSupplierContact: p?.supplierContact||"",
    pfDeliveryLead: p?.deliveryLeadDays ?? 3, pfDeliveryStatus: p?.deliveryStatus||"ready",
    pfDeliveryDate: p?.deliveryDate ? new Date(p.deliveryDate).toISOString().slice(0,10) : "",
    pfInventoryLoc: p?.inventoryLocation||"Main warehouse",
    pfReorder: p?.reorderLevel ?? 5,
    pfSizes: (p?.sizes||[]).join(","),
    pfColors: (p?.colors||[]).join(","), pfImages: (p?.images||[]).join(","),
    pfDesc: p?.desc||""
  };
  Object.entries(els).forEach(([fid,v])=>{
    const e=$("#"+fid);
    if (!e) return;
    if (fid==="prodFormTitle") e.textContent=v; else e.value=v;
  });
  const pfCat = $("#pfCategory"), pfFeat = $("#pfFeatured"), pfSale = $("#pfSale");
  const pfVatRate = $("#pfVatRate"), pfVatType = $("#pfVatType"), pfVatInc = $("#pfVatInclusive");
  if (pfCat)  pfCat.value = p?.category||"new";
  if (pfFeat) pfFeat.checked = !!p?.featured;
  if (pfSale) pfSale.checked = !!p?.sale;
  if (pfVatRate) pfVatRate.value = p?.vatRate ?? PH_VAT_STANDARD;
  if (pfVatType) pfVatType.value = p?.vatType || "standard";
  if (pfVatInc) pfVatInc.value = p?.vatInclusive === false ? "exclusive" : "inclusive";
  updateProductVatPreview();
  const pfm = $("#productFormModal");
  if (pfm) pfm.classList.add("open");
}

async function saveProductForm() {
  const name     = $("#pfName")?.value.trim();
  const price    = parseFloat($("#pfPrice")?.value);
  const oldPrice = parseFloat($("#pfOldPrice")?.value)||null;
  const stock    = parseInt($("#pfStock")?.value, 10) || 0;
  const supplier = $("#pfSupplier")?.value.trim() || "";
  const supplierSku = $("#pfSupplierSku")?.value.trim() || "";
  const supplierContact = $("#pfSupplierContact")?.value.trim() || "";
  const deliveryLeadDays = parseInt($("#pfDeliveryLead")?.value, 10) || 3;
  const deliveryStatus = $("#pfDeliveryStatus")?.value || "ready";
  const deliveryDateRaw = $("#pfDeliveryDate")?.value || "";
  const deliveryDate = deliveryDateRaw ? new Date(deliveryDateRaw + "T00:00:00").getTime() : null;
  const inventoryLocation = $("#pfInventoryLoc")?.value.trim() || "Main warehouse";
  const reorderLevel = parseInt($("#pfReorder")?.value, 10) || 5;
  const category = $("#pfCategory")?.value;
  const vatRate = parseFloat($("#pfVatRate")?.value) || PH_VAT_STANDARD;
  const vatType = $("#pfVatType")?.value || "standard";
  const vatInclusive = $("#pfVatInclusive")?.value !== "exclusive";
  const sizes    = $("#pfSizes")?.value.split(",").map(s=>s.trim()).filter(Boolean)||[];
  const colors   = $("#pfColors")?.value.split(",").map(s=>s.trim()).filter(Boolean)||[];
  const images   = $("#pfImages")?.value.split(",").map(s=>s.trim()).filter(Boolean)||[];
  const desc     = $("#pfDesc")?.value.trim();
  const featured = $("#pfFeatured")?.checked;
  const sale     = $("#pfSale")?.checked;
  if (!name||isNaN(price)) { toast("Name and price required"); return; }
  const vatBreakdown = computePhVat(price, { rate: vatRate, vatType, inclusive: vatInclusive });
  const data = {
    name, price, oldPrice, stock, supplier, supplierSku, supplierContact, deliveryLeadDays, deliveryStatus, deliveryDate, inventoryLocation, reorderLevel,
    category, sizes, colors, images, desc, featured, sale,
    vatRate, vatType, vatInclusive,
    priceExVat: vatBreakdown.vatableSales, vatAmount: vatBreakdown.vatAmount,
    createdAt: Date.now()
  };
  try {
    if (usePhpPrimary()) {
      if (editingProductId) await MB_API.updateProduct(editingProductId, data);
      else await MB_API.createProduct(data);
      toast(editingProductId ? "Product updated" : "Product added");
    } else if (firebaseReady) {
      if (editingProductId) {
        await db.ref("mb_products/"+editingProductId).update(data);
        toast("Product updated");
      } else {
        const id = "mb"+Date.now();
        if (currentUser && userProfile?.role === "seller") data.sellerUid = currentUser.uid;
        await db.ref("mb_products/"+id).set({ id, ...data });
        toast("Product added");
      }
      mirrorFirebaseToPhp();
    } else {
      toast("No database connection"); closeModal("#productFormModal"); return;
    }
  } catch(e) {
    try {
      if (editingProductId) await phpAdminMutation("api/products.php?id="+encodeURIComponent(editingProductId), "PATCH", { id: editingProductId, ...data });
      else await phpAdminMutation("api/products.php", "POST", data);
      setBackendMode("php");
      toast(editingProductId ? "Product saved via backup" : "Product added via backup");
    } catch(err) { toast("Save failed: "+(err.message||"database unavailable")); return; }
  }
  closeModal("#productFormModal"); if (currentUser) { loadSellerPanel(); }
}

async function adminDeleteProduct(id) {
  if (!confirm("Delete this product?")) return;
  try {
    await db.ref("mb_products/"+id).remove();
    toast("Product deleted"); loadSellerPanel();
  } catch(e) { toast("Delete failed"); }
}

/* ════════════════════════════════
   SELLER PANEL
════════════════════════════════ */
async function loadSellerPanel() {
  if (!currentUser) return;
  const uid  = currentUser.uid;
  const role = normalizeFirebaseRole(userProfile?.role);

  if (role==="admin") {
    const sna = $("#sellerNotApproved"), sa = $("#sellerApproved"), sas = $("#sellerApplySection");
    if (sna) sna.style.display="none";
    if (sa)  sa.style.display="";
    if (sas) sas.style.display="none";
    loadSellerProducts(null); return;
  }

  let data = null;
  if (usePhpPrimary()) {
    try {
      const res = await MB_API.getSellers();
      data = Array.isArray(res) ? res.find(s => s.uid === uid) : res;
    } catch(e) {}
  } else if (firebaseReady) {
    const snap = await db.ref("sellers/"+uid).once("value");
    data = snap.val();
  }

  const sna = $("#sellerNotApproved"), sa = $("#sellerApproved"), sas = $("#sellerApplySection");
  if (!data) { if(sna)sna.style.display="none"; if(sa)sa.style.display="none"; if(sas)sas.style.display=""; return; }
  if (!data.approved) { if(sna)sna.style.display=""; if(sa)sa.style.display="none"; if(sas)sas.style.display="none"; return; }
  if(sna)sna.style.display="none"; if(sa)sa.style.display=""; if(sas)sas.style.display="none";
  loadSellerProducts(uid); loadSellerOrders(uid); loadSellerStats(uid);
}

async function applyAsSeller() {
  if (!currentUser) { openAuth(); return; }
  try {
    if (usePhpPrimary()) await MB_API.applySeller();
    else if (firebaseReady) {
      await db.ref("sellers/"+currentUser.uid).set({
        username: userProfile?.username||currentUser.displayName||"",
        email: currentUser.email, approved:false, appliedAt:Date.now()
      });
    }
    toast("Application submitted — pending admin approval"); loadSellerPanel();
  } catch(e) { toast("Could not submit application"); }
}

async function loadSellerProducts(sellerUid) {
  if (!firebaseReady) return;
  const snap = await db.ref("mb_products").once("value");
  const val  = snap.val() || {};
  const prods = Object.entries(val).filter(([id,p]) => !sellerUid || p.sellerUid===sellerUid);
  const el = $("#sellerProductsList");
  if (!el) return;
  el.innerHTML = prods.length ? `<table class="admin-table"><thead><tr><th>Name</th><th>Price</th><th>Stock</th><th>Actions</th></tr></thead>
    <tbody>${prods.map(([id,p])=>`<tr>
      <td>${sanitize(p.name)}</td><td>${peso(p.price)}</td><td>${p.stock||0}</td>
      <td>
        <button onclick="openProductForm('${id}')" style="font-size:10px;color:var(--silver);cursor:pointer;margin-right:8px">Edit</button>
        <button onclick="adminDeleteProduct('${id}')" style="font-size:10px;color:#ff7a7a;cursor:pointer">Delete</button>
      </td>
    </tr>`).join("")}</tbody></table>` : `<p class="muted" style="font-size:12px">No products yet.</p>`;
}

async function loadSellerOrders(sellerUid) {
  if (!firebaseReady) return;
  const snap = await db.ref("orders").once("value");
  const val  = snap.val() || {};
  const myProds = PRODUCTS.filter(p=>!sellerUid||p.sellerUid===sellerUid).map(p=>p.id);
  const myOrders = Object.entries(val).filter(([,o])=>(o.items||[]).some(i=>myProds.includes(i.id))).sort((a,b)=>b[1].createdAt-a[1].createdAt);
  const el = $("#sellerOrdersList");
  if (!el) return;
  el.innerHTML = myOrders.length ? `<table class="admin-table"><thead><tr><th>ID</th><th>Total</th><th>Status</th><th>Date</th></tr></thead>
    <tbody>${myOrders.map(([id,o])=>`<tr>
      <td style="font-size:10px;color:var(--mute)">${id.slice(-8)}</td>
      <td>${peso(o.total||0)}</td>
      <td><span class="status-badge status-${o.status||"processing"}">${o.status||"processing"}</span></td>
      <td style="color:var(--mute);font-size:11px">${new Date(o.createdAt).toLocaleDateString()}</td>
    </tr>`).join("")}</tbody></table>` : `<p class="muted" style="font-size:12px">No orders yet.</p>`;
}

async function loadSellerStats(sellerUid) {
  const snap = await db.ref("orders").once("value");
  const val  = snap.val() || {};
  const myProds = PRODUCTS.filter(p=>!sellerUid||p.sellerUid===sellerUid).map(p=>p.id);
  let rev=0, ordCount=0;
  Object.values(val).forEach(o => {
    const mi = (o.items||[]).filter(i=>myProds.includes(i.id));
    if (mi.length) { ordCount++; rev+=mi.reduce((s,i)=>s+i.price*i.qty,0); }
  });
  const srs = $("#sellerRevStat"), sos = $("#sellerOrdStat"), sps = $("#sellerProdStat");
  if (srs) srs.textContent=peso(rev);
  if (sos) sos.textContent=ordCount;
  if (sps) sps.textContent=PRODUCTS.filter(p=>!sellerUid||p.sellerUid===sellerUid).length;
}

/* ════════════════════════════════
   SUPPORT — Chat (Firebase RT)
════════════════════════════════ */
let mySupportConvId = null;
let chatListener    = null;
let typingTimeout   = null;

function getSupportConvId() {
  if (mySupportConvId) return mySupportConvId;
  const stored = localStorage.getItem("ht_conv");
  if (stored) { mySupportConvId = stored; return stored; }
  const id = "conv_"+(currentUser?.uid||"anon_"+Date.now())+"_"+Math.random().toString(36).slice(2);
  localStorage.setItem("ht_conv", id);
  mySupportConvId = id;
  return id;
}

function initSupportConv() {
  const convId = getSupportConvId();
  if (firebaseReady) {
    db.ref("support_convs/"+convId).once("value").then(snap => {
      if (!snap.exists()) {
        db.ref("support_convs/"+convId).set({
          userId: currentUser?.uid||"anon",
          email: currentUser?.email||"anonymous",
          createdAt: Date.now(),
          lastMsg: Date.now()
        });
      }
    });
    if (chatListener) chatListener.off();
    chatListener = db.ref("support_msgs/"+convId);
    chatListener.on("child_added", snap => {
      const msg = snap.val();
      appendChatMsg(msg.text, msg.from==="agent"?"agent":"user", msg.time||ts());
    });
    // Listen for typing indicator from agent
    db.ref("support_convs/"+convId+"/agentTyping").on("value", snap => {
      const el = $("#agentTypingIndicator");
      if (el) el.style.display = snap.val() ? "" : "none";
    });
  }
}

function sendChatMsg() {
  const input = $("#chatInput");
  if (!input) return;
  const text  = input.value.trim();
  if (!text) return;
  input.value = "";
  const convId = getSupportConvId();
  const now    = ts();
  if (firebaseReady) {
    db.ref("support_msgs/"+convId).push({ text, from:"user", time:now, uid:currentUser?.uid||"anon" });
    db.ref("support_convs/"+convId).update({ lastMsg:Date.now(), lastText:text, userTyping:false });
  } else {
    appendChatMsg(text,"user",now);
    setTimeout(()=>appendChatMsg("Thanks for reaching out! An agent will respond shortly.","agent",ts()), 800);
  }
}

function onUserTyping() {
  const convId = getSupportConvId();
  if (!firebaseReady) return;
  db.ref("support_convs/"+convId).update({ userTyping:true });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(()=>{
    db.ref("support_convs/"+convId).update({ userTyping:false });
  }, 2000);
}

function appendChatMsg(text, type, time) {
  const el = $("#chatMessages");
  if (!el) return;
  const div = document.createElement("div");
  div.className = "chat-msg "+type;
  div.innerHTML = `<div class="chat-bubble">${sanitize(text)}</div><div class="chat-time">${time}</div>`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

/* ════════════════════════════════
   RING SOUND (Web Audio API)
════════════════════════════════ */
let ringAudioCtx = null;
let ringOscNodes = [];
let ringInterval = null;

function startRinging() {
  if (ringInterval) return; // already ringing
  stopRinging();
  ringAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  function beep() {
    const osc  = ringAudioCtx.createOscillator();
    const gain = ringAudioCtx.createGain();
    osc.connect(gain);
    gain.connect(ringAudioCtx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ringAudioCtx.currentTime);
    osc.frequency.setValueAtTime(660, ringAudioCtx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.3, ringAudioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ringAudioCtx.currentTime + 0.4);
    osc.start(ringAudioCtx.currentTime);
    osc.stop(ringAudioCtx.currentTime + 0.4);
    ringOscNodes.push(osc);
  }
  beep();
  ringInterval = setInterval(beep, 1200);
}

function stopRinging() {
  if (ringInterval) { clearInterval(ringInterval); ringInterval = null; }
  ringOscNodes.forEach(o => { try { o.stop(); } catch(e){} });
  ringOscNodes = [];
  if (ringAudioCtx) { ringAudioCtx.close(); ringAudioCtx = null; }
}

/* ════════════════════════════════
   SUPPORT — Voice (WebRTC)
   NOTE: Customer service is always accessible (no login required)
════════════════════════════════ */
let localStream   = null;
let peerConn      = null;
let callSignalRef = null;
let isMuted       = false;

const ICE_SERVERS = { iceServers:[
  { urls:"stun:stun.l.google.com:19302" },
  { urls:"stun:stun1.l.google.com:19302" }
]};

async function startVoiceCall() {
  // Voice call is accessible to ANYONE — no login required
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio:true, video:false });
  } catch(e) {
    toast("Microphone access denied"); return;
  }

  const convId  = getSupportConvId();
  // Use a unique call ID per conversation (not static) to avoid collision
  const callId  = "call_"+convId;
  callSignalRef = firebaseReady ? db.ref("webrtc_calls/"+callId) : null;

  peerConn = new RTCPeerConnection(ICE_SERVERS);
  localStream.getTracks().forEach(t => peerConn.addTrack(t, localStream));

  peerConn.ontrack = e => {
    const audio = $("#remoteAudio");
    if (audio) audio.srcObject = e.streams[0];
  };

  peerConn.onicecandidate = e => {
    if (e.candidate && callSignalRef) {
      callSignalRef.child("callerCandidates").push(e.candidate.toJSON());
    }
  };

  const offer = await peerConn.createOffer();
  await peerConn.setLocalDescription(offer);

  if (callSignalRef) {
    // Always set fresh — this clears any stale ended call and creates a new ringing one
    await callSignalRef.set({
      offer: { type:offer.type, sdp:offer.sdp },
      status: "ringing",
      callerId: currentUser?.uid || "anon",
      callerEmail: currentUser?.email || "Guest (no login)",
      startedAt: Date.now()
    });

    callSignalRef.child("answer").on("value", async snap => {
      const data = snap.val();
      if (data && !peerConn?.currentRemoteDescription) {
        stopRinging();
        await peerConn.setRemoteDescription(new RTCSessionDescription(data));
        const vst = $("#voiceStatusText");
        if (vst) vst.textContent = "Connected — call in progress";
      }
    });

    callSignalRef.child("agentCandidates").on("child_added", async snap => {
      try { await peerConn?.addIceCandidate(new RTCIceCandidate(snap.val())); } catch(e){}
    });

    // Handle call ended by agent
    callSignalRef.on("value", snap => {
      const data = snap.val();
      if (data?.status === "ended" && peerConn) {
        endVoiceCall(); toast("Call ended by agent");
      }
    });
  }

  startRinging();
  const vst = $("#voiceStatusText"), vcb = $("#voiceCallBtn"), vhb = $("#voiceHangBtn"), vmb = $("#voiceMuteBtn"), vw = $("#voiceWaveform");
  if (vst) vst.textContent = "Ringing support…";
  if (vcb) vcb.style.display = "none";
  if (vhb) vhb.style.display = "";
  if (vmb) vmb.style.display = "";
  if (vw)  vw.style.display  = "flex";
  toast("Connecting to support…");
}

function endVoiceCall() {
  stopRinging();
  if (peerConn) { peerConn.close(); peerConn=null; }
  if (localStream) { localStream.getTracks().forEach(t=>t.stop()); localStream=null; }
  if (callSignalRef) { callSignalRef.update({status:"ended"}); callSignalRef.off(); callSignalRef=null; }
  const audio = $("#remoteAudio");
  if (audio) audio.srcObject=null;
  const vst = $("#voiceStatusText"), vcb = $("#voiceCallBtn"), vhb = $("#voiceHangBtn"), vmb = $("#voiceMuteBtn"), vw = $("#voiceWaveform");
  if (vst) vst.textContent = "Call ended";
  if (vcb) vcb.style.display = "";
  if (vhb) vhb.style.display = "none";
  if (vmb) vmb.style.display = "none";
  if (vw)  vw.style.display  = "none";
}

function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  const vmb = $("#voiceMuteBtn");
  if (vmb) vmb.textContent = isMuted ? "Unmute" : "Mute";
  toast(isMuted?"Muted":"Unmuted");
}

/* ════════════════════════════════
   SUPPORT WIDGET TOGGLE
════════════════════════════════ */
function toggleSupport() {
  const panel = $("#supportPanel");
  const fab   = $("#supportFab");
  if (!panel) return;
  const isOpen = panel.classList.contains("open");
  if (isOpen) {
    panel.classList.remove("open");
    const fc = fab?.querySelector(".fab-chat"), fx = fab?.querySelector(".fab-close");
    if (fc) fc.style.display="";
    if (fx) fx.style.display="none";
  } else {
    panel.classList.add("open");
    const fc = fab?.querySelector(".fab-chat"), fx = fab?.querySelector(".fab-close");
    if (fc) fc.style.display="none";
    if (fx) fx.style.display="";
    if (!mySupportConvId && !chatListener) initSupportConv();
  }
}

function switchSupportTab(name) {
  $$(".sup-tab").forEach(t=>t.classList.toggle("active",t.dataset.tab===name));
  const tc = $("#tabChat"), tv = $("#tabVoice");
  if (tc) tc.style.display = name==="chat"  ? "" : "none";
  if (tv) tv.style.display = name==="voice" ? "" : "none";
}

function switchSellerTab(name) {
  $$(".stab").forEach(t=>t.classList.toggle("active",t.dataset.stab===name));
  $$(".stab-content").forEach(el=>el.style.display="none");
  const map={ "my-products":"stabMyProducts","my-orders":"stabMyOrders","my-stats":"stabMyStats" };
  const el = $("#"+(map[name]||"stabMyProducts"));
  if (el) el.style.display="";
}

/* ════════════════════════════════
   MODALS / DRAWERS
════════════════════════════════ */
function closeModal(sel) { const e=$(sel); if(e){e.classList.remove("open"); document.body.style.overflow="";} }
function openCartFn()    { const e=$("#cartDrawer"),o=$("#overlay"); if(e)e.classList.add("open"); if(o)o.classList.add("open"); document.body.style.overflow="hidden"; }
function closeCartFn()   { const e=$("#cartDrawer"),o=$("#overlay"); if(e)e.classList.remove("open"); if(o)o.classList.remove("open"); document.body.style.overflow=""; }
function openWishFn()    { const e=$("#wishDrawer"),o=$("#overlay"); if(e)e.classList.add("open"); if(o)o.classList.add("open"); document.body.style.overflow="hidden"; }
function closeWishFn()   { const e=$("#wishDrawer"),o=$("#overlay"); if(e)e.classList.remove("open"); if(o)o.classList.remove("open"); document.body.style.overflow=""; }

/* ════════════════════════════════
   TOAST
════════════════════════════════ */
let toastT;
function toast(msg, isError) {
  const t = $("#toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.toggle("error", !!isError);
  t.classList.add("show");
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove("show"), isError ? 3500 : 2500);
}

/* ════════════════════════════════
   PROMO BANNER
════════════════════════════════ */
function initPromoBanner() {
  const banner = document.getElementById("promoBanner");
  const close  = document.getElementById("promoBannerClose");
  if (!banner) return;
  const dismissed = localStorage.getItem("ht_promo_dismissed");
  if (!dismissed) { banner.style.display="flex"; }
  if (close) close.addEventListener("click",()=>{ banner.style.display="none"; localStorage.setItem("ht_promo_dismissed","1"); });
}

/* ════════════════════════════════
   BACK TO TOP
════════════════════════════════ */
function initBackToTop() {
  const btn = document.getElementById("backToTop");
  if (!btn) return;
  window.addEventListener("scroll", () => {
    btn.style.opacity = window.scrollY > 400 ? "1" : "0";
    btn.style.pointerEvents = window.scrollY > 400 ? "auto" : "none";
  });
  btn.addEventListener("click", () => window.scrollTo({ top:0, behavior:"smooth" }));
}

/* ════════════════════════════════
   SIZE GUIDE MODAL
════════════════════════════════ */
function openSizeGuide() {
  const modal = document.getElementById("sizeGuideModal");
  if (modal) { modal.classList.add("open"); document.body.style.overflow="hidden"; }
}

/* ════════════════════════════════
   DARK/LIGHT MODE TOGGLE
════════════════════════════════ */
function initThemeToggle() {
  const btn = document.getElementById("themeToggle");
  if (!btn) return;
  const saved = localStorage.getItem("ht_theme") || "dark";
  document.documentElement.setAttribute("data-theme", saved);
  btn.textContent = saved === "dark" ? "Light" : "Dark";
  btn.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("ht_theme", next);
    btn.textContent = next === "dark" ? "Light" : "Dark";
  });
}

/* ════════════════════════════════
   SHARE PRODUCT (from URL param)
════════════════════════════════ */
function checkProductParam() {
  const params = new URLSearchParams(window.location.search);
  const pid = params.get("product");
  if (pid && PRODUCTS.length) {
    const p = PRODUCTS.find(x=>x.id===pid);
    if (p) { setTimeout(()=>openProduct(pid), 500); }
  }
}

/* ════════════════════════════════
   MARKETING — Abandoned Cart Recovery
════════════════════════════════ */
function checkAbandonedCart() {
  if (!currentUser) return;
  const restore = (data) => {
    if (!data?.items?.length) return;
    const hourAgo = Date.now() - 3600000;
    if (data.updatedAt && data.updatedAt < hourAgo && cart.length === 0) {
      data.items.forEach(item => {
        if (!cart.find(x=>x.key===item.key)) cart.push(item);
      });
      persist(); updateBadges();
      toast("Welcome back! Your bag was saved");
    }
  };
  if (usePhpPrimary()) {
    MB_API.getCart().then(restore).catch(() => {});
  } else if (firebaseReady) {
    db.ref("carts/"+currentUser.uid).once("value").then(snap => restore(snap.val()));
  }
}

/* ════════════════════════════════
   INIT
════════════════════════════════ */
window.addEventListener("DOMContentLoaded", async () => {
  await initPhpApi();
  if (currentUser) checkAbandonedCart();
  // Loader
  setTimeout(() => { const l=$("#loader"); if(l)l.classList.add("hide"); }, 2000);
  const yr = $("#yr");
  if (yr) yr.textContent = new Date().getFullYear();

  // Gallery
  const g = ["1495474472287-4d71bcdd2085","1497935586351-b67a49e012bf","1517256064527-09c73fc73e38","1442550528053-c431ecb55509","1559525839-d9acfd03b34b","1509365465985-25d11c17e812","1555507036-ab1f4038808a","1556821840-3a63f95609a7","1610889556528-9a770e32642f","1485808191679-5f86510681a2","1521223890158-f9f7c3d5d504","1611854779393-1b2da9d400fe"];
  const gg = $("#galleryGrid");
  if (gg) gg.innerHTML = g.map(id=>`<a href="#"><img loading="lazy" src="https://images.unsplash.com/photo-${id}?w=500&q=70"></a>`).join("");

  // Scroll/reveal
  window.addEventListener("scroll", () => { const nb=$("#navbar"); if(nb)nb.classList.toggle("scrolled", window.scrollY>20); });
  const io = new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add("in");io.unobserve(e.target);}}),{threshold:.1});
  $$(".reveal").forEach(el=>io.observe(el));

  // Category tabs
  $$(".cat").forEach(b=>b.addEventListener("click",()=>{ $$(".cat").forEach(x=>x.classList.remove("active")); b.classList.add("active"); activeCat=b.dataset.cat; renderProducts(); }));
  $$(".col-card").forEach(c=>c.addEventListener("click",()=>{ activeCat=c.dataset.cat; $$(".cat").forEach(x=>x.classList.toggle("active",x.dataset.cat===activeCat)); const s=document.getElementById("shop"); if(s)s.scrollIntoView({behavior:"smooth"}); renderProducts(); }));
  const ss = $("#sortSelect");
  if (ss) ss.addEventListener("change",e=>{ sortMode=e.target.value; renderProducts(); });
  const pr = $("#priceRange");
  if (pr) pr.addEventListener("input",e=>{ maxPrice=+e.target.value; const pv=$("#priceVal"); if(pv)pv.textContent=maxPrice.toLocaleString(); renderProducts(); });

  // Search
  const sb = $("#searchBtn"), sd = $("#searchDrawer"), si = $("#searchInput");
  if (sb && sd) sb.addEventListener("click",()=>sd.classList.toggle("open"));
  if (si) si.addEventListener("input",e=>{ searchQuery=e.target.value.toLowerCase(); renderProducts(); });

  // Cart / Wish
  const cb = $("#cartBtn"), cc = $("#closeCart"), wb = $("#wishBtn"), cw = $("#closeWish"), ov = $("#overlay"), mb = $("#menuBtn");
  if (cb) cb.addEventListener("click",openCartFn);
  if (cc) cc.addEventListener("click",closeCartFn);
  if (wb) wb.addEventListener("click",openWishFn);
  if (cw) cw.addEventListener("click",closeWishFn);
  if (ov) ov.addEventListener("click",()=>{ closeCartFn(); closeWishFn(); });
  if (mb) mb.addEventListener("click",()=>{ const mm=$("#mobileMenu"); if(mm)mm.classList.toggle("open"); });
  $$("#mobileMenu a").forEach(a=>a.addEventListener("click",()=>{ const mm=$("#mobileMenu"); if(mm)mm.classList.remove("open"); }));

  // Product modal
  const mc = $("#modalClose"), qm = $("#qtyMinus"), qp = $("#qtyPlus"), ma = $("#modalAdd"), mby = $("#modalBuy");
  if (mc)  mc.addEventListener("click",()=>closeModal("#productModal"));
  if (qm)  qm.addEventListener("click",()=>{ currentQty=Math.max(1,currentQty-1); const qv=$("#qtyVal"); if(qv)qv.textContent=currentQty; updateModalPrice(); });
  if (qp)  qp.addEventListener("click",()=>{ currentQty=Math.min(currentProduct?.stock||99,currentQty+1); const qv=$("#qtyVal"); if(qv)qv.textContent=currentQty; updateModalPrice(); });
  if (ma)  ma.addEventListener("click",()=>{
    if (currentProduct?.stock>0){
      if (!requireLogin()) return;
      addToCart(currentProduct,currentQty,currentSize,currentColor);
      toast("Added to bag"); closeModal("#productModal"); openCartFn();
    }
  });
  if (mby) mby.addEventListener("click",()=>{
    if (currentProduct?.stock>0){
      if (!requireLogin()) return;
      addToCart(currentProduct,currentQty,currentSize,currentColor);
      closeModal("#productModal"); openCheckout();
    }
  });

  // Size guide
  const sgBtn = $("#sizeGuideBtn"), sgClose = $("#sizeGuideClose");
  if (sgBtn)   sgBtn.addEventListener("click",openSizeGuide);
  if (sgClose) sgClose.addEventListener("click",()=>closeModal("#sizeGuideModal"));

  // Review submit
  const rvBtn = $("#submitReviewBtn");
  if (rvBtn) rvBtn.addEventListener("click", submitReview);
  const rvLoginBtn = $("#reviewLoginPromptBtn");
  if (rvLoginBtn) rvLoginBtn.addEventListener("click",()=>{ closeModal("#productModal"); openAuth(); });

  // Promo
  const ap = $("#applyPromo");
  if (ap) ap.addEventListener("click",()=>{
    const code = $("#promoCode")?.value.trim().toUpperCase();
    if(code==="MAPLESBEAN10"||code==="HIGHTYPE10") { promoApplied=500; toast("Promo applied — ₱500 off"); }
    else { promoApplied=0; toast("Invalid promo code"); }
    renderCart();
  });
  const ckb = $("#checkoutBtn"), ckc = $("#checkoutClose"), po = $("#placeOrder");
  if (ckb) ckb.addEventListener("click",openCheckout);
  if (ckc) ckc.addEventListener("click",()=>closeModal("#checkoutModal"));
  if (po)  po.addEventListener("click",placeOrder);

  // Auth
  const authBtn = $("#authBtn");
  if (authBtn) authBtn.addEventListener("click",()=>{ if(currentUser) openProfile(); else openAuth(); });

  // Profile modal
  const profileClose = $("#profileClose");
  if (profileClose) profileClose.addEventListener("click",()=>closeModal("#profileModal"));

  document.addEventListener("click",e=>{
    const b = e.target.closest("[data-pane]");
    if (b) openPane(b.dataset.pane);
  });
  document.addEventListener("click",e=>{
    const b = e.target.closest("[data-stab]");
    if (b) switchSellerTab(b.dataset.stab);
  });

  const sob = $("#signoutBtn"), sd2 = $("#saveDetails"), cpb = $("#changePassBtn");
  if (sob) sob.addEventListener("click",signOut);
  if (sd2) sd2.addEventListener("click",saveDetails);
  if (cpb) cpb.addEventListener("click",changePassword);

  const pwpu = $("#pwPromptUpdateBtn"), pwpd = $("#pwPromptDismissBtn");
  if (pwpu) pwpu.addEventListener("click",goUpdatePasswordFromPrompt);
  if (pwpd) pwpd.addEventListener("click",()=>markPwPromptDone());

  const dab = $("#deleteAccBtn");
  if (dab) dab.addEventListener("click",async()=>{
    if(!currentUser) return;
    if (userProfile?.role === "superadmin") { toast("The super admin account cannot be deleted.", true); return; }
    if(confirm("Permanently delete your account? This cannot be undone.")){
      try{
        await MBCore.releaseSession();
        if (usePhpPrimary()) await MB_API.deleteAccount();
        else if (firebaseReady) {
          await db.ref("users/"+currentUser.uid).remove();
          await currentUser.delete();
        }
        currentUser = null; userProfile = null;
        closeModal("#profileModal");
        toast("Account deleted.");
      }catch(e){toast(e.message);}
    }
  });

  // Admin
  const pfs = $("#pfSave"), pfc = $("#prodFormClose");
  if (pfs) pfs.addEventListener("click",saveProductForm);
  if (pfc) pfc.addEventListener("click",()=>closeModal("#productFormModal"));
  ["pfPrice","pfVatRate","pfVatType","pfVatInclusive"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", updateProductVatPreview);
    if (el && el.tagName === "SELECT") el.addEventListener("change", updateProductVatPreview);
  });

  // Seller
  const asb = $("#applySellerBtn"), sap = $("#sellerAddProduct");
  if (asb) asb.addEventListener("click",applyAsSeller);
  if (sap) sap.addEventListener("click",()=>openProductForm(null));

  // Support widget
  const sfab = $("#supportFab");
  if (sfab) sfab.addEventListener("click",toggleSupport);
  const sfl = $("#supportFloatLink");
  if (sfl) sfl.addEventListener("click",e=>{ e.preventDefault(); toggleSupport(); });
  $$(".sup-tab").forEach(t=>t.addEventListener("click",()=>switchSupportTab(t.dataset.tab)));
  const chatSend = $("#chatSend"), chatInput = $("#chatInput"), vcb2 = $("#voiceCallBtn"), vhb2 = $("#voiceHangBtn"), vmb2 = $("#voiceMuteBtn");
  if (chatSend)  chatSend.addEventListener("click",sendChatMsg);
  if (chatInput) {
    chatInput.addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); sendChatMsg(); }});
    chatInput.addEventListener("input",onUserTyping);
  }
  if (vcb2) vcb2.addEventListener("click",startVoiceCall);
  if (vhb2) vhb2.addEventListener("click",endVoiceCall);
  if (vmb2) vmb2.addEventListener("click",toggleMute);

  // Newsletter
  const nf = $("#newsForm");
  if (nf) nf.addEventListener("submit",async e=>{
    e.preventDefault();
    const email = e.target.querySelector("input[type=email]")?.value?.trim();
    try {
      if (usePhpPrimary() && email) await MB_API.subscribeNewsletter(email);
      toast("Welcome to the inner circle");
    } catch(err) { toast("Could not subscribe"); }
    e.target.reset();
  });

  // Smooth scroll
  $$("a[href^='#']").forEach(a=>a.addEventListener("click",e=>{
    const id=a.getAttribute("href"); if(id.length<2)return;
    const t=document.querySelector(id); if(t){e.preventDefault();t.scrollIntoView({behavior:"smooth"});}
  }));

  // Init features
  initPromoBanner();
  initBackToTop();
  initThemeToggle();
  updateLiveVisitorCount();

  // Products (triggers rendering pipeline)
  attachRealtimeProducts();

  // Check for shared product link
  setTimeout(checkProductParam, 1000);
});
