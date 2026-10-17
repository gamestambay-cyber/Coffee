/* ═══════════════════════════════════════════════════════
   MAPLE'S BEAN — Dashboard logic
   Used by superadmin.html, admin.html and staff.html.
   Each page only contains the views its role is allowed to see;
   this file wires up whatever views exist on the page.
   Data layer: Firebase Realtime Database (via shared.js / MBCore)
═══════════════════════════════════════════════════════ */
(function () {
  "use strict";
  if (!window.MBCore) return;

  var PAGE  = document.body.getAttribute("data-dash");               // superadmin | admin | staff
  var ALLOW = (document.body.getAttribute("data-allow") || "").split(",").filter(Boolean);
  var db = MBCore.db, auth = MBCore.auth;

  var ME = null, ROLE = null, PROFILE = null, PTR = null;
  var PRODUCTS = [], posCart = [], editingId = null;
  var USERS_CACHE = [];

  /* ── helpers ── */
  var $  = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var peso = function (n) { return "₱" + Number(n || 0).toLocaleString("en-PH"); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  };
  var ts = function () { return new Date().toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" }); };
  var fmtDate = function (v) { return v ? new Date(Number(v)).toLocaleDateString("en-PH") : "—"; };
  var PH_VAT_STANDARD = 12;
  function roundMoney(n) { return Math.round(Number(n) * 100) / 100; }

  var toastT;
  function toast(msg, isError) {
    var t = $("#toast"); if (!t) return;
    t.textContent = msg;
    t.classList.toggle("error", !!isError);
    t.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.classList.remove("show"); }, 2800);
  }

  function computePhVat(amount, o) {
    o = o || {};
    var rate = o.rate != null ? o.rate : PH_VAT_STANDARD;
    var vatType = o.vatType || "standard";
    var inclusive = o.inclusive !== false;
    var line = Number(amount) || 0;
    if (vatType === "exempt") return { vatType: vatType, vatRate: 0, vatableSales: roundMoney(line), vatAmount: 0, totalInclusive: roundMoney(line), label: "VAT Exempt (PH)" };
    if (vatType === "zero")   return { vatType: vatType, vatRate: 0, vatableSales: roundMoney(line), vatAmount: 0, totalInclusive: roundMoney(line), label: "Zero-rated VAT (PH)" };
    if (inclusive) {
      var vatable = line / (1 + rate / 100);
      return { vatType: "standard", vatRate: rate, vatableSales: roundMoney(vatable), vatAmount: roundMoney(line - vatable), totalInclusive: roundMoney(line), label: "VAT " + rate + "% (BIR / Philippines)" };
    }
    var vat = line * (rate / 100);
    return { vatType: "standard", vatRate: rate, vatableSales: roundMoney(line), vatAmount: roundMoney(vat), totalInclusive: roundMoney(line + vat), label: "VAT " + rate + "% (BIR / Philippines)" };
  }
  function cartVatBreakdown(items) {
    var vatable = 0, vat = 0, total = 0;
    items.forEach(function (it) {
      var p = PRODUCTS.find(function (x) { return x.id === it.id; });
      var b = computePhVat(it.price * it.qty, {
        rate: p && p.vatRate != null ? p.vatRate : PH_VAT_STANDARD,
        vatType: (p && p.vatType) || "standard",
        inclusive: !(p && p.vatInclusive === false)
      });
      vatable += b.vatableSales; vat += b.vatAmount; total += b.totalInclusive;
    });
    return { vatableSales: roundMoney(vatable), vatAmount: roundMoney(vat), totalInclusive: roundMoney(total) };
  }

  /* ── PHP backup (Firebase stays primary) ── */
  var mirrorT;
  function mirrorToPhp() {
    if (!MBCore.PHP_BACKUP) return;
    clearTimeout(mirrorT);
    mirrorT = setTimeout(function () {
      fetch("api/firebase-sync.php", { method: "POST", credentials: "include" }).catch(function () {});
    }, 2500);
  }
  async function php(path, method, body) {
    if (!MBCore.PHP_BACKUP) throw new Error("backup off");
    var c = new AbortController(), t = setTimeout(function () { c.abort(); }, 7000);
    try {
      var r = await fetch(path, { method: method || "GET", credentials: "include", cache: "no-store", signal: c.signal,
        headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok || j.ok === false) throw new Error(j.error || "backup failed");
      return j.data != null ? j.data : j;
    } finally { clearTimeout(t); }
  }

  async function writeAudit(action, details) {
    if (!db || !ME) return;
    try { await db.ref("auditTrail").push({ action: String(action), details: details || {}, actorUid: ME.uid, actorEmail: ME.email || "", actorRole: ROLE || "unknown", at: Date.now() }); } catch (e) { /* rules may deny logging; do not block the primary action */ }
  }
  async function loadAuditTrail() {
    var el = $("#auditTrailList"); if (!el) return;
    try {
      var val = (await db.ref("auditTrail").limitToLast(250).once("value")).val() || {};
      var rows = Object.entries(val).sort(function(a,b){ return (b[1].at||0)-(a[1].at||0); });
      el.innerHTML = rows.length ? '<div class="table-wrap"><table class="admin-table"><thead><tr><th>Date / time</th><th>Actor</th><th>Role</th><th>Action</th><th>Details</th></tr></thead><tbody>' + rows.map(function(e){var a=e[1];return '<tr><td>'+esc(a.at?new Date(a.at).toLocaleString():"—")+'</td><td>'+esc(a.actorEmail||a.actorUid||"—")+'</td><td>'+esc(a.actorRole||"—")+'</td><td>'+esc(a.action||"—")+'</td><td>'+esc(JSON.stringify(a.details||{}))+'</td></tr>';}).join("")+'</tbody></table></div>' : '<p class="muted admin-empty">No audit events yet.</p>';
    } catch(e) { el.innerHTML='<p class="muted admin-empty">Unable to read audit trail. Check Firebase rules.</p>'; }
  }
  async function loadRefunds() {
    var el = $("#refundReport"); if (!el) return;
    try {
      var val=(await db.ref("orders").once("value")).val()||{};
      var rows=Object.entries(val).filter(function(e){return e[1].status==="refunded" || e[1].refundStatus;}).sort(function(a,b){return (b[1].updatedAt||b[1].createdAt||0)-(a[1].updatedAt||a[1].createdAt||0);});
      var total=rows.reduce(function(sum,e){return sum+Number((e[1].refund&&e[1].refund.amount)!=null?e[1].refund.amount:e[1].total||0);},0);
      el.innerHTML='<div class="stats-grid"><div class="stat-card"><span class="stat-val">'+rows.length+'</span><span class="stat-label">Refunded orders</span></div><div class="stat-card"><span class="stat-val">'+peso(total)+'</span><span class="stat-label">Refund total</span></div></div>'+(rows.length?'<div class="table-wrap"><table class="admin-table"><thead><tr><th>Order</th><th>Customer</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>'+rows.map(function(e){var o=e[1];return '<tr><td>'+esc(e[0])+'</td><td>'+esc((o.shipping&&o.shipping.name)||o.email||"Guest")+'</td><td>'+peso((o.refund&&o.refund.amount)!=null?o.refund.amount:o.total)+'</td><td>'+esc(o.refundStatus||o.status)+'</td><td>'+fmtDate(o.updatedAt||o.createdAt)+'</td></tr>';}).join('')+'</tbody></table></div>':'<p class="muted admin-empty">No refunds recorded.</p>');
    } catch(e) { el.innerHTML='<p class="muted admin-empty">Could not load refund report.</p>'; }
  }

  /* ═════════ VIEWS ═════════ */
  var TITLES = {
    overview: "Overview", products: "Products", orders: "Orders & Delivery",
    inventory: "Ingredients & Supplies", users: "Users & Roles", sellers: "Sellers",
    support: "Chat Support", refunds: "Refund Reports", audit: "Audit Trail", pos: "Point of Sale", sales: "Sales History"
  };
  var LOADERS = {
    overview: function () { loadStats(); },
    products: function () { closeEditor(); renderProductList(); },
    orders: function () { loadOrders(); },
    inventory: function () { loadInventory(); },
    refunds: function () { loadRefunds(); },
    audit: function () { loadAuditTrail(); },
    users: function () { loadUsers(); },
    sellers: function () { loadSellers(); },
    support: function () { loadConvs(); },
    pos: function () { renderPosGrid(); renderPosReceipt(); },
    sales: function () { loadSales(); }
  };
  function showView(name) {
    if (!$("#view-" + name)) name = "overview";
    $$(".view").forEach(function (v) { v.hidden = v.id !== "view-" + name; });
    $$("[data-view]").forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-view") === name); });
    var vt = $("#viewTitle"); if (vt) vt.textContent = TITLES[name] || name;
    try { history.replaceState(null, "", "#" + name); } catch (e) {}
    if (LOADERS[name]) LOADERS[name]();
  }

  /* ═════════ STATS ═════════ */
  function setText(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; }

  async function loadStats() {
    try {
      if (PAGE === "staff") {
        var r = await Promise.all([db.ref("orders").once("value"), db.ref("mb_products").once("value")]);
        var orders = r[0].val() || {}, prods = Object.values(r[1].val() || {});
        var start = new Date(); start.setHours(0, 0, 0, 0);
        var today = Object.values(orders).filter(function (o) {
          return (o.createdAt || 0) >= start.getTime() && ["cancelled", "refunded"].indexOf(o.status) === -1;
        });
        setText("stToday", peso(today.reduce(function (s, o) { return s + (o.total || 0); }, 0)));
        setText("stTodayOrders", today.length);
        setText("stLow", prods.filter(function (p) { return (p.stock || 0) > 0 && (p.stock || 0) < 5; }).length);
        setText("stOut", prods.filter(function (p) { return (p.stock || 0) <= 0; }).length);
        return;
      }
      var res = await Promise.all([
        db.ref("orders").once("value"), db.ref("users").once("value"), db.ref("mb_products").once("value"),
        db.ref("sellers").once("value"), db.ref("support_convs").once("value")
      ]);
      var ord = res[0].val() || {};
      var revenue = Object.values(ord).reduce(function (s, o) { return s + (o.total || 0); }, 0);
      setText("statRevenue", peso(revenue));
      setText("statOrders", Object.keys(ord).length);
      setText("statUsers", Object.keys(res[1].val() || {}).length);
      setText("statProducts", Object.keys(res[2].val() || {}).length);
      setText("statSellers", Object.keys(res[3].val() || {}).length);
      setText("statChats", Object.keys(res[4].val() || {}).length);

      var recent = Object.entries(ord).sort(function (a, b) { return (b[1].createdAt || 0) - (a[1].createdAt || 0); }).slice(0, 5);
      var rl = $("#recentOrdersList");
      if (rl) rl.innerHTML = recent.length ? '<div class="table-wrap"><table class="admin-table"><thead><tr><th>ID</th><th>Customer</th><th>Contact</th><th>Total</th><th>Payment</th><th>Status</th><th>Date</th></tr></thead><tbody>' +
        recent.map(function (e) {
          var id = e[0], o = e[1];
          return "<tr><td class=\"mono-muted\">" + esc(id.slice(-8)) + "</td><td>" + esc((o.shipping && o.shipping.name) || o.email || "guest") +
            "</td><td class=\"admin-sub\">" + esc((o.shipping && o.shipping.phone) || "—") + "</td><td>" + peso(o.total) +
            "</td><td>" + esc(o.payMethod || "COD") + "</td><td><span class=\"status-badge status-" + esc(o.status || "processing") + "\">" + esc(o.status || "processing") +
            "</span></td><td class=\"admin-sub\">" + fmtDate(o.createdAt) + "</td></tr>";
        }).join("") + "</tbody></table></div>" : '<p class="muted admin-empty">No orders yet.</p>';
    } catch (e) { toast("Could not load statistics", true); }
  }

  /* ═════════ PRODUCTS (admin / super admin) ═════════ */
  function renderProductList() {
    var el = $("#adminProductsList"); if (!el) return;
    if (!PRODUCTS.length) { el.innerHTML = '<p class="muted admin-empty">No products yet.</p>'; return; }
    el.innerHTML = '<div class="table-wrap"><table class="admin-table"><thead><tr><th></th><th>Product / Supplier</th><th>Price (PH VAT)</th><th>Category</th><th>Delivery lead</th><th>Actions</th></tr></thead><tbody>' +
      PRODUCTS.map(function (p) {
        var vat = computePhVat(p.price || 0, { rate: p.vatRate != null ? p.vatRate : PH_VAT_STANDARD, vatType: p.vatType || "standard", inclusive: p.vatInclusive !== false });
        return "<tr><td>" + (p.images && p.images[0] ? '<img src="' + esc(p.images[0]) + '" class="admin-thumb" alt="">' : '<div class="admin-thumb"></div>') + "</td>" +
          "<td><strong>" + esc(p.name) + '</strong><div class="admin-sub">' + esc(p.supplier || "—") + "</div></td>" +
          "<td>" + peso(p.price) + '<div class="admin-sub">VAT ' + vat.vatAmount.toFixed(2) + " incl.</div></td>" +
          "<td>" + esc(p.category || "—") + "</td><td>" + (p.deliveryLeadDays != null ? esc(p.deliveryLeadDays) + "d" : "—") + "</td>" +
          '<td><button class="admin-link-btn" data-act="product-edit" data-id="' + esc(p.id) + '">Edit</button>' +
          '<button class="admin-link-btn danger" data-act="product-delete" data-id="' + esc(p.id) + '">Delete</button></td></tr>';
      }).join("") + "</tbody></table></div>";
  }

  function updateVatPreview() {
    var box = $("#pfVatPreview"); if (!box) return;
    var price = parseFloat($("#pfPrice").value) || 0;
    var rate = parseFloat($("#pfVatRate").value) || PH_VAT_STANDARD;
    var vatType = $("#pfVatType").value || "standard";
    var inclusive = $("#pfVatInclusive").value !== "exclusive";
    var b = computePhVat(price, { rate: rate, vatType: vatType, inclusive: inclusive });
    box.innerHTML = '<div class="vat-preview-row"><span>' + esc(b.label) + "</span><strong>" + peso(b.vatAmount) + "</strong></div>" +
      '<div class="vat-preview-row"><span>VATable sales</span><strong>' + peso(b.vatableSales) + "</strong></div>" +
      '<div class="vat-preview-row"><span>Selling price (' + (inclusive ? "incl." : "excl.") + " VAT)</span><strong>" + peso(b.totalInclusive) + "</strong></div>" +
      '<p class="vat-preview-note">Philippines standard rate is 12% (BIR). Shop prices are VAT-inclusive unless you choose exclusive.</p>';
  }

  function openEditor(id) {
    var ed = $("#productEditor"); if (!ed) return;
    editingId = id || null;
    var p = id ? PRODUCTS.find(function (x) { return x.id === id; }) : null;
    var set = function (fid, v) { var e = document.getElementById(fid); if (e) e.value = v; };
    $("#prodFormTitle").textContent = p ? "Edit Product" : "Add Product";
    set("pfName", p ? p.name || "" : ""); set("pfPrice", p && p.price != null ? p.price : ""); set("pfOldPrice", p && p.oldPrice ? p.oldPrice : "");
    set("pfStock", p && p.stock != null ? p.stock : ""); set("pfSupplier", p ? p.supplier || "" : ""); set("pfSupplierSku", p ? p.supplierSku || "" : "");
    set("pfSupplierContact", p ? p.supplierContact || "" : ""); set("pfDeliveryLead", p && p.deliveryLeadDays != null ? p.deliveryLeadDays : 3);
    set("pfDeliveryStatus", p ? p.deliveryStatus || "ready" : "ready");
    set("pfDeliveryDate", p && p.deliveryDate ? new Date(p.deliveryDate).toISOString().slice(0, 10) : "");
    set("pfInventoryLoc", p ? p.inventoryLocation || "Main warehouse" : "Main warehouse");
    set("pfReorder", p && p.reorderLevel != null ? p.reorderLevel : 5);
    set("pfSizes", p ? (p.sizes || []).join(",") : ""); set("pfColors", p ? (p.colors || []).join(",") : "");
    set("pfSizePrices", p && p.sizePrices ? Object.keys(p.sizePrices).map(function (s) { return s + ":" + p.sizePrices[s]; }).join(",") : "");
    set("pfImages", p ? (p.images || []).join(",") : ""); set("pfDesc", p ? p.desc || "" : "");
    set("pfCategory", p ? p.category || "new" : "new");
    $("#pfFeatured").checked = !!(p && p.featured); $("#pfSale").checked = !!(p && p.sale);
    set("pfVatRate", p && p.vatRate != null ? p.vatRate : PH_VAT_STANDARD);
    set("pfVatType", (p && p.vatType) || "standard");
    set("pfVatInclusive", p && p.vatInclusive === false ? "exclusive" : "inclusive");
    updateVatPreview();
    $("#productListWrap").hidden = true; ed.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function closeEditor() {
    var ed = $("#productEditor"); if (!ed) return;
    ed.hidden = true; var w = $("#productListWrap"); if (w) w.hidden = false; editingId = null;
  }

  async function saveProduct() {
    var v = function (id) { var e = document.getElementById(id); return e ? e.value : ""; };
    var list = function (id) { return v(id).split(",").map(function (s) { return s.trim(); }).filter(Boolean); };
    var name = v("pfName").trim(), price = parseFloat(v("pfPrice"));
    if (!name || isNaN(price)) { toast("Name and price required", true); return; }
    var sizePrices = {};
    v("pfSizePrices").split(",").forEach(function (entry) {
      var parts = entry.split(":");
      if (parts.length >= 2 && parts[0].trim() && parts[1].trim() !== "" && isFinite(Number(parts[1].trim()))) sizePrices[parts[0].trim()] = Number(parts[1].trim());
    });
    var vatRate = parseFloat(v("pfVatRate")) || PH_VAT_STANDARD, vatType = v("pfVatType") || "standard", vatInclusive = v("pfVatInclusive") !== "exclusive";
    var vb = computePhVat(price, { rate: vatRate, vatType: vatType, inclusive: vatInclusive });
    var dRaw = v("pfDeliveryDate");
    var data = {
      name: name, price: price, oldPrice: parseFloat(v("pfOldPrice")) || null,
      stock: parseInt(v("pfStock"), 10) || 0, supplier: v("pfSupplier").trim(), supplierSku: v("pfSupplierSku").trim(),
      supplierContact: v("pfSupplierContact").trim(), deliveryLeadDays: parseInt(v("pfDeliveryLead"), 10) || 3,
      deliveryStatus: v("pfDeliveryStatus") || "ready", deliveryDate: dRaw ? new Date(dRaw + "T00:00:00").getTime() : null,
      inventoryLocation: v("pfInventoryLoc").trim() || "Main warehouse", reorderLevel: parseInt(v("pfReorder"), 10) || 5,
      category: v("pfCategory"), sizes: list("pfSizes"), sizePrices: sizePrices, colors: list("pfColors"), images: list("pfImages"),
      desc: v("pfDesc").trim(), featured: $("#pfFeatured").checked, sale: $("#pfSale").checked,
      vatRate: vatRate, vatType: vatType, vatInclusive: vatInclusive, priceExVat: vb.vatableSales, vatAmount: vb.vatAmount
    };
    try {
      if (editingId) { await db.ref("mb_products/" + editingId).update(data); toast("Product updated"); }
      else {
        var id = "mb" + Date.now(); data.createdAt = Date.now();
        await db.ref("mb_products/" + id).set(Object.assign({ id: id }, data)); toast("Product added");
      }
      mirrorToPhp(); closeEditor();
    } catch (e) {
      try {
        if (editingId) await php("api/products.php?id=" + encodeURIComponent(editingId), "PATCH", Object.assign({ id: editingId }, data));
        else await php("api/products.php", "POST", data);
        toast("Saved via PHP backup"); closeEditor();
      } catch (e2) { toast("Save failed", true); }
    }
  }
  async function deleteProduct(id) {
    if (!confirm("Delete this product?")) return;
    try { await db.ref("mb_products/" + id).remove(); mirrorToPhp(); toast("Product deleted"); }
    catch (e) {
      try { await php("api/products.php?id=" + encodeURIComponent(id), "DELETE", {}); toast("Deleted via PHP backup"); }
      catch (e2) { toast("Delete failed", true); }
    }
  }

  /* ═════════ ORDERS & DELIVERY ═════════ */
  var STATUSES = ["processing", "fulfilled", "shipped", "delivered", "cancelled", "refunded"];
  var COURIERS = ["J&T Express", "LBC", "Grab Express", "Ninja Van", "Flash Express", "Lalamove", "In-store pickup"];

  async function loadOrders() {
    var aol = $("#allOrdersList"); if (!aol) return;
    try {
      var val = (await db.ref("orders").once("value")).val() || {};
      var sorted = Object.entries(val).sort(function (a, b) { return (b[1].createdAt || 0) - (a[1].createdAt || 0); });
      setText("deliveryPendingCount", sorted.filter(function (e) { return ["delivered", "cancelled", "refunded"].indexOf(e[1].status || "processing") === -1; }).length);
      if (!sorted.length) { aol.innerHTML = '<p class="muted admin-empty">No buyer orders yet.</p>'; return; }
      var html = '<div class="table-wrap"><table class="admin-table"><thead><tr><th style="width:28px"></th><th>Order</th><th>Buyer</th><th>Contact</th><th>Items</th><th>Total (incl. VAT)</th><th>Courier / Tracking</th><th>Status</th><th>Date</th></tr></thead><tbody>';
      sorted.forEach(function (e) {
        var id = e[0], o = e[1], sh = o.shipping || {}, del = o.delivery || {};
        var vatAmt = o.vat && o.vat.vatAmount != null ? o.vat.vatAmount : computePhVat(o.total || 0, { inclusive: true }).vatAmount;
        html += '<tr class="delivery-row" data-act="order-toggle" data-id="' + esc(id) + '"><td>▸</td><td class="mono-muted">' + esc(id.slice(-10)) +
          "</td><td><strong>" + esc(sh.name || o.email || "Guest") + '</strong></td><td class="admin-sub">' + esc(sh.phone || "—") +
          "</td><td>" + (o.items || []).length + "</td><td><strong>" + peso(o.total) + '</strong><div class="admin-sub">VAT ' + peso(vatAmt) + "</div></td>" +
          '<td class="admin-sub">' + esc(del.courier || "—") + '<br><span class="mono-muted">' + esc(del.trackingNumber || "No tracking yet") + "</span></td>" +
          '<td data-stop="1"><select class="admin-select" data-act="order-status" data-id="' + esc(id) + '">' +
          STATUSES.map(function (s) { return "<option" + (o.status === s ? " selected" : "") + ">" + s + "</option>"; }).join("") + "</select></td>" +
          '<td class="admin-sub">' + fmtDate(o.createdAt) + "</td></tr>" +
          '<tr id="detail-' + esc(id) + '" hidden><td colspan="9"><div class="delivery-detail-panel">' +
          '<div class="delivery-detail-col"><h5>Ship to (buyer)</h5><p>' + esc(sh.name || "") + "<br>" + esc(sh.address || "") + "<br>" + esc(sh.city || "") + " " + esc(sh.postal || "") + ", " + esc(sh.country || "Philippines") + '</p><p class="admin-sub">' + esc(sh.email || o.email || "") + " · " + esc(sh.phone || "") + "</p></div>" +
          '<div class="delivery-detail-col"><h5>Order &amp; PH VAT</h5>' + (o.items || []).map(function (i) { return '<div class="admin-sub">' + esc(i.name) + " × " + esc(i.qty) + " — " + peso(i.price * i.qty) + "</div>"; }).join("") +
          '<p class="admin-sub" style="margin-top:6px">VATable: ' + peso(o.vat && o.vat.vatableSales) + " · VAT 12%: " + peso(vatAmt) + "</p><p><strong>Total: " + peso(o.total) + "</strong> · " + esc(o.payMethod || "COD") + "</p></div>" +
          '<div class="delivery-detail-col"><h5>Update delivery tracking</h5><div class="delivery-form-grid">' +
          '<select id="del-courier-' + esc(id) + '" class="admin-input"><option value="">Select courier</option>' + COURIERS.map(function (c) { return "<option" + (del.courier === c ? " selected" : "") + ">" + esc(c) + "</option>"; }).join("") + "</select>" +
          '<input id="del-track-' + esc(id) + '" class="admin-input" placeholder="Tracking number" value="' + esc(del.trackingNumber || "") + '">' +
          '<input id="del-eta-' + esc(id) + '" class="admin-input" placeholder="ETA (e.g. Mar 5, 2026)" value="' + esc(del.eta || "") + '">' +
          '<button type="button" class="btn btn-primary" data-act="order-save" data-id="' + esc(id) + '">Save tracking</button>' +
          '<button type="button" class="btn btn-ghost" data-act="order-print" data-id="' + esc(id) + '">Print</button>' +
          "</div></div></div></td></tr>";
      });
      aol.innerHTML = html + "</tbody></table></div>";
    } catch (e) {
      try {
        var list = await php("api/orders.php", "GET");
        aol.innerHTML = '<div class="table-wrap"><table class="admin-table"><thead><tr><th>Order</th><th>Buyer</th><th>Total</th><th>Status</th><th>Date</th></tr></thead><tbody>' +
          (list || []).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }).map(function (o) {
            return '<tr><td class="mono-muted">' + esc(String(o.id).slice(-10)) + "</td><td>" + esc((o.shipping && o.shipping.name) || o.email || "Guest") + "</td><td>" + peso(o.total) + "</td><td>" + esc(o.status || "processing") + '</td><td class="admin-sub">' + fmtDate(o.createdAt) + "</td></tr>";
          }).join("") + '</tbody></table></div><p class="admin-sub" style="margin-top:8px">Showing PHP backup data (Firebase unavailable).</p>';
      } catch (e2) { aol.innerHTML = '<p class="muted admin-empty">Could not load orders.</p>'; }
    }
  }
  async function saveOrderDelivery(id) {
    var g = function (p) { var e = document.getElementById(p + id); return e ? e.value.trim() : ""; };
    try {
      await db.ref("orders/" + id + "/delivery").update({ courier: g("del-courier-"), trackingNumber: g("del-track-"), eta: g("del-eta-"), updatedAt: Date.now() });
      await writeAudit("order.delivery_updated", { orderId: id, courier: g("del-courier-"), trackingNumber: g("del-track-") });
      mirrorToPhp(); toast("Delivery tracking saved"); loadOrders();
    } catch (e) {
      try { await php("api/orders.php?id=" + encodeURIComponent(id), "PATCH", { delivery: { courier: g("del-courier-"), trackingNumber: g("del-track-"), eta: g("del-eta-"), updatedAt: Date.now() } }); toast("Saved via PHP backup"); loadOrders(); }
      catch (e2) { toast("Could not save delivery info", true); }
    }
  }
  async function updateOrderStatus(id, status) {
    try {
      await db.ref("orders/" + id + "/status").set(status);
      await db.ref("orders/" + id + "/updatedAt").set(Date.now());
      await writeAudit(status === "refunded" ? "order.refunded" : "order.status_changed", { orderId: id, status: status });
      var ref = db.ref("orders/" + id + "/delivery/history");
      var h = (await ref.once("value")).val() || [];
      var list = Array.isArray(h) ? h : Object.values(h);
      list.push({ status: status, at: Date.now(), note: "Status updated to " + status });
      await ref.set(list);
      mirrorToPhp(); toast("Delivery status: " + status);
    } catch (e) {
      try { await php("api/orders.php?id=" + encodeURIComponent(id), "PATCH", { status: status }); toast("Status saved via PHP backup"); }
      catch (e2) { toast("Could not update status", true); }
    }
  }
  function printOrder(id) {
    var row = document.getElementById("detail-" + id); if (!row) return;
    var inner = row.querySelector(".delivery-detail-panel");
    var w = window.open("", "_blank", "width=700,height=500"); if (!w) return;
    w.document.write("<!DOCTYPE html><html><head><title>Order " + esc(id.slice(-10)) + "</title><style>body{font-family:system-ui,sans-serif;padding:32px;max-width:640px}select,input,button{display:none}</style></head><body><h2>Maple's Bean — Order " + esc(id.slice(-10)) + "</h2>" + (inner ? inner.innerHTML : "") + "</body></html>");
    w.document.close(); w.print();
  }

  /* ═════════ INGREDIENT & SUPPLY INVENTORY (Firebase RTDB) ═════════ */
  async function loadInventory() {
    if (PAGE === "staff") { loadStaffStock(); return; }
    renderInventoryApp(); return;
    var il=$("#inventoryList"); if(!il)return;
    try {
      var val=(await db.ref("ingredients").once("value")).val()||{};
      var items=Object.entries(val).map(function(e){return Object.assign({id:e[0]},e[1]);});
      setText("invTotalSku",items.length); setText("invInStock",items.filter(function(x){return Number(x.quantity)>0;}).length);
      setText("invLowStock",items.filter(function(x){return Number(x.quantity)>0&&Number(x.quantity)<=Number(x.reorderLevel||0);}).length);
      setText("invSoldOut",items.filter(function(x){return Number(x.quantity)<=0;}).length);
      il.innerHTML=items.length?'<div class="table-wrap"><table class="admin-table"><thead><tr><th>Ingredient / supply</th><th>Category</th><th>Quantity</th><th>Unit</th><th>Reorder at</th><th>Supplier</th><th>Actions</th></tr></thead><tbody>'+items.sort(function(a,b){return Number(a.quantity)-Number(b.quantity);}).map(function(x){return '<tr><td><strong>'+esc(x.name)+'</strong></td><td>'+esc(x.category||"ingredient")+'</td><td><input class="admin-input" style="max-width:100px" type="number" min="0" step="0.01" data-ing-qty="'+esc(x.id)+'" value="'+Number(x.quantity||0)+'"></td><td>'+esc(x.unit||"pcs")+'</td><td>'+Number(x.reorderLevel||0)+'</td><td>'+esc(x.supplier||"—")+'</td><td><button class="admin-link-btn" data-act="ingredient-save" data-id="'+esc(x.id)+'">Save qty</button> <button class="admin-link-btn danger" data-act="ingredient-delete" data-id="'+esc(x.id)+'">Delete</button></td></tr>';}).join('')+'</tbody></table></div>':'<p class="muted admin-empty">No ingredients or supplies yet. Add sugar, milk, cups, straws, and other stock above.</p>';
    } catch(e){il.innerHTML='<p class="muted admin-empty">Could not load ingredients. Check Firebase rules.</p>';}
  }
  async function addIngredient(){
    var name=( $("#ingName").value||"").trim(); if(!name){toast("Enter an ingredient or supply name",true);return;}
    var item={name:name,category:$("#ingCategory").value,quantity:Math.max(0,Number($("#ingQty").value)||0),unit:($("#ingUnit").value||"pcs").trim(),reorderLevel:Math.max(0,Number($("#ingReorder").value)||0),supplier:($("#ingSupplier").value||"").trim(),createdAt:Date.now(),updatedAt:Date.now(),createdBy:ME.uid};
    try{var r=db.ref("ingredients").push();await r.set(item);await writeAudit("ingredient.create",{id:r.key,name:name,quantity:item.quantity,unit:item.unit});["ingName","ingQty","ingUnit","ingReorder","ingSupplier"].forEach(function(id){$("#"+id).value="";});toast("Ingredient added to Firebase inventory");loadInventory();}
    catch(e){toast("Could not add ingredient. Check Firebase rules.",true);}
  }
  async function saveIngredient(id){var input=document.querySelector('[data-ing-qty="'+(window.CSS&&CSS.escape?CSS.escape(id):id)+'"]');if(!input)return;var qty=Math.max(0,Number(input.value)||0);try{await db.ref("ingredients/"+id).update({quantity:qty,updatedAt:Date.now(),updatedBy:ME.uid});await writeAudit("ingredient.update",{id:id,quantity:qty});toast("Ingredient stock saved");loadInventory();}catch(e){toast("Could not save ingredient stock",true);}}
  async function deleteIngredient(id){if(!confirm("Delete this ingredient/supply record?"))return;try{var snap=await db.ref("ingredients/"+id).once("value");await db.ref("ingredients/"+id).remove();await writeAudit("ingredient.delete",{id:id,name:(snap.val()||{}).name||""});toast("Ingredient deleted");loadInventory();}catch(e){toast("Could not delete ingredient",true);}}

  /* ═════════ USERS & ROLES (admin / super admin) ═════════ */
  function effectiveRole(u) {
    var r = MBCore.normalizeRole(u.role);
    if (r === "superadmin") return (PTR && PTR.uid === u.id) ? "superadmin" : "admin";
    return r;
  }
  async function loadUsers() {
    var el = $("#allUsersList"); if (!el) return;
    el.innerHTML = '<p class="muted admin-empty">Loading users…</p>';
    try {
      var r = await Promise.all([db.ref("users").once("value"), db.ref("system/superAdmin").once("value")]);
      PTR = r[1].val() || null;
      USERS_CACHE = Object.entries(r[0].val() || {}).map(function (e) { return Object.assign({ id: e[0] }, e[1]); });
      renderUsers();
    } catch (e) {
      el.innerHTML = '<p class="muted admin-empty">Could not load users. Publish database.rules.json and make sure this account has the admin role in Firebase.</p>';
    }
  }
  function renderUsers() {
    var el = $("#allUsersList"); if (!el) return;
    var q = (($("#userSearch") || {}).value || "").toLowerCase();
    var list = USERS_CACHE.filter(function (u) {
      return !q || String(u.username || u.name || "").toLowerCase().indexOf(q) !== -1 || String(u.email || "").toLowerCase().indexOf(q) !== -1;
    }).sort(function (a, b) { return String(a.email || "").localeCompare(String(b.email || "")); });
    if (!list.length) { el.innerHTML = '<p class="muted admin-empty">No users found.</p>'; return; }
    var options = ROLE === "superadmin" ? ["customer", "staff", "seller", "admin"] : ["customer", "staff", "seller"];
    el.innerHTML = '<div class="table-wrap"><table class="admin-table"><thead><tr><th>User</th><th>Role</th><th>Joined</th></tr></thead><tbody>' +
      list.map(function (u) {
        var role = effectiveRole(u);
        var locked = u.id === ME.uid || role === "superadmin" || (role === "admin" && ROLE !== "superadmin");
        var cell = locked
          ? '<span class="role-pill ' + esc(role) + '">' + esc(role) + "</span>" + (u.id === ME.uid ? ' <span class="admin-sub">(you)</span>' : "")
          : '<select class="admin-select" data-act="role" data-uid="' + esc(u.id) + '">' + options.map(function (o) { return "<option" + (o === role ? " selected" : "") + ">" + o + "</option>"; }).join("") + "</select>";
        return "<tr><td><strong>" + esc(u.username || u.name || (u.email || "").split("@")[0] || "—") + '</strong><div class="admin-sub">' + esc(u.email || "") + "</div></td><td>" + cell + '</td><td class="admin-sub">' + fmtDate(u.createdAt || u.created_at) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }
  async function changeRole(uid, role) {
    var u = USERS_CACHE.find(function (x) { return x.id === uid; });
    if (!u || uid === ME.uid) return;
    if (["customer", "staff", "seller", "admin"].indexOf(role) === -1 || (role === "admin" && ROLE !== "superadmin")) { toast("Not allowed", true); renderUsers(); return; }
    if (!confirm("Change " + (u.email || u.username || uid) + " to " + role + "?")) { renderUsers(); return; }
    try {
      var before = u.role;
      await db.ref("users/" + uid + "/role").set(role);
      u.role = role;
      await writeAudit("user.role_changed", { uid: uid, email: u.email || "", from: before || "customer", to: role });
      mirrorToPhp(); toast("Role updated to " + role);
    } catch (e) { toast("Could not change role (check Firebase rules)", true); }
    renderUsers();
  }
  async function loadSuperAdminCard() {
    var el = $("#superAdminCard"); if (!el) return;
    try {
      PTR = (await db.ref("system/superAdmin").once("value")).val() || PTR;
      el.innerHTML = '<div><strong>Super admin</strong><div class="admin-sub">' + esc((PTR && PTR.email) || ME.email || "") + '</div></div><span class="role-pill superadmin">superadmin</span><div class="admin-sub" style="margin-left:auto">Only one super admin exists. It cannot be added, demoted or deleted from the app.</div>';
    } catch (e) { el.innerHTML = '<strong>Super admin</strong>'; }
  }

  /* ═════════ SELLERS ═════════ */
  async function loadSellers() {
    var el = $("#sellersList"); if (!el) return;
    try {
      var val = (await db.ref("sellers").once("value")).val() || {};
      var rows = Object.entries(val).sort(function (a, b) { return (b[1].appliedAt || 0) - (a[1].appliedAt || 0); });
      el.innerHTML = rows.length ? '<div class="table-wrap"><table class="admin-table"><thead><tr><th>Applicant</th><th>Applied</th><th>Status</th><th>Actions</th></tr></thead><tbody>' + rows.map(function (e) {
        var s = e[1], st = s.approved ? "approved" : (s.rejected ? "rejected" : "pending");
        return "<tr><td><strong>" + esc(s.username || (s.email || "").split("@")[0] || e[0]) + '</strong><div class="admin-sub">' + esc(s.email || "") + "</div></td><td class=\"admin-sub\">" + fmtDate(s.appliedAt) + '</td><td><span class="status-badge status-' + (st === "approved" ? "delivered" : st === "rejected" ? "cancelled" : "processing") + '">' + st + "</span></td><td>" +
          (st !== "approved" ? '<button class="admin-link-btn" data-act="seller-approve" data-id="' + esc(e[0]) + '">Approve</button>' : "") +
          (st !== "rejected" ? '<button class="admin-link-btn danger" data-act="seller-reject" data-id="' + esc(e[0]) + '">' + (st === "approved" ? "Revoke" : "Reject") + "</button>" : "") + "</td></tr>";
      }).join("") + "</tbody></table></div>" : '<p class="muted admin-empty">No seller applications.</p>';
    } catch (e) { el.innerHTML = '<p class="muted admin-empty">Could not load sellers. Check Firebase rules.</p>'; }
  }
  async function sellerAction(uid, approve) {
    try {
      await db.ref("sellers/" + uid).update(approve ? { approved: true, rejected: false, approvedAt: Date.now() } : { approved: false, rejected: true, rejectedAt: Date.now() });
      try {
        var cur = (await db.ref("users/" + uid + "/role").once("value")).val() || "customer";
        if (approve && cur === "customer") await db.ref("users/" + uid + "/role").set("seller");
        if (!approve && cur === "seller") await db.ref("users/" + uid + "/role").set("customer");
      } catch (e2) { /* role sync is best effort */ }
      await writeAudit(approve ? "seller.approved" : "seller.rejected", { uid: uid });
      mirrorToPhp(); toast(approve ? "Seller approved" : "Seller rejected"); loadSellers();
    } catch (e) { toast("Could not update seller", true); }
  }

  /* ═════════ CHAT SUPPORT ═════════ */
  var convRef = null, activeConv = null;
  async function loadConvs() {
    var el = $("#supportConvList"); if (!el) return;
    try {
      var val = (await db.ref("support_convs").once("value")).val() || {};
      var rows = Object.entries(val).sort(function (a, b) { return (b[1].lastMsg || b[1].createdAt || 0) - (a[1].lastMsg || a[1].createdAt || 0); });
      el.innerHTML = rows.length ? '<div class="table-wrap"><table class="admin-table"><thead><tr><th>Customer</th><th>Last message</th><th>When</th><th></th></tr></thead><tbody>' + rows.map(function (e) {
        var c = e[1];
        return "<tr><td><strong>" + esc(c.email || "anonymous") + "</strong></td><td class=\"admin-sub\">" + esc(c.lastText || "—") + "</td><td class=\"admin-sub\">" + fmtDate(c.lastMsg || c.createdAt) + '</td><td><button class="admin-link-btn" data-act="conv-open" data-id="' + esc(e[0]) + '" data-email="' + esc(c.email || "") + '">Open</button></td></tr>';
      }).join("") + "</tbody></table></div>" : '<p class="muted admin-empty">No support conversations yet.</p>';
    } catch (e) { el.innerHTML = '<p class="muted admin-empty">Could not load conversations. Check Firebase rules.</p>'; }
  }
  function openConv(id, email) {
    if (convRef) { try { convRef.off(); } catch (e) {} }
    activeConv = id;
    var area = $("#supportReplyArea"), box = $("#adminChatMessages");
    if (!area || !box) return;
    area.hidden = false; box.innerHTML = "";
    setText("supportReplyTitle", "Chat with " + (email || "customer"));
    convRef = db.ref("support_msgs/" + id);
    convRef.on("child_added", function (snap) {
      var m = snap.val() || {};
      var d = document.createElement("div");
      d.className = "chat-msg " + (m.from === "agent" ? "agent" : "user");
      d.style.cssText = "margin:6px 0;padding:8px 12px;border-radius:10px;max-width:80%;" + (m.from === "agent" ? "margin-left:auto;background:#ead9b6" : "background:#f1ece2");
      d.textContent = m.text || "";
      box.appendChild(d); box.scrollTop = box.scrollHeight;
    });
  }
  async function sendReply() {
    var inp = $("#adminChatInput"); if (!inp || !activeConv) return;
    var text = inp.value.trim(); if (!text) return;
    inp.value = "";
    try {
      await db.ref("support_msgs/" + activeConv).push({ text: text, from: "agent", time: ts(), uid: ME.uid });
      await db.ref("support_convs/" + activeConv).update({ lastMsg: Date.now(), lastText: text, agentTyping: false });
    } catch (e) { toast("Could not send reply", true); }
  }

  /* ═════════ VOICE CALLS (WebRTC, answers the storefront's call button) ═════════ */
  var ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }] };
  var pc = null, localStream = null, activeCallRef = null;
  function startCallListener() {
    if (!$("#adminCallStatus")) return;
    db.ref("webrtc_calls").on("value", function (snap) {
      var calls = snap.val() || {}, box = $("#adminCallStatus");
      var ringing = Object.entries(calls).filter(function (e) { return e[1] && e[1].status === "ringing"; });
      if (activeCallRef) return;
      if (!ringing.length) { box.hidden = true; box.innerHTML = ""; return; }
      box.hidden = false;
      box.innerHTML = ringing.map(function (e) {
        return '<div><strong>Incoming call</strong> — ' + esc(e[1].callerEmail || "Guest") + ' <button class="btn btn-primary" data-act="call-answer" data-id="' + esc(e[0]) + '">Answer</button> <button class="btn btn-ghost" data-act="call-reject" data-id="' + esc(e[0]) + '">Decline</button></div>';
      }).join("");
    }, function () {});
  }
  async function answerCall(id) {
    var box = $("#adminCallStatus");
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      activeCallRef = db.ref("webrtc_calls/" + id);
      var data = (await activeCallRef.once("value")).val();
      if (!data || !data.offer) throw new Error("no offer");
      pc = new RTCPeerConnection(ICE);
      localStream.getTracks().forEach(function (t) { pc.addTrack(t, localStream); });
      pc.ontrack = function (ev) { var a = $("#remoteAudio"); if (a) a.srcObject = ev.streams[0]; };
      pc.onicecandidate = function (ev) { if (ev.candidate) activeCallRef.child("agentCandidates").push(ev.candidate.toJSON()); };
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      var ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
      await activeCallRef.update({ answer: { type: ans.type, sdp: ans.sdp }, status: "active", agentId: ME.uid });
      activeCallRef.child("callerCandidates").on("child_added", function (s) { try { pc && pc.addIceCandidate(new RTCIceCandidate(s.val())); } catch (e) {} });
      activeCallRef.child("status").on("value", function (s) { if (s.val() === "ended") hangUp(true); });
      box.hidden = false;
      box.innerHTML = '<div><strong>Call in progress</strong> <button class="btn btn-ghost" data-act="call-hangup">Hang up</button></div>';
    } catch (e) { toast("Could not answer call (microphone blocked?)", true); hangUp(true); }
  }
  async function rejectCall(id) { try { await db.ref("webrtc_calls/" + id).update({ status: "ended" }); } catch (e) {} }
  function hangUp(remote) {
    var ref = activeCallRef; activeCallRef = null;
    if (ref) { try { ref.child("callerCandidates").off(); ref.child("status").off(); if (!remote) ref.update({ status: "ended" }); } catch (e) {} }
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
    if (localStream) { localStream.getTracks().forEach(function (t) { t.stop(); }); localStream = null; }
    var a = $("#remoteAudio"); if (a) a.srcObject = null;
    var box = $("#adminCallStatus"); if (box) { box.hidden = true; box.innerHTML = ""; }
  }

  /* ═════════ POINT OF SALE ═════════ */
  function renderPosGrid() {
    var el = $("#posProductGrid"); if (!el) return;
    var q = (($("#posSearch") || {}).value || "").toLowerCase();
    var list = PRODUCTS.filter(function (p) { return (p.stock || 0) > 0 && String(p.name || "").toLowerCase().indexOf(q) !== -1; });
    el.innerHTML = list.length ? list.map(function (p) {
      return '<button type="button" class="pos-product" data-act="pos-add" data-id="' + esc(p.id) + '" style="text-align:left;padding:12px;border:1px solid var(--line-2);border-radius:10px;background:var(--card);cursor:pointer"><strong>' + esc(p.name) + '</strong><div class="admin-sub">' + esc(p.category || "") + '</div><div><b>' + peso(p.price) + '</b> <span class="admin-sub">· ' + (p.stock || 0) + " left</span></div></button>";
    }).join("") : '<p class="muted admin-empty">' + (PRODUCTS.length ? "No matching products in stock." : "No products yet. An admin can add them under Products.") + "</p>";
  }
  function posAdd(id) {
    var p = PRODUCTS.find(function (x) { return x.id === id; }); if (!p) return;
    var ex = posCart.find(function (x) { return x.id === id; });
    if (ex) { if (ex.qty >= (p.stock || 0)) { toast("Only " + (p.stock || 0) + " in stock", true); return; } ex.qty++; }
    else posCart.push({ id: id, name: p.name, price: Number(p.price) || 0, qty: 1 });
    renderPosReceipt();
  }
  function posQty(id, d) {
    var it = posCart.find(function (x) { return x.id === id; }); if (!it) return;
    var p = PRODUCTS.find(function (x) { return x.id === id; });
    it.qty = Math.min(it.qty + d, p ? (p.stock || 0) : it.qty);
    if (it.qty <= 0) posCart = posCart.filter(function (x) { return x.id !== id; });
    renderPosReceipt();
  }
  function printPosReceipt() {
    var w = window.open("", "_blank", "width=380,height=600"); if (!w) return;
    w.document.write("<!DOCTYPE html><html><head><title>Receipt</title><style>body{font:12px Arial,sans-serif;max-width:300px;margin:0 auto;padding:12px}.pos-thermal-line{display:flex;justify-content:space-between;gap:8px;margin:6px 0}small{display:block}header,.pos-thermal-thanks{text-align:center}hr{border:0;border-top:1px dashed #555}.pos-thermal-total{font-weight:700}</style></head><body>" + lastReceiptHtml + "</body></html>");
    w.document.close(); w.print();
  }
  function closePosReceiptModal() { var m = $("#posReceiptModal"); if (m) m.remove(); }

  /* ═════════ STAFF PRODUCT STOCK (staff Inventory tab) ═════════ */
  function loadStaffStock() {
    var el = $("#inventoryList"); if (!el) return;
    var list = PRODUCTS.slice().sort(function (a, b) { return (a.stock || 0) - (b.stock || 0); });
    setText("invTotalSku", list.length);
    setText("invInStock", list.filter(function (p) { return (p.stock || 0) > 0; }).length);
    setText("invLowStock", list.filter(function (p) { return (p.stock || 0) > 0 && (p.stock || 0) < 5; }).length);
    setText("invSoldOut", list.filter(function (p) { return (p.stock || 0) <= 0; }).length);
    el.innerHTML = list.length ? '<div class="table-wrap"><table class="admin-table"><thead><tr><th>Product</th><th>Category</th><th>Stock</th><th></th></tr></thead><tbody>' + list.map(function (p) {
      return "<tr><td><strong>" + esc(p.name) + '</strong></td><td>' + esc(p.category || "—") + '</td><td><button type="button" class="admin-link-btn" data-act="inv-minus" data-id="' + esc(p.id) + '">−</button> <input class="admin-input" style="max-width:80px;display:inline-block" type="number" min="0" data-inv-qty="' + esc(p.id) + '" data-orig="' + (p.stock || 0) + '" value="' + (p.stock || 0) + '"> <button type="button" class="admin-link-btn" data-act="inv-plus" data-id="' + esc(p.id) + '">+</button></td><td><button type="button" class="admin-link-btn" data-act="inv-save" data-id="' + esc(p.id) + '">Save</button></td></tr>';
    }).join("") + "</tbody></table></div>" : '<p class="muted admin-empty">No products yet.</p>';
  }
  function invInput(id) { return document.querySelector('[data-inv-qty="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]'); }
  function invAdjust(id, d) { var i = invInput(id); if (i) i.value = Math.max(0, (parseInt(i.value, 10) || 0) + d); }
  async function invSave(id, quiet) {
    var i = invInput(id); if (!i) return;
    var qty = Math.max(0, parseInt(i.value, 10) || 0);
    try {
      await db.ref("mb_products/" + id + "/stock").set(qty);
      await writeAudit("stock.adjusted", { productId: id, from: Number(i.getAttribute("data-orig")), to: qty });
      i.setAttribute("data-orig", qty); mirrorToPhp();
      if (!quiet) { toast("Stock saved"); loadStaffStock(); }
    } catch (e) { toast("Could not save stock", true); }
  }
  async function invSaveAll() {
    var changed = $$("[data-inv-qty]").filter(function (i) { return String(parseInt(i.value, 10) || 0) !== i.getAttribute("data-orig"); });
    if (!changed.length) { toast("No changes to save"); return; }
    for (var k = 0; k < changed.length; k++) await invSave(changed[k].getAttribute("data-inv-qty"), true);
    toast("Saved " + changed.length + " change(s)"); loadStaffStock();
  }

  /* ═════════ SHARED UI HELPERS (dialog + CSV) ═════════ */
  function dialog(title, fields, okLabel, extras) {
    return new Promise(function (resolve) {
      var m = document.createElement("div"); m.className = "pos-receipt-modal";
      var body = fields.map(function (f) {
        if (f.type === "html") return f.html;
        var attrs = 'class="admin-input" style="width:100%;margin-top:4px" data-f="' + f.id + '"' + (f.readonly ? " readonly" : "");
        var inp;
        if (f.type === "select") inp = "<select " + attrs + ">" + f.options.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(f.value == null ? "" : f.value) ? " selected" : "") + ">" + esc(o[1]) + "</option>"; }).join("") + "</select>";
        else if (f.type === "textarea") inp = "<textarea " + attrs + ' rows="' + (f.rows || 3) + '">' + esc(f.value || "") + "</textarea>";
        else inp = "<input " + attrs + ' type="' + (f.type || "text") + '"' + (f.step ? ' step="' + f.step + '"' : "") + (f.min != null ? ' min="' + f.min + '"' : "") + ' value="' + esc(f.value == null ? "" : f.value) + '" placeholder="' + esc(f.placeholder || "") + '">';
        return '<label style="display:block;margin-bottom:10px;font-size:12px;font-weight:600">' + esc(f.label) + (f.required ? " *" : "") + inp + "</label>";
      }).join("");
      m.innerHTML = '<div class="pos-receipt-dialog" style="width:min(100%,560px)"><div class="pos-receipt-modal-head"><div><h2>' + esc(title) + '</h2></div><button type="button" data-d="x">×</button></div><div>' + body + '</div><div class="pos-receipt-actions">' +
        (extras || []).map(function (x) { return '<button type="button" class="btn btn-ghost" data-d="extra:' + x.act + '" style="color:var(--danger)">' + esc(x.label) + "</button>"; }).join("") +
        '<button type="button" class="btn btn-ghost" data-d="x">Cancel</button><button type="button" class="btn btn-primary" data-d="ok">' + esc(okLabel || "Save") + "</button></div></div>";
      document.body.appendChild(m);
      var first = m.querySelector("[data-f]:not([readonly])"); if (first) first.focus();
      function done(v) { m.remove(); resolve(v); }
      m.addEventListener("click", function (e) {
        var d = e.target.closest("[data-d]"); if (!d) return;
        var k = d.getAttribute("data-d");
        if (k === "x") return done(null);
        var vals = {}, bad = null;
        m.querySelectorAll("[data-f]").forEach(function (i) { vals[i.getAttribute("data-f")] = i.value; });
        if (k.indexOf("extra:") === 0) { vals.__action = k.slice(6); return done(vals); }
        fields.forEach(function (f) { if (f.required && !String(vals[f.id] || "").trim() && !bad) bad = f.label; });
        if (bad) { toast(bad + " is required", true); return; }
        done(vals);
      });
    });
  }
  function csvDownload(name, rows) {
    var t = rows.map(function (r) { return r.map(function (c) { return '"' + String(c == null ? "" : c).replace(/"/g, '""') + '"'; }).join(","); }).join("\r\n");
    var b = new Blob(["\ufeff" + t], { type: "text/csv" });
    var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  var peso2 = function (n) { return "₱" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var fmtDT = function (v) { return v ? new Date(Number(v)).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : "—"; };

  /* ═════════ INVENTORY v2 — ingredients, suppliers, stock log ═════════ */
  var ING = [], SUP = [], IVTAB = "items", IVF = { q: "", cat: "all", low: false };
  var ING_CATS = [["ingredient", "Ingredient"], ["packaging", "Packaging / supplies"], ["cleaning", "Cleaning supplies"], ["other", "Other"]];
  var supName = function (x) { var s = SUP.find(function (y) { return y.id === x.supplierId; }); return s ? s.name : (x.supplier || ""); };

  async function ivLoad() {
    var r = await Promise.all([db.ref("ingredients").once("value"), db.ref("suppliers").once("value")]);
    ING = Object.entries(r[0].val() || {}).map(function (e) { return Object.assign({ id: e[0] }, e[1]); });
    SUP = Object.entries(r[1].val() || {}).map(function (e) { return Object.assign({ id: e[0] }, e[1]); });
    try { RECIPES = (await db.ref("recipes").once("value")).val() || {}; } catch (e) { }
  }
  function renderInventoryApp() {
    var v = $("#view-inventory"); if (!v) return;
    if (!v.__iv) {
      v.__iv = true;
      v.addEventListener("click", function (e) {
        var t = e.target.closest("[data-iv]"); if (!t || t.tagName === "INPUT" || t.tagName === "SELECT") return;
        var a = t.getAttribute("data-iv"), id = t.getAttribute("data-id");
        if (a.indexOf("tab:") === 0) { IVTAB = a.slice(4); ivRender(); }
        else if (a === "add") ivItemForm(null);
        else if (a === "edit") ivItemForm(id);
        else if (a === "restock") ivRestock(id);
        else if (a === "use") ivUse(id);
        else if (a === "del") ivDelete(id);
        else if (a === "csv") ivCsv();
        else if (a === "shop") ivShopping();
        else if (a === "sup-add") ivSupForm(null);
        else if (a === "sup-edit") ivSupForm(id);
        else if (a === "sup-del") ivSupDelete(id);
        else if (a === "recipe-edit") ivRecipeEdit(id);
        else if (a === "po-new") ivPoNew();
        else if (a === "po-auto") ivPoAuto();
        else if (a === "po-view") ivPoShow(id);
        else if (a === "po-order") ivPoStatus(id, "ordered", "Marked as ordered");
        else if (a === "po-receive") ivPoStatus(id, "received", "Order received — stock updated");
        else if (a === "po-cancel") ivPoStatus(id, "cancelled", "Order cancelled");
        else if (a === "ct-apply") ivStocktakeApply();
        else if (a === "refresh") { ivLoad().then(ivRender); }
      });
      var onF = function (e) {
        var t = e.target; var k = t.getAttribute && t.getAttribute("data-iv"); if (!k) return;
        if (k === "q") IVF.q = t.value.toLowerCase(); else if (k === "cat") IVF.cat = t.value; else if (k === "low") IVF.low = t.checked; else return;
        ivItemsTable();
      };
      v.addEventListener("input", onF); v.addEventListener("change", onF);
    }
    v.innerHTML = '<p class="muted admin-empty">Loading inventory…</p>';
    ivLoad().then(ivRender).catch(function () { v.innerHTML = '<p class="muted admin-empty">Could not load inventory. Publish the updated database.rules.json and make sure you are signed in as admin / super admin.</p>'; });
  }
  function ivRender() {
    var v = $("#view-inventory"); if (!v) return;
    var tabs = [["items", "Ingredients & supplies"], ["recipes", "Recipes & costs"], ["po", "Purchase orders"], ["stocktake", "Stocktake"], ["suppliers", "Suppliers (" + SUP.length + ")"], ["log", "Stock log"]];
    var h = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">' + tabs.map(function (t) {
      return '<button type="button" class="btn ' + (IVTAB === t[0] ? "btn-primary" : "btn-ghost") + '" data-iv="tab:' + t[0] + '">' + t[1] + "</button>";
    }).join("") + '<button type="button" class="btn btn-ghost" data-iv="refresh" style="margin-left:auto">↻ Refresh</button></div><div id="ivBody"></div>';
    v.innerHTML = h;
    if (IVTAB === "items") ivItemsView(); else if (IVTAB === "suppliers") ivSuppliersView(); else if (IVTAB === "recipes") ivRecipesView(); else if (IVTAB === "po") ivPoView(); else if (IVTAB === "stocktake") ivStocktakeView(); else ivLogView();
  }
  function ivStatus(x) { var q = Number(x.quantity) || 0, r = Number(x.reorderLevel) || 0; return q <= 0 ? "out" : (q <= r ? "low" : "ok"); }
  function ivItemsView() {
    var b = $("#ivBody");
    b.innerHTML = '<div class="stats-grid" id="ivStats"></div><div id="ivAlert"></div>' +
      '<div class="section-head" style="gap:8px;flex-wrap:wrap"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
      '<input class="search" data-iv="q" placeholder="Search items…" style="width:200px" value="' + esc(IVF.q) + '">' +
      '<select class="admin-select" data-iv="cat"><option value="all">All categories</option>' + ING_CATS.map(function (c) { return '<option value="' + c[0] + '"' + (IVF.cat === c[0] ? " selected" : "") + ">" + c[1] + "</option>"; }).join("") + "</select>" +
      '<label style="font-size:12px"><input type="checkbox" data-iv="low"' + (IVF.low ? " checked" : "") + "> Low / out only</label></div>" +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn btn-ghost" data-iv="shop">Shopping list</button><button type="button" class="btn btn-ghost" data-iv="csv">Export CSV</button><button type="button" class="btn btn-primary" data-iv="add">+ Add item</button></div></div>' +
      '<div id="ivTable"></div>';
    ivItemsTable();
  }
  function ivItemsTable() {
    var t = $("#ivTable"); if (!t) return;
    var low = ING.filter(function (x) { return ivStatus(x) === "low"; }).length, out = ING.filter(function (x) { return ivStatus(x) === "out"; }).length;
    var value = ING.reduce(function (s, x) { return s + (Number(x.quantity) || 0) * (Number(x.unitCost) || 0); }, 0);
    var st = $("#ivStats");
    if (st) st.innerHTML = '<div class="stat-card"><span class="stat-val">' + ING.length + '</span><span class="stat-label">Item types</span></div><div class="stat-card"><span class="stat-val">' + (ING.length - out) + '</span><span class="stat-label">In stock</span></div><div class="stat-card warn"><span class="stat-val">' + low + '</span><span class="stat-label">Low stock</span></div><div class="stat-card bad"><span class="stat-val">' + out + '</span><span class="stat-label">Out of stock</span></div><div class="stat-card"><span class="stat-val">' + peso(Math.round(value)) + '</span><span class="stat-label">Stock value</span></div>';
    var al = $("#ivAlert");
    var exp7 = ING.filter(function (x) { return x.expiry && new Date(x.expiry + "T00:00:00").getTime() < Date.now() + 7 * 864e5; }).length;
    if (al) al.innerHTML = ((low + out) ? '<div class="panel" style="margin-bottom:14px;border-color:var(--danger)"><strong>' + (low + out) + ' item(s) need restocking.</strong> Use “Shopping list” or “Purchase orders → Draft from low stock”.</div>' : "") + (exp7 ? '<div class="panel" style="margin-bottom:14px;border-color:#b7791f"><strong>' + exp7 + " item(s) expired or expiring within 7 days.</strong></div>" : "");
    var soon = Date.now() + 7 * 864e5;
    var rows = ING.filter(function (x) {
      return (!IVF.q || String(x.name).toLowerCase().indexOf(IVF.q) !== -1 || supName(x).toLowerCase().indexOf(IVF.q) !== -1) &&
        (IVF.cat === "all" || (x.category || "ingredient") === IVF.cat) && (!IVF.low || ivStatus(x) !== "ok");
    }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    if (!rows.length) { t.innerHTML = '<p class="muted admin-empty">' + (ING.length ? "No items match." : "No ingredients or supplies yet. Click “+ Add item” to add sugar, milk, cups, straws…") + "</p>"; return; }
    t.innerHTML = '<div class="table-wrap"><table class="admin-table"><thead><tr><th>Item</th><th>On hand</th><th>Reorder at</th><th>Unit cost</th><th>Value</th><th>Supplier</th><th>Expiry</th><th>Actions</th></tr></thead><tbody>' + rows.map(function (x) {
      var s = ivStatus(x), q = Number(x.quantity) || 0, exp = x.expiry ? new Date(x.expiry + "T00:00:00").getTime() : 0;
      return "<tr><td><strong>" + esc(x.name) + '</strong><div class="admin-sub">' + esc((ING_CATS.find(function (c) { return c[0] === (x.category || "ingredient"); }) || ["", "Ingredient"])[1]) + "</div></td>" +
        '<td><strong style="color:' + (s === "out" ? "var(--danger)" : s === "low" ? "#b7791f" : "inherit") + '">' + q + "</strong> " + esc(x.unit || "pcs") + (s !== "ok" ? ' <span class="status-badge status-' + (s === "out" ? "cancelled" : "processing") + '">' + (s === "out" ? "out" : "low") + "</span>" : "") + "</td>" +
        "<td>" + (Number(x.reorderLevel) || 0) + "</td><td>" + (x.unitCost ? peso2(x.unitCost) : "—") + "</td><td>" + (x.unitCost ? peso2(q * x.unitCost) : "—") + "</td>" +
        "<td>" + (esc(supName(x)) || '<span class="admin-sub">—</span>') + '</td><td class="admin-sub" style="' + (exp && exp < Date.now() ? "color:var(--danger)" : exp && exp < soon ? "color:#b7791f" : "") + '">' + (x.expiry ? esc(x.expiry) : "—") + "</td>" +
        '<td style="white-space:nowrap"><button class="admin-link-btn" data-iv="restock" data-id="' + esc(x.id) + '">Restock</button><button class="admin-link-btn" data-iv="use" data-id="' + esc(x.id) + '">Use / waste</button><button class="admin-link-btn" data-iv="edit" data-id="' + esc(x.id) + '">Edit</button><button class="admin-link-btn danger" data-iv="del" data-id="' + esc(x.id) + '">Delete</button></td></tr>';
    }).join("") + "</tbody></table></div>";
  }
  function ivSupOptions() { return [["", "— None —"]].concat(SUP.map(function (s) { return [s.id, s.name]; })); }
  async function ivItemForm(id) {
    var x = id ? ING.find(function (y) { return y.id === id; }) : null; if (id && !x) return;
    var f = [
      { id: "name", label: "Name", required: true, value: x ? x.name : "", placeholder: "e.g. Whole milk, sugar, cups" },
      { id: "category", label: "Category", type: "select", options: ING_CATS, value: x ? x.category || "ingredient" : "ingredient" },
      { id: "quantity", label: x ? "Quantity on hand (changing this logs an adjustment)" : "Starting quantity", type: "number", step: "0.01", min: 0, value: x ? x.quantity : 0 },
      { id: "unit", label: "Unit", value: x ? x.unit || "" : "", placeholder: "kg, L, pcs, packs" },
      { id: "reorderLevel", label: "Low-stock threshold", type: "number", step: "0.01", min: 0, value: x ? x.reorderLevel || 0 : 0 },
      { id: "unitCost", label: "Cost per unit (₱)", type: "number", step: "0.01", min: 0, value: x ? x.unitCost || "" : "" },
      { id: "supplierId", label: "Supplier" + (SUP.length ? "" : " (add suppliers in the Suppliers tab)"), type: "select", options: ivSupOptions(), value: x ? x.supplierId || "" : "" },
      { id: "expiry", label: "Expiry date (optional)", type: "date", value: x ? x.expiry || "" : "" },
      { id: "notes", label: "Notes / storage location", type: "textarea", rows: 2, value: x ? x.notes || "" : "" }
    ];
    var v = await dialog(x ? "Edit item" : "Add ingredient or supply", f, x ? "Save changes" : "Add to inventory"); if (!v) return;
    var data = { name: v.name.trim(), category: v.category, unit: (v.unit || "pcs").trim(), reorderLevel: Math.max(0, Number(v.reorderLevel) || 0), unitCost: Math.max(0, Number(v.unitCost) || 0), supplierId: v.supplierId || null, expiry: v.expiry || null, notes: v.notes.trim(), quantity: Math.max(0, Number(v.quantity) || 0), updatedAt: Date.now(), updatedBy: ME.uid };
    try {
      if (x) {
        await db.ref("ingredients/" + id).update(data);
        if (data.quantity !== (Number(x.quantity) || 0)) await ivLog(Object.assign({}, x, data, { id: id }), "adjustment", data.quantity - (Number(x.quantity) || 0), data.quantity, 0, "Manual count");
        await writeAudit("ingredient.update", { id: id, name: data.name });
      } else {
        data.createdAt = Date.now(); data.createdBy = ME.uid;
        var r = db.ref("ingredients").push(); await r.set(data);
        if (data.quantity > 0) await ivLog(Object.assign({ id: r.key }, data), "opening", data.quantity, data.quantity, data.unitCost * data.quantity, "Opening stock");
        await writeAudit("ingredient.create", { id: r.key, name: data.name, quantity: data.quantity });
      }
      toast(x ? "Item updated" : "Item added"); await ivLoad(); ivRender();
    } catch (e) { toast("Could not save item. Publish the updated database.rules.json.", true); }
  }
  async function ivLog(item, type, delta, after, cost, note) {
    try { await db.ref("stockLog").push({ itemId: item.id, name: item.name, unit: item.unit || "", type: type, delta: delta, qtyAfter: after, cost: cost || 0, note: note || "", by: ME.email || ME.uid, at: Date.now() }); } catch (e) { /* log is best effort */ }
  }
  async function ivMove(id, delta, type, cost, note) {
    var x = ING.find(function (y) { return y.id === id; });
    var res = await db.ref("ingredients/" + id + "/quantity").transaction(function (cur) { return Math.max(0, (Number(cur) || 0) + delta); }, undefined, false);
    var after = Number(res.snapshot.val()) || 0;
    var upd = { updatedAt: Date.now(), updatedBy: ME.uid }; if (type === "restock") upd.lastRestockedAt = Date.now();
    await db.ref("ingredients/" + id).update(upd);
    await ivLog(x, type, delta, after, cost, note);
    await writeAudit("ingredient." + type, { id: id, name: x.name, delta: delta, after: after });
  }
  async function ivRestock(id) {
    var x = ING.find(function (y) { return y.id === id; }); if (!x) return;
    var v = await dialog("Restock — " + x.name, [
      { id: "qty", label: "Quantity received (" + (x.unit || "pcs") + ")", type: "number", step: "0.01", min: 0, required: true },
      { id: "cost", label: "Cost per unit (₱)", type: "number", step: "0.01", min: 0, value: x.unitCost || "" },
      { id: "note", label: "Note (invoice / delivery ref)", value: "" }
    ], "Add stock"); if (!v) return;
    var qty = Number(v.qty); if (!(qty > 0)) { toast("Enter a quantity above 0", true); return; }
    try {
      var cost = Number(v.cost) || 0;
      await ivMove(id, qty, "restock", cost * qty, v.note.trim() + (supName(x) ? " (" + supName(x) + ")" : ""));
      if (cost) await db.ref("ingredients/" + id + "/unitCost").set(cost);
      toast("Restocked +" + qty + " " + (x.unit || "")); await ivLoad(); ivRender();
    } catch (e) { toast("Could not restock", true); }
  }
  async function ivUse(id) {
    var x = ING.find(function (y) { return y.id === id; }); if (!x) return;
    var v = await dialog("Use / waste — " + x.name, [
      { id: "qty", label: "Quantity removed (" + (x.unit || "pcs") + ", on hand " + (Number(x.quantity) || 0) + ")", type: "number", step: "0.01", min: 0, required: true },
      { id: "type", label: "Reason", type: "select", options: [["used", "Used in production"], ["waste", "Spilled / wasted"], ["expired", "Expired"], ["other", "Other"]], value: "used" },
      { id: "note", label: "Note", value: "" }
    ], "Remove stock"); if (!v) return;
    var qty = Number(v.qty); if (!(qty > 0)) { toast("Enter a quantity above 0", true); return; }
    try { await ivMove(id, -qty, v.type, (Number(x.unitCost) || 0) * qty, v.note.trim()); toast("Stock updated"); await ivLoad(); ivRender(); }
    catch (e) { toast("Could not update stock", true); }
  }
  async function ivDelete(id) {
    var x = ING.find(function (y) { return y.id === id; }); if (!x || !confirm("Delete “" + x.name + "” from inventory?")) return;
    try { await db.ref("ingredients/" + id).remove();
      for (var pid in RECIPES) { var its = (RECIPES[pid].items || []).filter(function (i) { return i.id !== id; }); if (its.length !== (RECIPES[pid].items || []).length) { if (its.length) await db.ref("recipes/" + pid + "/items").set(its); else await db.ref("recipes/" + pid).remove(); } }
      await writeAudit("ingredient.delete", { id: id, name: x.name }); toast("Item deleted"); await ivLoad(); ivRender(); }
    catch (e) { toast("Could not delete item", true); }
  }
  function ivCsv() {
    csvDownload("inventory-" + new Date().toISOString().slice(0, 10) + ".csv", [["Name", "Category", "On hand", "Unit", "Reorder at", "Unit cost", "Value", "Supplier", "Expiry", "Notes"]].concat(ING.map(function (x) {
      return [x.name, x.category || "ingredient", x.quantity || 0, x.unit || "", x.reorderLevel || 0, x.unitCost || 0, (x.quantity || 0) * (x.unitCost || 0), supName(x), x.expiry || "", x.notes || ""];
    })));
  }
  async function ivShopping() {
    var need = ING.filter(function (x) { return ivStatus(x) !== "ok"; });
    if (!need.length) { toast("Everything is above its low-stock threshold"); return; }
    var groups = {};
    need.forEach(function (x) { var k = supName(x) || "No supplier set"; (groups[k] = groups[k] || []).push(x); });
    var txt = Object.keys(groups).sort().map(function (k) {
      var s = SUP.find(function (y) { return y.name === k; });
      return k + (s && (s.phone || s.email) ? "  (" + [s.phone, s.email].filter(Boolean).join(" · ") + ")" : "") + "\n" + groups[k].map(function (x) {
        var buy = Math.max(1, Math.ceil(((Number(x.reorderLevel) || 0) * 2 - (Number(x.quantity) || 0)) * 100) / 100);
        return "  - " + x.name + ": have " + (Number(x.quantity) || 0) + ", order ~" + buy + " " + (x.unit || "pcs");
      }).join("\n");
    }).join("\n\n");
    var v = await dialog("Shopping list", [{ id: "t", label: "Suggested order (about 2× the low-stock threshold)", type: "textarea", rows: 12, value: txt, readonly: true }], "Copy to clipboard");
    if (v) { try { await navigator.clipboard.writeText(txt); toast("Copied"); } catch (e) { toast("Select the text and copy it manually", true); } }
  }

  /* suppliers */
  function ivSuppliersView() {
    var b = $("#ivBody");
    var rows = SUP.slice().sort(function (a, c) { return String(a.name).localeCompare(String(c.name)); });
    b.innerHTML = '<div class="section-head"><p class="view-lead" style="margin:0">Who you buy from. Assign a supplier to each ingredient.</p><button type="button" class="btn btn-primary" data-iv="sup-add">+ Add supplier</button></div>' +
      (rows.length ? '<div class="table-wrap"><table class="admin-table"><thead><tr><th>Supplier</th><th>Contact</th><th>Phone / email</th><th>Lead time</th><th>Items</th><th>Actions</th></tr></thead><tbody>' + rows.map(function (s) {
        var n = ING.filter(function (x) { return x.supplierId === s.id; }).length;
        return "<tr><td><strong>" + esc(s.name) + '</strong><div class="admin-sub">' + esc(s.address || "") + "</div></td><td>" + esc(s.contact || "—") + "</td><td>" + esc(s.phone || "—") + '<div class="admin-sub">' + esc(s.email || "") + "</div></td><td>" + (s.leadDays != null && s.leadDays !== "" ? esc(s.leadDays) + " d" : "—") + "</td><td>" + n + '</td><td><button class="admin-link-btn" data-iv="sup-edit" data-id="' + esc(s.id) + '">Edit</button><button class="admin-link-btn danger" data-iv="sup-del" data-id="' + esc(s.id) + '">Delete</button></td></tr>';
      }).join("") + "</tbody></table></div>" : '<p class="muted admin-empty">No suppliers yet. Click “+ Add supplier”.</p>');
  }
  async function ivSupForm(id) {
    var s = id ? SUP.find(function (y) { return y.id === id; }) : null;
    var v = await dialog(s ? "Edit supplier" : "Add supplier", [
      { id: "name", label: "Supplier name", required: true, value: s ? s.name : "" },
      { id: "contact", label: "Contact person", value: s ? s.contact || "" : "" },
      { id: "phone", label: "Phone", value: s ? s.phone || "" : "" },
      { id: "email", label: "Email", type: "email", value: s ? s.email || "" : "" },
      { id: "address", label: "Address", value: s ? s.address || "" : "" },
      { id: "leadDays", label: "Delivery lead time (days)", type: "number", min: 0, value: s && s.leadDays != null ? s.leadDays : "" },
      { id: "notes", label: "Notes (payment terms, what they supply…)", type: "textarea", rows: 2, value: s ? s.notes || "" : "" }
    ], s ? "Save changes" : "Add supplier"); if (!v) return;
    var data = { name: v.name.trim(), contact: v.contact.trim(), phone: v.phone.trim(), email: v.email.trim(), address: v.address.trim(), leadDays: v.leadDays === "" ? null : Number(v.leadDays), notes: v.notes.trim(), updatedAt: Date.now() };
    try {
      if (s) await db.ref("suppliers/" + id).update(data); else { data.createdAt = Date.now(); await db.ref("suppliers").push(data); }
      await writeAudit(s ? "supplier.update" : "supplier.create", { name: data.name });
      toast("Supplier saved"); await ivLoad(); ivRender();
    } catch (e) { toast("Could not save supplier. Publish the updated database.rules.json.", true); }
  }
  async function ivSupDelete(id) {
    var s = SUP.find(function (y) { return y.id === id; }); if (!s) return;
    var items = ING.filter(function (x) { return x.supplierId === id; });
    if (!confirm("Delete supplier “" + s.name + "”?" + (items.length ? " " + items.length + " item(s) will be left without a supplier." : ""))) return;
    try {
      for (var i = 0; i < items.length; i++) await db.ref("ingredients/" + items[i].id).update({ supplierId: null, supplier: s.name });
      await db.ref("suppliers/" + id).remove(); await writeAudit("supplier.delete", { name: s.name });
      toast("Supplier deleted"); await ivLoad(); ivRender();
    } catch (e) { toast("Could not delete supplier", true); }
  }

  /* stock log */
  async function ivLogView() {
    var b = $("#ivBody"); b.innerHTML = '<p class="muted admin-empty">Loading…</p>';
    try {
      var val = (await db.ref("stockLog").orderByChild("at").limitToLast(200).once("value")).val() || {};
      var rows = Object.values(val).sort(function (a, c) { return (c.at || 0) - (a.at || 0); });
      var LBL = { restock: "Restock", used: "Used", waste: "Waste", expired: "Expired", other: "Other", adjustment: "Count adjustment", opening: "Opening stock" };
      b.innerHTML = '<div class="section-head"><p class="view-lead" style="margin:0">Last 200 stock movements.</p><button type="button" class="btn btn-ghost" id="ivLogCsv">Export CSV</button></div>' + (rows.length ? '<div class="table-wrap"><table class="admin-table"><thead><tr><th>When</th><th>Item</th><th>Type</th><th>Change</th><th>After</th><th>Cost</th><th>By</th><th>Note</th></tr></thead><tbody>' + rows.map(function (r) {
        return '<tr><td class="admin-sub">' + fmtDT(r.at) + "</td><td><strong>" + esc(r.name) + "</strong></td><td>" + esc(LBL[r.type] || r.type) + '</td><td style="color:' + (r.delta < 0 ? "var(--danger)" : "inherit") + '">' + (r.delta > 0 ? "+" : "") + r.delta + " " + esc(r.unit || "") + "</td><td>" + r.qtyAfter + "</td><td>" + (r.cost ? peso2(r.cost) : "—") + '</td><td class="admin-sub">' + esc(r.by || "") + '</td><td class="admin-sub">' + esc(r.note || "") + "</td></tr>";
      }).join("") + "</tbody></table></div>" : '<p class="muted admin-empty">No stock movements yet.</p>');
      var cb = $("#ivLogCsv"); if (cb) cb.onclick = function () { csvDownload("stock-log.csv", [["When", "Item", "Type", "Change", "After", "Cost", "By", "Note"]].concat(rows.map(function (r) { return [fmtDT(r.at), r.name, r.type, r.delta, r.qtyAfter, r.cost || 0, r.by || "", r.note || ""]; }))); };
    } catch (e) { b.innerHTML = '<p class="muted admin-empty">Could not load the stock log. Publish the updated database.rules.json.</p>'; }
  }

  /* ═════════ SALES HISTORY v2 — filters, summary, top products, CSV, refund ═════════ */
  var SL = { range: "30", pay: "all", st: "valid" }, SL_ROWS = [];
  function slIsValid(o) { return ["cancelled", "refunded"].indexOf(o.status) === -1; }
  function slVat(o) { return o.vat && o.vat.vatAmount != null ? Number(o.vat.vatAmount) : (typeof o.vat === "number" ? o.vat : computePhVat(o.total || 0, { inclusive: true }).vatAmount); }
  async function loadSales() {
    var el = $("#salesTable") || $("#salesHistoryList"); if (!el) return;
    try {
      var val = (await db.ref("orders").once("value")).val() || {};
      var q = (($("#salesSearch") || {}).value || "").toLowerCase();
      var f = (($("#salesFilter") || {}).value || "all").toUpperCase();
      var start = 0;
      if (SL.range === "today") { var d = new Date(); d.setHours(0, 0, 0, 0); start = d.getTime(); }
      else if (SL.range !== "all") start = Date.now() - Number(SL.range) * 864e5;
      var pays = {};
      var all = Object.entries(val).filter(function (e) { return (e[1].createdAt || 0) >= start; });
      all.forEach(function (e) { pays[e[1].payMethod || "Cash"] = 1; });
      var rows = all.filter(function (e) {
        var o = e[1];
        return (f === "ALL" || String(o.source || "web").toUpperCase() === f) && (SL.pay === "all" || (o.payMethod || "Cash") === SL.pay) &&
          (SL.st === "all" || (SL.st === "valid" ? slIsValid(o) : !slIsValid(o))) &&
          (!q || e[0].toLowerCase().indexOf(q) !== -1 || String(o.email || "").toLowerCase().indexOf(q) !== -1 || String((o.shipping && o.shipping.name) || "").toLowerCase().indexOf(q) !== -1);
      }).sort(function (a, b) { return (b[1].createdAt || 0) - (a[1].createdAt || 0); });
      SL_ROWS = rows;
      var good = rows.filter(function (e) { return slIsValid(e[1]); });
      var rev = good.reduce(function (s, e) { return s + (Number(e[1].total) || 0); }, 0);
      var vat = good.reduce(function (s, e) { return s + slVat(e[1]); }, 0);
      var prevRev = null; if (start && SL.range !== "all") { var span = Date.now() - start; prevRev = Object.values(val).filter(function (o) { return (o.createdAt || 0) >= start - span && (o.createdAt || 0) < start && slIsValid(o); }).reduce(function (t, o) { return t + (Number(o.total) || 0); }, 0); }
      var refunded = all.filter(function (e) { return e[1].status === "refunded"; });
      var prod = {}, payT = {}, daily = {}, cashT = {}, hourT = [], catT = {}; for (var hh = 0; hh < 24; hh++) hourT.push(0);
      good.forEach(function (e) {
        var o = e[1]; var pm = o.payMethod || "Cash"; payT[pm] = (payT[pm] || 0) + (Number(o.total) || 0);
        var dk = new Date(o.createdAt || 0).toISOString().slice(0, 10); var cn = o.cashier || (o.source === "POS" ? "POS (unnamed)" : "Online"); cashT[cn] = (cashT[cn] || 0) + (Number(o.total) || 0); hourT[new Date(o.createdAt || 0).getHours()] += Number(o.total) || 0; daily[dk] = (daily[dk] || 0) + (Number(o.total) || 0);
        (o.items || []).forEach(function (i) { var k = i.name || i.id; var p = prod[k] = prod[k] || { qty: 0, rev: 0 }; p.qty += Number(i.qty) || 0; p.rev += (Number(i.price) || 0) * (Number(i.qty) || 0); var pr = PRODUCTS.find(function (x) { return x.id === i.id; }); var ck = (pr && pr.category) || "other"; catT[ck] = (catT[ck] || 0) + (Number(i.price) || 0) * (Number(i.qty) || 0); });
      });
      var top = Object.entries(prod).sort(function (a, b) { return b[1].rev - a[1].rev; }).slice(0, 5);
      var days = Object.keys(daily).sort().slice(-14), maxD = Math.max.apply(null, days.map(function (k) { return daily[k]; }).concat([1]));
      var sel = function (key, opts) { return '<select class="admin-select" data-sl="' + key + '">' + opts.map(function (o) { return '<option value="' + o[0] + '"' + (SL[key] === o[0] ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") + "</select>"; };
      var html = '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px">' +
        sel("range", [["today", "Today"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"], ["all", "All time"]]) +
        sel("pay", [["all", "All payments"]].concat(Object.keys(pays).sort().map(function (p) { return [p, p]; }))) +
        sel("st", [["valid", "Completed only"], ["void", "Cancelled / refunded"], ["all", "Everything"]]) +
        '<button type="button" class="btn btn-ghost" data-sl-act="eod" style="margin-left:auto">End-of-day report</button><button type="button" class="btn btn-ghost" data-sl-act="csv">Export CSV</button></div>' +
        '<div class="stats-grid"><div class="stat-card"><span class="stat-val">' + peso(Math.round(rev)) + '</span><span class="stat-label">Revenue' + (prevRev == null ? "" : prevRev ? " (" + (rev >= prevRev ? "▲ " : "▼ ") + Math.abs(Math.round((rev - prevRev) / prevRev * 100)) + "% vs previous period)" : " (no previous sales)") + '</span></div><div class="stat-card"><span class="stat-val">' + good.length + '</span><span class="stat-label">Transactions</span></div><div class="stat-card"><span class="stat-val">' + peso(good.length ? Math.round(rev / good.length) : 0) + '</span><span class="stat-label">Average sale</span></div><div class="stat-card"><span class="stat-val">' + peso(Math.round(vat)) + '</span><span class="stat-label">VAT included</span></div><div class="stat-card bad"><span class="stat-val">' + refunded.length + '</span><span class="stat-label">Refunded</span></div></div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin:14px 0">' +
        '<div class="panel"><h3 class="section-title">Top products</h3>' + (top.length ? top.map(function (t) { return '<div class="pos-receipt-item"><span>' + esc(t[0]) + ' <span class="admin-sub">× ' + t[1].qty + "</span></span><strong>" + peso(Math.round(t[1].rev)) + "</strong></div>"; }).join("") : '<p class="muted">No sales in this period.</p>') + "</div>" +
        '<div class="panel"><h3 class="section-title">By payment method</h3>' + (Object.keys(payT).length ? Object.keys(payT).sort(function (a, b) { return payT[b] - payT[a]; }).map(function (k) { return '<div class="pos-receipt-item"><span>' + esc(k) + "</span><strong>" + peso(Math.round(payT[k])) + "</strong></div>"; }).join("") : '<p class="muted">—</p>') + "</div>" +
        '<div class="panel"><h3 class="section-title">Daily sales</h3>' + (days.length ? '<div style="display:flex;align-items:flex-end;gap:4px;height:90px">' + days.map(function (k) { return '<div title="' + k + ": " + peso(Math.round(daily[k])) + '" style="flex:1;background:var(--honey,#a9812f);border-radius:3px 3px 0 0;height:' + Math.max(4, Math.round(daily[k] / maxD * 100)) + '%"></div>'; }).join("") + '</div><div class="admin-sub" style="display:flex;justify-content:space-between"><span>' + days[0] + "</span><span>" + days[days.length - 1] + "</span></div>" : '<p class="muted">—</p>') + "</div>" +
        '<div class="panel"><h3 class="section-title">By category</h3>' + (Object.keys(catT).length ? Object.keys(catT).sort(function (a, b) { return catT[b] - catT[a]; }).map(function (k) { return '<div class="pos-receipt-item"><span>' + esc(k) + "</span><strong>" + peso(Math.round(catT[k])) + "</strong></div>"; }).join("") : '<p class="muted">—</p>') + "</div>" +
        '<div class="panel"><h3 class="section-title">By cashier / channel</h3>' + (Object.keys(cashT).length ? Object.keys(cashT).sort(function (a, b) { return cashT[b] - cashT[a]; }).map(function (k) { return '<div class="pos-receipt-item"><span>' + esc(k) + "</span><strong>" + peso(Math.round(cashT[k])) + "</strong></div>"; }).join("") : '<p class="muted">—</p>') + "</div>" +
        '<div class="panel"><h3 class="section-title">Busiest hours</h3>' + (function () { var mx = Math.max.apply(null, hourT.concat([1])); var top3 = hourT.map(function (v, h) { return [h, v]; }).filter(function (x) { return x[1] > 0; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 3); return '<div style="display:flex;align-items:flex-end;gap:2px;height:70px">' + hourT.map(function (v, h) { return '<div title="' + h + ":00 — " + peso(Math.round(v)) + '" style="flex:1;background:var(--honey,#a9812f);opacity:.85;border-radius:2px 2px 0 0;height:' + Math.max(2, Math.round(v / mx * 100)) + '%"></div>'; }).join("") + '</div><div class="admin-sub">' + (top3.length ? "Peak: " + top3.map(function (x) { return x[0] + ":00"; }).join(", ") : "No sales") + "</div>"; })() + "</div></div>";
      html += rows.length ? '<div class="table-wrap"><table class="admin-table"><thead><tr><th>Order</th><th>Channel</th><th>Customer</th><th>Status</th><th>Payment</th><th>Total</th><th>Date</th></tr></thead><tbody>' + rows.slice(0, 300).map(function (e) {
        var o = e[1];
        return '<tr class="delivery-row" data-sl-act="detail" data-id="' + esc(e[0]) + '" style="cursor:pointer"><td class="mono-muted">' + esc(e[0].slice(-10)) + "</td><td>" + esc(o.source || "web") + "</td><td>" + esc((o.shipping && o.shipping.name) || o.email || "—") + '</td><td><span class="status-badge status-' + esc(o.status || "processing") + '">' + esc(o.status || "processing") + "</span></td><td>" + esc(o.payMethod || "Cash") + "</td><td><strong>" + peso(o.total) + '</strong></td><td class="admin-sub">' + fmtDT(o.createdAt) + "</td></tr>";
      }).join("") + "</tbody></table></div>" + (rows.length > 300 ? '<p class="admin-sub">Showing the latest 300. Export CSV for everything.</p>' : "") : '<p class="muted admin-empty">No transactions found for these filters.</p>';
      el.innerHTML = html;
    } catch (e) { el.innerHTML = '<p class="muted admin-empty">Could not load sales.</p>'; }
  }
  function slCsv() {
    csvDownload("sales-" + new Date().toISOString().slice(0, 10) + ".csv", [["Order", "Date", "Channel", "Customer", "Status", "Payment", "Items", "VAT", "Total"]].concat(SL_ROWS.map(function (e) {
      var o = e[1]; return [e[0], fmtDT(o.createdAt), o.source || "web", (o.shipping && o.shipping.name) || o.email || "", o.status || "processing", o.payMethod || "Cash", (o.items || []).map(function (i) { return i.name + " x" + i.qty; }).join("; "), slVat(o).toFixed(2), Number(o.total || 0).toFixed(2)];
    })));
  }
  async function slDetail(id) {
    var e = SL_ROWS.find(function (r) { return r[0] === id; }); if (!e) return; var o = e[1];
    var canRefund = (ROLE === "admin" || ROLE === "superadmin") && slIsValid(o);
    var html = '<div style="font-size:13px"><p><strong>' + esc(id) + '</strong><br>' + fmtDT(o.createdAt) + " · " + esc(o.source || "web") + " · " + esc(o.status || "processing") + "</p>" +
      (o.cashier ? '<p class="admin-sub">Cashier: ' + esc(o.cashier) + "</p>" : "") +
      (o.items || []).map(function (i) { return '<div class="pos-receipt-item"><span>' + esc(i.name) + " × " + esc(i.qty) + "</span><span>" + peso2((Number(i.price) || 0) * (Number(i.qty) || 0)) + "</span></div>"; }).join("") +
      '<div class="pos-receipt-item"><span>VAT included</span><span>' + peso2(slVat(o)) + '</span></div><div class="pos-receipt-item"><strong>Total (' + esc(o.payMethod || "Cash") + ")</strong><strong>" + peso2(o.total) + "</strong></div></div>";
    var r = await dialog("Sale details", [{ type: "html", html: html }], "Close", canRefund ? [{ act: "refund", label: "Refund & restock" }] : []);
    if (r && r.__action === "refund") slRefund(id);
  }
  async function slRefund(id) {
    var e = SL_ROWS.find(function (r) { return r[0] === id; }); if (!e) return; var o = e[1];
    if (!confirm("Refund this sale (" + peso2(o.total) + ") and return the items to stock?")) return;
    try {
      await db.ref("orders/" + id).update({ status: "refunded", refundStatus: "refunded", refund: { amount: Number(o.total) || 0, at: Date.now(), by: ME.email || ME.uid }, updatedAt: Date.now() });
      for (var i = 0; i < (o.items || []).length; i++) {
        (function (it) { if (it.id) db.ref("mb_products/" + it.id + "/stock").transaction(function (c) { return (Number(c) || 0) + (Number(it.qty) || 0); }, undefined, false).catch(function () {}); })(o.items[i]);
      }
      await writeAudit("order.refunded", { orderId: id, total: o.total, source: "sales-history" });
      mirrorToPhp(); toast("Sale refunded, stock restored"); loadSales();
    } catch (err) { toast("Could not refund (admin rights required)", true); }
  }
  document.addEventListener("change", function (e) { var k = e.target.getAttribute && e.target.getAttribute("data-sl"); if (k) { SL[k] = e.target.value; loadSales(); } });
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-sl-act]"); if (!t) return;
    var a = t.getAttribute("data-sl-act"); if (a === "csv") slCsv(); else if (a === "detail") slDetail(t.getAttribute("data-id"));
  });

  /* ═════════ RECIPES (auto-deduct ingredients on sale) ═════════ */
  var RECIPES = {}, recipesOn = false, PO = [];
  function ensureRecipesListener() {
    if (recipesOn) return; recipesOn = true;
    db.ref("recipes").on("value", function (s) { RECIPES = s.val() || {}; }, function () {});
  }
  function printHtml(title, body) {
    var w = window.open("", "_blank", "width=720,height=700"); if (!w) { toast("Allow pop-ups to print", true); return; }
    w.document.write("<!DOCTYPE html><html><head><title>" + esc(title) + "</title><style>body{font:13px Arial,sans-serif;padding:24px;max-width:640px;margin:auto}table{width:100%;border-collapse:collapse}td,th{padding:5px 4px;border-bottom:1px solid #ddd;text-align:left}.pos-receipt-item{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #eee}h2,h3{margin:12px 0 6px}</style></head><body><h2>Maple's Bean — " + esc(title) + "</h2>" + body + "</body></html>");
    w.document.close(); w.print();
  }
  function recipeCost(pid) {
    var r = RECIPES[pid]; if (!r || !r.items) return null;
    return r.items.reduce(function (s, it) { var x = ING.find(function (y) { return y.id === it.id; }); return s + (Number(it.qty) || 0) * (x ? Number(x.unitCost) || 0 : 0); }, 0);
  }
  function ivRecipesView() {
    var b = $("#ivBody");
    var list = PRODUCTS.slice().sort(function (a, c) { return String(a.name).localeCompare(String(c.name)); });
    b.innerHTML = '<p class="view-lead">Link each menu product to the ingredients it uses. Every POS sale then deducts those ingredients automatically and the stock log records it. Cost uses each ingredient\'s cost per unit.</p>' +
      (list.length ? '<div class="table-wrap"><table class="admin-table"><thead><tr><th>Product</th><th>Price</th><th>Recipe</th><th>Cost</th><th>Margin</th><th></th></tr></thead><tbody>' + list.map(function (p) {
        var r = RECIPES[p.id], cost = recipeCost(p.id);
        var net = computePhVat(p.price || 0, { rate: p.vatRate != null ? p.vatRate : PH_VAT_STANDARD, vatType: p.vatType || "standard", inclusive: p.vatInclusive !== false }).vatableSales;
        var profit = cost == null ? null : net - cost;
        return "<tr><td><strong>" + esc(p.name) + "</strong></td><td>" + peso2(p.price) + "</td><td class=\"admin-sub\">" + (r && r.items && r.items.length ? r.items.map(function (i) { return esc(i.name) + " " + i.qty + " " + esc(i.unit || ""); }).join(", ") : "No recipe") + "</td><td>" + (cost == null ? "—" : peso2(cost)) + "</td><td>" + (profit == null || !net ? "—" : '<span style="color:' + (profit < 0 ? "var(--danger)" : "inherit") + '">' + peso2(profit) + " (" + Math.round(profit / net * 100) + "%)</span>") + '</td><td><button class="admin-link-btn" data-iv="recipe-edit" data-id="' + esc(p.id) + '">' + (r ? "Edit" : "Set recipe") + "</button></td></tr>";
      }).join("") + "</tbody></table></div>" : '<p class="muted admin-empty">No products yet. Add products first.</p>');
  }
  async function ivRecipeEdit(pid) {
    var p = PRODUCTS.find(function (x) { return x.id === pid; }); if (!p) return;
    if (!ING.length) { toast("Add ingredients first", true); return; }
    var cur = (RECIPES[pid] && RECIPES[pid].items) || [];
    var opts = [["", "— none —"]].concat(ING.map(function (x) { return [x.id, x.name + " (" + (x.unit || "pcs") + ")"]; }));
    var rows = "";
    for (var i = 0; i < 8; i++) {
      var c = cur[i] || {};
      rows += '<div style="display:flex;gap:6px;margin-bottom:6px"><select class="admin-input" data-f="i' + i + '" style="flex:2">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === c.id ? " selected" : "") + ">" + esc(o[1]) + "</option>"; }).join("") + '</select><input class="admin-input" data-f="q' + i + '" type="number" step="0.001" min="0" placeholder="Qty per 1 sold" style="flex:1" value="' + (c.qty || "") + '"></div>';
    }
    var v = await dialog("Recipe — " + p.name, [{ type: "html", html: '<p class="admin-sub">Ingredients used for ONE unit sold.</p>' + rows }], "Save recipe"); if (!v) return;
    var items = [];
    for (var j = 0; j < 8; j++) {
      var id = v["i" + j], q = Number(v["q" + j]); if (!id || !(q > 0)) continue;
      var x = ING.find(function (y) { return y.id === id; }); if (!x) continue;
      items.push({ id: id, name: x.name, unit: x.unit || "", qty: q });
    }
    try {
      if (items.length) await db.ref("recipes/" + pid).set({ name: p.name, items: items, updatedAt: Date.now() }); else await db.ref("recipes/" + pid).remove();
      await writeAudit("recipe.save", { product: p.name, ingredients: items.length });
      toast("Recipe saved"); await ivLoad(); ivRender();
    } catch (e) { toast("Could not save recipe. Publish the updated database.rules.json.", true); }
  }
  async function deductRecipes(items, orderId) {
    for (var a = 0; a < items.length; a++) {
      var rec = RECIPES[items[a].id]; if (!rec || !rec.items) continue;
      for (var b = 0; b < rec.items.length; b++) {
        var r = rec.items[b], need = (Number(r.qty) || 0) * (Number(items[a].qty) || 0); if (!(need > 0)) continue;
        try {
          var res = await db.ref("ingredients/" + r.id + "/quantity").transaction(function (cur) { return Math.max(0, (Number(cur) || 0) - need); }, undefined, false);
          await ivLog({ id: r.id, name: r.name, unit: r.unit }, "used", -need, Number(res.snapshot.val()) || 0, 0, "Sale " + String(orderId).slice(-6));
        } catch (e) { /* never block a sale because of ingredient tracking */ }
      }
    }
  }

  /* ═════════ PURCHASE ORDERS ═════════ */
  async function ivPoView() {
    var b = $("#ivBody"); b.innerHTML = '<p class="muted admin-empty">Loading…</p>';
    try {
      var val = (await db.ref("purchaseOrders").once("value")).val() || {};
      PO = Object.entries(val).map(function (e) { return Object.assign({ id: e[0] }, e[1]); }).sort(function (a, c) { return (c.createdAt || 0) - (a.createdAt || 0); });
    } catch (e) { b.innerHTML = '<p class="muted admin-empty">Could not load purchase orders. Publish the updated database.rules.json.</p>'; return; }
    b.innerHTML = '<div class="section-head"><p class="view-lead" style="margin:0">Order stock from suppliers, then “Receive” to add it to inventory automatically.</p><div style="display:flex;gap:8px"><button type="button" class="btn btn-ghost" data-iv="po-auto">Draft from low stock</button><button type="button" class="btn btn-primary" data-iv="po-new">+ New purchase order</button></div></div>' +
      (PO.length ? '<div class="table-wrap"><table class="admin-table"><thead><tr><th>PO #</th><th>Supplier</th><th>Items</th><th>Total</th><th>Status</th><th>Expected</th><th>Actions</th></tr></thead><tbody>' + PO.map(function (p) {
        var st = p.status || "ordered";
        return "<tr><td><strong>" + esc(p.number || p.id.slice(-6)) + '</strong><div class="admin-sub">' + fmtDT(p.createdAt) + "</div></td><td>" + esc(p.supplierName || "—") + "</td><td>" + (p.lines || []).length + "</td><td>" + peso2(p.total) + '</td><td><span class="status-badge status-' + (st === "received" ? "delivered" : st === "cancelled" ? "cancelled" : "processing") + '">' + st + '</span></td><td class="admin-sub">' + esc(p.expected || "—") + '</td><td style="white-space:nowrap"><button class="admin-link-btn" data-iv="po-view" data-id="' + esc(p.id) + '">View</button>' +
          (st === "draft" ? '<button class="admin-link-btn" data-iv="po-order" data-id="' + esc(p.id) + '">Mark ordered</button>' : "") +
          (st === "ordered" ? '<button class="admin-link-btn" data-iv="po-receive" data-id="' + esc(p.id) + '">Receive</button>' : "") +
          (st === "draft" || st === "ordered" ? '<button class="admin-link-btn danger" data-iv="po-cancel" data-id="' + esc(p.id) + '">Cancel</button>' : "") + "</td></tr>";
      }).join("") + "</tbody></table></div>" : '<p class="muted admin-empty">No purchase orders yet.</p>');
  }
  var poNo = function () { return "PO-" + String(Date.now()).slice(-6); };
  async function ivPoNew() {
    if (!ING.length) { toast("Add ingredients first", true); return; }
    var items = [["", "— none —"]].concat(ING.map(function (x) { return [x.id, x.name + " (" + (x.unit || "pcs") + ")"]; }));
    var rows = "";
    for (var i = 0; i < 6; i++) rows += '<div style="display:flex;gap:6px;margin-bottom:6px"><select class="admin-input" data-f="i' + i + '" style="flex:2">' + items.map(function (o) { return '<option value="' + esc(o[0]) + '">' + esc(o[1]) + "</option>"; }).join("") + '</select><input class="admin-input" data-f="q' + i + '" type="number" min="0" step="0.01" placeholder="Qty" style="flex:1"><input class="admin-input" data-f="c' + i + '" type="number" min="0" step="0.01" placeholder="₱ / unit (blank = last cost)" style="flex:1.4"></div>';
    var v = await dialog("New purchase order", [
      { id: "supplierId", label: "Supplier", type: "select", options: ivSupOptions(), required: true },
      { id: "expected", label: "Expected delivery", type: "date" },
      { type: "html", html: '<div style="font-size:12px;font-weight:600;margin:4px 0">Items</div>' + rows },
      { id: "notes", label: "Notes", type: "textarea", rows: 2 }
    ], "Create order"); if (!v) return;
    var lines = [];
    for (var j = 0; j < 6; j++) {
      var id = v["i" + j], q = Number(v["q" + j]); if (!id || !(q > 0)) continue;
      var x = ING.find(function (y) { return y.id === id; }); if (!x) continue;
      lines.push({ id: id, name: x.name, unit: x.unit || "", qty: q, cost: Number(v["c" + j]) || Number(x.unitCost) || 0 });
    }
    if (!lines.length) { toast("Add at least one item with a quantity", true); return; }
    await ivPoSave(v.supplierId, lines, "ordered", v.expected, v.notes);
  }
  async function ivPoSave(supplierId, lines, status, expected, notes) {
    var s = SUP.find(function (y) { return y.id === supplierId; });
    var total = lines.reduce(function (t, l) { return t + l.qty * l.cost; }, 0);
    try {
      await db.ref("purchaseOrders").push({ number: poNo(), supplierId: supplierId || null, supplierName: s ? s.name : "", lines: lines, total: total, status: status, expected: expected || "", notes: (notes || "").trim(), createdAt: Date.now(), createdBy: ME.email || ME.uid });
      await writeAudit("po.create", { supplier: s ? s.name : "", lines: lines.length, total: total });
    } catch (e) { toast("Could not save purchase order", true); throw e; }
  }
  async function ivPoAuto() {
    var need = ING.filter(function (x) { return ivStatus(x) !== "ok" && x.supplierId; });
    if (!need.length) { toast("No low-stock items with a supplier assigned"); return; }
    var groups = {}; need.forEach(function (x) { (groups[x.supplierId] = groups[x.supplierId] || []).push(x); });
    if (!confirm("Create " + Object.keys(groups).length + " draft purchase order(s) for " + need.length + " low item(s)?")) return;
    try {
      for (var sid in groups) {
        await ivPoSave(sid, groups[sid].map(function (x) { return { id: x.id, name: x.name, unit: x.unit || "", qty: Math.max(1, Math.ceil(((Number(x.reorderLevel) || 0) * 2 - (Number(x.quantity) || 0)) * 100) / 100), cost: Number(x.unitCost) || 0 }; }), "draft", "", "Auto-drafted from low stock");
      }
      toast("Draft orders created"); ivRender();
    } catch (e) { }
  }
  async function ivPoStatus(id, status, label) {
    var p = PO.find(function (x) { return x.id === id; }); if (!p) return;
    if (status === "cancelled" && !confirm("Cancel " + p.number + "?")) return;
    try {
      if (status === "received") {
        if (!confirm("Receive " + p.number + " and add " + (p.lines || []).length + " item(s) to stock?")) return;
        for (var i = 0; i < (p.lines || []).length; i++) {
          var l = p.lines[i]; if (!ING.find(function (y) { return y.id === l.id; })) continue;
          await ivMove(l.id, l.qty, "restock", l.qty * (l.cost || 0), p.number + (p.supplierName ? " · " + p.supplierName : ""));
          if (l.cost) await db.ref("ingredients/" + l.id + "/unitCost").set(l.cost);
        }
        await db.ref("purchaseOrders/" + id).update({ status: "received", receivedAt: Date.now() });
      } else await db.ref("purchaseOrders/" + id).update({ status: status, updatedAt: Date.now() });
      await writeAudit("po." + status, { number: p.number });
      toast(label); await ivLoad(); ivRender();
    } catch (e) { toast("Could not update order", true); }
  }
  async function ivPoShow(id) {
    var p = PO.find(function (x) { return x.id === id; }); if (!p) return;
    var s = SUP.find(function (y) { return y.id === p.supplierId; });
    var body = "<p><strong>" + esc(p.number) + "</strong> — " + esc(p.status) + "<br>Supplier: " + esc(p.supplierName || "—") + (s && (s.phone || s.email) ? " (" + esc([s.phone, s.email].filter(Boolean).join(" · ")) + ")" : "") + "<br>Created: " + fmtDT(p.createdAt) + (p.expected ? "<br>Expected: " + esc(p.expected) : "") + "</p><table><tr><th>Item</th><th>Qty</th><th>Cost</th><th>Line</th></tr>" +
      (p.lines || []).map(function (l) { return "<tr><td>" + esc(l.name) + "</td><td>" + l.qty + " " + esc(l.unit) + "</td><td>" + peso2(l.cost) + "</td><td>" + peso2(l.qty * l.cost) + "</td></tr>"; }).join("") + "</table><h3>Total: " + peso2(p.total) + "</h3>" + (p.notes ? "<p>" + esc(p.notes) + "</p>" : "");
    var r = await dialog("Purchase order", [{ type: "html", html: '<div style="font-size:13px">' + body + "</div>" }], "Close", [{ act: "print", label: "Print" }]);
    if (r && r.__action === "print") printHtml(p.number, body);
  }

  /* ═════════ STOCKTAKE ═════════ */
  function ivStocktakeView() {
    var b = $("#ivBody");
    var list = ING.slice().sort(function (a, c) { return String(a.name).localeCompare(String(c.name)); });
    b.innerHTML = '<div class="section-head"><p class="view-lead" style="margin:0">Enter what you physically counted. Only changed rows are adjusted and logged as “Stocktake”.</p><button type="button" class="btn btn-primary" data-iv="ct-apply">Apply counts</button></div>' +
      (list.length ? '<div class="table-wrap"><table class="admin-table"><thead><tr><th>Item</th><th>System qty</th><th>Counted</th><th>Variance</th></tr></thead><tbody>' + list.map(function (x) {
        return "<tr><td><strong>" + esc(x.name) + '</strong></td><td>' + (Number(x.quantity) || 0) + " " + esc(x.unit || "") + '</td><td><input class="admin-input" style="max-width:110px" type="number" min="0" step="0.01" data-ct="' + esc(x.id) + '" data-sys="' + (Number(x.quantity) || 0) + '" value="' + (Number(x.quantity) || 0) + '"></td><td class="admin-sub" data-ctv="' + esc(x.id) + '">0</td></tr>';
      }).join("") + "</tbody></table></div>" : '<p class="muted admin-empty">No items to count.</p>');
    b.oninput = function (e) {
      var id = e.target.getAttribute && e.target.getAttribute("data-ct"); if (!id) return;
      var d = (Number(e.target.value) || 0) - Number(e.target.getAttribute("data-sys"));
      var c = b.querySelector('[data-ctv="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]'); if (c) { c.textContent = (d > 0 ? "+" : "") + Math.round(d * 100) / 100; c.style.color = d < 0 ? "var(--danger)" : ""; }
    };
  }
  async function ivStocktakeApply() {
    var inputs = Array.prototype.slice.call(document.querySelectorAll("[data-ct]")).filter(function (i) { return (Number(i.value) || 0) !== Number(i.getAttribute("data-sys")); });
    if (!inputs.length) { toast("No differences to apply"); return; }
    if (!confirm("Apply " + inputs.length + " count adjustment(s)?")) return;
    var lossVal = 0;
    try {
      for (var k = 0; k < inputs.length; k++) {
        var id = inputs[k].getAttribute("data-ct"), x = ING.find(function (y) { return y.id === id; }); if (!x) continue;
        var diff = Math.max(0, Number(inputs[k].value) || 0) - Number(inputs[k].getAttribute("data-sys"));
        await ivMove(id, diff, "adjustment", Math.abs(diff) * (Number(x.unitCost) || 0), "Stocktake");
        if (diff < 0) lossVal += -diff * (Number(x.unitCost) || 0);
      }
      toast("Stocktake applied" + (lossVal ? " — shrinkage " + peso2(lossVal) : "")); await ivLoad(); ivRender();
    } catch (e) { toast("Could not apply counts", true); }
  }

  /* ═════════ POS EXTRAS: discount, customer, note, cash change, hold ═════════ */
  var posHeld = [];
  var px = function (k) { return document.querySelector('[data-px="' + k + '"]'); };
  function ensurePosExtras() {
    var rc = document.querySelector(".pos-receipt"); if (!rc || $("#posExtras")) return;
    var sel = $("#posPayMethod"); if (!sel) return;
    var d = document.createElement("div"); d.id = "posExtras";
    d.innerHTML = '<input class="admin-input" data-px="cust" placeholder="Customer name (optional)" style="width:100%;margin-bottom:8px">' +
      '<div style="display:flex;gap:6px;margin-bottom:8px"><select class="admin-input" data-px="dtype" style="width:92px"><option value="amt">₱ off</option><option value="pct">% off</option></select><input class="admin-input" data-px="dval" type="number" min="0" step="0.01" placeholder="Discount" style="flex:1"></div>' +
      '<input class="admin-input" data-px="note" placeholder="Order note (optional)" style="width:100%;margin-bottom:8px">' +
      '<div id="posCashBox" style="margin-bottom:8px"><input class="admin-input" data-px="tender" type="number" min="0" step="0.01" placeholder="Cash received" style="width:100%"><div class="admin-sub" id="posChange" style="margin-top:4px"></div></div>' +
      '<button type="button" class="btn btn-ghost block" data-act="pos-hold" style="margin-bottom:8px">Hold sale</button><div id="posHeld"></div>';
    sel.parentNode.insertBefore(d, sel);
    var tot = rc.querySelector(".pos-totals"), tr = tot && tot.querySelector(".row.total");
    if (tr) { var dr = document.createElement("div"); dr.className = "row muted"; dr.id = "posDiscRow"; dr.innerHTML = "<span>Discount</span><span id=\"posDisc\">−₱0</span>"; tot.insertBefore(dr, tr); }
  }
  function posTotals() {
    var b = cartVatBreakdown(posCart), g = b.totalInclusive;
    var t = (px("dtype") || {}).value, v = Number((px("dval") || {}).value) || 0;
    var disc = roundMoney(Math.max(0, t === "pct" ? g * Math.min(v, 100) / 100 : Math.min(v, g)));
    var net = roundMoney(g - disc), f = g ? net / g : 1, vat = roundMoney(b.vatAmount * f);
    return { gross: g, disc: disc, net: net, vat: vat, vatable: roundMoney(net - vat), dtype: t || "amt", dval: v };
  }
  function renderPosReceipt() {
    var el = $("#posItems"); if (!el) return;
    ensurePosExtras(); ensureRecipesListener();
    el.innerHTML = posCart.length ? posCart.map(function (it) {
      return '<div class="pos-receipt-item"><span>' + esc(it.name) + ' × ' + it.qty + '</span><span>' + peso(it.price * it.qty) +
        ' <button type="button" data-act="pos-minus" data-id="' + esc(it.id) + '">−</button><button type="button" data-act="pos-plus" data-id="' + esc(it.id) + '">+</button><button type="button" data-act="pos-remove" data-id="' + esc(it.id) + '">✕</button></span></div>';
    }).join("") : '<p class="muted">Tap a product to add it.</p>';
    var t = posTotals();
    setText("posSubtotal", peso2(t.vatable)); setText("posTax", peso2(t.vat)); setText("posTotal", peso2(t.net)); setText("posDisc", "−" + peso2(t.disc));
    var pm = ($("#posPayMethod") || {}).value, cb = $("#posCashBox"); if (cb) cb.style.display = pm === "Cash" ? "" : "none";
    var tend = Number((px("tender") || {}).value) || 0, ch = $("#posChange");
    if (ch) ch.textContent = pm === "Cash" && tend ? (tend >= t.net ? "Change: " + peso2(tend - t.net) : "Short by " + peso2(t.net - tend)) : "";
    var h = $("#posHeld"); if (h) h.innerHTML = posHeld.map(function (x, i) { return '<button type="button" class="btn btn-ghost block" data-act="pos-resume" data-i="' + i + '" style="margin-bottom:6px">Resume: ' + esc(x.cust || "Sale") + " · " + x.cart.length + " item(s)</button>"; }).join("");
  }
  var posBusy = false;
  async function posCharge() {
    if (posBusy) return;
    if (!posCart.length) { toast("Add an item first", true); return; }
    var pay = ($("#posPayMethod") || {}).value || "Cash", t = posTotals();
    var tender = Number((px("tender") || {}).value) || 0;
    if (pay === "Cash" && tender && tender < t.net) { toast("Cash received is less than the total", true); return; }
    posBusy = true;
    var taken = [];
    try {
      for (var i = 0; i < posCart.length; i++) {
        var it = posCart[i];
        var res = await db.ref("mb_products/" + it.id + "/stock").transaction(function (cur) {
          cur = Number(cur) || 0;
          return cur < it.qty ? undefined : cur - it.qty;
        }, undefined, false);
        if (!res.committed) throw new Error("Not enough stock for " + it.name);
        taken.push(it);
      }
      var items = posCart.map(function (x) { return { id: x.id, name: x.name, price: x.price, qty: x.qty }; });
      var ref = db.ref("orders").push();
      var order = {
        items: items, total: t.net, subtotal: t.vatable,
        vat: { vatableSales: t.vatable, vatAmount: t.vat, vatRate: PH_VAT_STANDARD },
        discount: { type: t.dtype, value: t.dval, amount: t.disc },
        payMethod: pay, source: "POS", status: "fulfilled", createdAt: Date.now(),
        user: ME.uid, email: ME.email || "", cashier: PROFILE.username || ME.email || "",
        shipping: { name: ((px("cust") || {}).value || "").trim() || "Walk-in customer" },
        note: ((px("note") || {}).value || "").trim()
      };
      if (pay === "Cash" && tender) { order.tendered = tender; order.change = roundMoney(tender - t.net); }
      await ref.set(order);
      await writeAudit("pos.sale", { orderId: ref.key, total: order.total, payMethod: pay, discount: t.disc });
      mirrorToPhp();
      deductRecipes(items, ref.key);
      posCart = []; ["cust", "dval", "note", "tender"].forEach(function (k) { if (px(k)) px(k).value = ""; });
      renderPosReceipt(); renderPosGrid();
      toast("Sale completed — " + peso2(order.total));
      showPosReceiptModal(ref.key, order);
    } catch (e) {
      for (var j = 0; j < taken.length; j++) {
        (function (tk) { db.ref("mb_products/" + tk.id + "/stock").transaction(function (c) { return (Number(c) || 0) + tk.qty; }, undefined, false).catch(function () {}); })(taken[j]);
      }
      toast(e && e.message && e.message.indexOf("Not enough") === 0 ? e.message : "Sale failed — check Firebase rules", true);
    } finally { posBusy = false; }
  }
  var lastReceiptHtml = "";
  function showPosReceiptModal(id, o) {
    closePosReceiptModal();
    var row = function (a, b, c) { return '<div class="pos-thermal-line' + (c ? " pos-thermal-total" : "") + '"><span>' + a + "</span><span>" + b + "</span></div>"; };
    lastReceiptHtml = '<div class="pos-thermal-receipt"><header><h3>Maple\'s Bean</h3><p>Order ' + esc(id.slice(-8).toUpperCase()) + '<br>' + esc(new Date(o.createdAt).toLocaleString("en-PH")) + (o.shipping && o.shipping.name !== "Walk-in customer" ? "<br>" + esc(o.shipping.name) : "") + '</p></header><hr>' +
      o.items.map(function (i) { return '<div class="pos-thermal-line"><span>' + esc(i.name) + '<small>' + i.qty + ' × ' + peso2(i.price) + '</small></span><strong>' + peso2(i.price * i.qty) + '</strong></div>'; }).join("") + "<hr>" +
      (o.discount && o.discount.amount ? row("Discount", "−" + peso2(o.discount.amount)) : "") +
      row("VATable sales", peso2(o.vat.vatableSales)) + row("VAT 12%", peso2(o.vat.vatAmount)) + row("TOTAL", peso2(o.total), true) + row("Payment", esc(o.payMethod)) +
      (o.tendered ? row("Cash", peso2(o.tendered)) + row("Change", peso2(o.change)) : "") + (o.note ? "<hr><p>Note: " + esc(o.note) + "</p>" : "") + '<hr><p class="pos-thermal-thanks">Thank you!</p></div>';
    var m = document.createElement("div");
    m.id = "posReceiptModal"; m.className = "pos-receipt-modal";
    m.innerHTML = '<div class="pos-receipt-dialog"><div class="pos-receipt-modal-head"><div><h2>Sale complete</h2><p>Receipt</p></div><button type="button" data-act="pos-receipt-close">×</button></div>' + lastReceiptHtml +
      '<div class="pos-receipt-actions"><button type="button" class="btn btn-ghost" data-act="pos-receipt-print">Print</button><button type="button" class="btn btn-primary" data-act="pos-receipt-close">Done</button></div></div>';
    document.body.appendChild(m);
  }
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-act]"); if (!t) return; var a = t.getAttribute("data-act");
    if (a === "pos-hold") {
      if (!posCart.length) { toast("Nothing to hold", true); return; }
      posHeld.push({ cart: posCart, cust: (px("cust") || {}).value || "", note: (px("note") || {}).value || "" });
      posCart = []; ["cust", "dval", "note", "tender"].forEach(function (k) { if (px(k)) px(k).value = ""; }); renderPosReceipt(); toast("Sale held");
    } else if (a === "pos-resume") {
      if (posCart.length) { toast("Hold or clear the current sale first", true); return; }
      var h = posHeld.splice(Number(t.getAttribute("data-i")), 1)[0]; if (!h) return;
      posCart = h.cart; if (px("cust")) px("cust").value = h.cust; if (px("note")) px("note").value = h.note; renderPosReceipt();
    }
  });
  document.addEventListener("input", function (e) { if (e.target.getAttribute && e.target.getAttribute("data-px")) renderPosReceipt(); });
  document.addEventListener("change", function (e) { if (e.target.id === "posPayMethod" || (e.target.getAttribute && e.target.getAttribute("data-px"))) renderPosReceipt(); });

  /* ═════════ END-OF-DAY REPORT ═════════ */
  async function slEod(dateStr) {
    dateStr = dateStr || new Date().toLocaleDateString("en-CA");
    var s = new Date(dateStr + "T00:00:00").getTime(), en = s + 864e5;
    var val = (await db.ref("orders").once("value")).val() || {};
    var day = Object.values(val).filter(function (o) { return (o.createdAt || 0) >= s && (o.createdAt || 0) < en; });
    var good = day.filter(slIsValid), ref = day.filter(function (o) { return o.status === "refunded"; });
    var sum = function (a, f) { return a.reduce(function (t, o) { return t + (Number(f(o)) || 0); }, 0); };
    var gross = sum(good, function (o) { return o.total; }), vat = sum(good, slVat), disc = sum(good, function (o) { return o.discount && o.discount.amount; }), refAmt = sum(ref, function (o) { return o.total; });
    var pay = {}, cash = {}; good.forEach(function (o) { var k = o.payMethod || "Cash"; pay[k] = (pay[k] || 0) + (Number(o.total) || 0); var c = o.cashier || (o.source === "POS" ? "POS" : "Online"); cash[c] = (cash[c] || 0) + (Number(o.total) || 0); });
    var cashSales = good.filter(function (o) { return (o.payMethod || "Cash") === "Cash" && o.source === "POS"; }).reduce(function (t, o) { return t + (Number(o.total) || 0); }, 0);
    var line = function (a, b) { return '<div class="pos-receipt-item"><span>' + a + "</span><strong>" + b + "</strong></div>"; };
    var summary = "<h3>" + esc(dateStr) + "</h3>" + line("Completed sales", good.length) + line("Gross sales", peso2(gross)) + line("VAT included", peso2(vat)) + line("Discounts given", peso2(disc)) + line("Refunds (" + ref.length + ")", peso2(refAmt)) +
      "<h3>By payment</h3>" + (Object.keys(pay).map(function (k) { return line(esc(k), peso2(pay[k])); }).join("") || "<p>—</p>") + "<h3>By cashier / channel</h3>" + (Object.keys(cash).map(function (k) { return line(esc(k), peso2(cash[k])); }).join("") || "<p>—</p>") + "<h3>POS cash sales</h3>" + line("Cash sales", peso2(cashSales));
    var r = await dialog("End-of-day report", [
      { id: "date", label: "Date", type: "date", value: dateStr },
      { type: "html", html: '<div style="font-size:13px;margin-bottom:10px">' + summary + "</div>" },
      { id: "float", label: "Opening cash float (₱)", type: "number", step: "0.01", min: 0, value: 0 },
      { id: "counted", label: "Cash counted in drawer (₱)", type: "number", step: "0.01", min: 0 },
      { id: "note", label: "Note", type: "textarea", rows: 2 }
    ], "Save closing", [{ act: "load", label: "Load date" }, { act: "print", label: "Print" }]);
    if (!r) return;
    if (r.__action === "load") return slEod(r.date || dateStr);
    var fl = Number(r.float) || 0, expected = fl + cashSales, counted = r.counted === "" ? null : Number(r.counted);
    if (r.__action === "print") { printHtml("End-of-day report", summary + "<h3>Cash drawer</h3>" + line("Opening float", peso2(fl)) + line("Expected cash", peso2(expected)) + (counted != null ? line("Counted", peso2(counted)) + line("Variance", peso2(counted - expected)) : "")); return; }
    try {
      await db.ref("cashSessions").push({ date: r.date || dateStr, float: fl, cashSales: cashSales, expected: expected, counted: counted, variance: counted == null ? null : counted - expected, gross: gross, refunds: refAmt, discounts: disc, transactions: good.length, note: (r.note || "").trim(), by: ME.email || ME.uid, at: Date.now() });
      await writeAudit("eod.closed", { date: r.date || dateStr, gross: gross, variance: counted == null ? null : counted - expected });
      toast(counted == null ? "Closing saved" : "Closing saved — variance " + peso2(counted - expected));
    } catch (e) { toast("Could not save closing (publish the updated rules)", true); }
  }
  document.addEventListener("click", function (e) { var t = e.target.closest("[data-sl-act=eod]"); if (t) slEod(); });

  /* ═════════ SUPER ADMIN EXTRA OPTIONS ═════════
     Customers · Reviews · Online Now · Cash Sessions · Purchase Orders · Data Export
     Injected only on superadmin.html, so no HTML change is needed. */
  (function () {
    if (PAGE !== "superadmin") return;
    var X = [
      ["customers", "Customers", "Customers"],
      ["reviews", "Review Moderation", "Reviews"],
      ["online", "Online Now", "Online Now"],
      ["cashsess", "Cash Sessions", "Cash Sessions"],
      ["pos-orders", "Purchase Orders", "Purchase Orders"],
      ["export", "Data Export", "Data Export"]
    ];
    var nav = $(".dash-nav"), main = $(".dash-main");
    if (!nav || !main) return;
    X.forEach(function (x) {
      TITLES[x[0]] = x[1];
      var b = document.createElement("button"); b.type = "button"; b.setAttribute("data-view", x[0]); b.textContent = x[2]; nav.appendChild(b);
      var s = document.createElement("section"); s.className = "view"; s.id = "view-" + x[0]; s.hidden = true; main.appendChild(s);
    });
    var tbl = function (head, rows, empty) {
      return rows.length ? '<div class="table-wrap"><table class="admin-table"><thead><tr>' + head.map(function (h) { return "<th>" + h + "</th>"; }).join("") + "</tr></thead><tbody>" + rows.join("") + "</tbody></table></div>" : '<p class="muted admin-empty">' + empty + "</p>";
    };
    var td = function () { return "<tr>" + Array.prototype.map.call(arguments, function (c) { return "<td>" + c + "</td>"; }).join("") + "</tr>"; };
    var fail = function (id, m) { var e = document.getElementById(id); if (e) e.innerHTML = '<p class="muted admin-empty">' + m + " Check Firebase rules.</p>"; };
    var stat = function (v, l, c) { return '<div class="stat-card ' + (c || "") + '"><span class="stat-val">' + v + '</span><span class="stat-label">' + l + "</span></div>"; };
    var CU = [];

    /* Customers (users + orders) */
    LOADERS.customers = async function () {
      var el = $("#view-customers");
      try {
        var r = await Promise.all([db.ref("users").once("value"), db.ref("orders").once("value")]);
        var users = r[0].val() || {}, orders = Object.values(r[1].val() || {});
        CU = Object.entries(users).map(function (e) {
          var u = e[1], mine = orders.filter(function (o) { return o.user === e[0] && ["cancelled", "refunded"].indexOf(o.status) === -1; });
          return { id: e[0], name: u.username || u.displayName || "", email: u.email || "", role: u.role || "customer", orders: mine.length, spent: mine.reduce(function (s, o) { return s + (Number(o.total) || 0); }, 0), last: mine.reduce(function (m, o) { return Math.max(m, o.createdAt || 0); }, 0) };
        }).sort(function (a, b) { return b.spent - a.spent; });
        var buyers = CU.filter(function (c) { return c.orders > 0; });
        el.innerHTML = '<div class="stats-grid">' + stat(CU.length, "Accounts") + stat(buyers.length, "Have ordered") + stat(buyers.filter(function (c) { return c.orders > 1; }).length, "Repeat customers") +
          stat(peso(buyers.length ? Math.round(buyers.reduce(function (s, c) { return s + c.spent; }, 0) / buyers.length) : 0), "Avg. spend / buyer") + '</div>' +
          '<div class="section-head"><input id="cuSearch" class="search" placeholder="Search customers…" style="max-width:300px"><button class="btn btn-ghost" data-xa="cu-csv">Export CSV</button></div><div id="cuList"></div>';
        cuRender();
      } catch (e) { fail("view-customers", "Could not load customers."); }
    };
    function cuRender() {
      var q = (($("#cuSearch") || {}).value || "").toLowerCase(), l = $("#cuList"); if (!l) return;
      l.innerHTML = tbl(["Customer", "Role", "Orders", "Total spent", "Last order"], CU.filter(function (c) { return (c.name + c.email).toLowerCase().indexOf(q) !== -1; }).slice(0, 300).map(function (c) {
        return td("<strong>" + esc(c.name || "—") + '</strong><div class="admin-sub">' + esc(c.email) + "</div>", esc(c.role), c.orders, peso(c.spent), c.last ? fmtDate(c.last) : "—");
      }), "No customers found.");
    }

    /* Review moderation */
    var RV = [];
    LOADERS.reviews = async function () {
      var el = $("#view-reviews");
      try {
        var val = (await db.ref("reviews").once("value")).val() || {}; RV = [];
        Object.keys(val).forEach(function (pid) { Object.keys(val[pid] || {}).forEach(function (rid) { var r = val[pid][rid]; if (r && typeof r === "object") RV.push(Object.assign({ pid: pid, rid: rid }, r)); }); });
        RV.sort(function (a, b) { return (b.createdAt || b.date || 0) - (a.createdAt || a.date || 0); });
        var avg = RV.length ? (RV.reduce(function (s, r) { return s + (Number(r.rating) || 0); }, 0) / RV.length).toFixed(1) : "0.0";
        el.innerHTML = '<div class="stats-grid">' + stat(RV.length, "Total reviews") + stat(avg + " ★", "Average rating") + stat(RV.filter(function (r) { return Number(r.rating) <= 2; }).length, "1–2 star", "warn") + "</div>" +
          tbl(["Product", "Reviewer", "Rating", "Review", "Date", ""], RV.slice(0, 300).map(function (r) {
            var p = PRODUCTS.find(function (x) { return x.id === r.pid; });
            return td(esc(p ? p.name : r.pid), esc(r.name || r.username || r.email || r.user || "Anonymous"), "★".repeat(Math.max(0, Math.min(5, Number(r.rating) || 0))), esc(r.text || r.comment || ""), (r.createdAt || r.date) ? fmtDate(r.createdAt || r.date) : "—", '<button class="admin-link-btn" data-xa="rv-del" data-pid="' + esc(r.pid) + '" data-rid="' + esc(r.rid) + '">Delete</button>');
          }), "No reviews yet.");
      } catch (e) { fail("view-reviews", "Could not load reviews."); }
    };
    async function rvDelete(pid, rid) {
      if (!confirm("Delete this review?")) return;
      try {
        await db.ref("reviews/" + pid + "/" + rid).remove();
        var all = Object.values((await db.ref("reviews/" + pid).once("value")).val() || {});
        await db.ref("mb_products/" + pid).update({ avgRating: all.length ? Math.round(all.reduce(function (s, r) { return s + (Number(r.rating) || 0); }, 0) / all.length * 10) / 10 : 0, reviewCount: all.length });
        await writeAudit("review.delete", { productId: pid, reviewId: rid }); toast("Review deleted"); LOADERS.reviews();
      } catch (e) { toast("Could not delete review", true); }
    }

    /* Online now (presence) */
    LOADERS.online = async function () {
      try {
        var val = (await db.ref("presence").once("value")).val() || {};
        var rows = Object.entries(val).sort(function (a, b) { return (b[1].online ? 1 : 0) - (a[1].online ? 1 : 0) || (b[1].lastSeen || 0) - (a[1].lastSeen || 0); });
        $("#view-online").innerHTML = '<div class="stats-grid">' + stat(rows.filter(function (e) { return e[1].online; }).length, "Online now") + stat(rows.length, "Seen ever") + "</div>" +
          tbl(["User", "Status", "Last seen"], rows.slice(0, 200).map(function (e) { return td(esc(e[1].email || e[0]), e[1].online ? '<span class="role-pill staff">online</span>' : '<span class="muted">offline</span>', fmtDT(e[1].lastSeen)); }), "No presence data yet.");
      } catch (e) { fail("view-online", "Could not load presence."); }
    };

    /* Cash sessions (end-of-day closings) */
    LOADERS.cashsess = async function () {
      try {
        var rows = Object.values((await db.ref("cashSessions").limitToLast(200).once("value")).val() || {}).sort(function (a, b) { return String(b.date || "").localeCompare(String(a.date || "")); });
        var vt = rows.reduce(function (s, r) { return s + (Number(r.variance) || 0); }, 0);
        $("#view-cashsess").innerHTML = '<div class="stats-grid">' + stat(rows.length, "Closings") + stat(peso(vt), "Net variance", vt < 0 ? "bad" : "") + "</div>" +
          tbl(["Date", "Float", "Cash sales", "Expected", "Counted", "Variance", "Note"], rows.map(function (r) {
            return td(esc(r.date || "—"), peso(r.float), peso(r.cashSales), peso(r.expected), r.counted == null ? "—" : peso(r.counted), r.variance == null ? "—" : '<span style="color:' + (r.variance < 0 ? "var(--danger)" : "inherit") + '">' + peso(r.variance) + "</span>", esc(r.note || ""));
          }), "No end-of-day closings saved yet.");
      } catch (e) { fail("view-cashsess", "Could not load cash sessions."); }
    };

    /* Purchase orders overview */
    LOADERS["pos-orders"] = async function () {
      try {
        var rows = Object.entries((await db.ref("purchaseOrders").once("value")).val() || {}).sort(function (a, b) { return (b[1].createdAt || 0) - (a[1].createdAt || 0); });
        var open = rows.filter(function (e) { return ["received", "cancelled"].indexOf(e[1].status) === -1; });
        $("#view-pos-orders").innerHTML = '<div class="stats-grid">' + stat(rows.length, "Total POs") + stat(open.length, "Open", "warn") + stat(peso(open.reduce(function (s, e) { return s + (Number(e[1].total) || 0); }, 0)), "Open value") + "</div>" +
          tbl(["PO #", "Supplier", "Lines", "Total", "Status", "Created"], rows.slice(0, 200).map(function (e) { var p = e[1]; return td(esc(p.number || e[0]), esc(p.supplierName || "—"), (p.lines || []).length, peso(p.total), esc(p.status || "draft"), fmtDate(p.createdAt)); }), "No purchase orders yet.");
      } catch (e) { fail("view-pos-orders", "Could not load purchase orders."); }
    };

    /* Data export (JSON / CSV) */
    var EXP = [["orders", "Orders"], ["users", "Users"], ["mb_products", "Products"], ["ingredients", "Ingredients"], ["suppliers", "Suppliers"], ["purchaseOrders", "Purchase orders"], ["reviews", "Reviews"], ["auditTrail", "Audit trail"]];
    LOADERS.export = function () {
      $("#view-export").innerHTML = '<p class="view-lead">Download a snapshot of any collection straight from Firebase. Exports are recorded in the audit trail.</p><div class="stats-grid">' +
        EXP.map(function (x) { return '<div class="stat-card"><span class="stat-val" style="font-size:18px">' + x[1] + '</span><button class="btn btn-ghost" style="margin-top:10px" data-xa="exp" data-path="' + x[0] + '">Download JSON</button></div>'; }).join("") + "</div>";
    };
    async function doExport(path) {
      try {
        var val = (await db.ref(path).once("value")).val() || {};
        if (path === "users") Object.keys(val).forEach(function (k) { delete val[k].password; });
        var a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(val, null, 2)], { type: "application/json" }));
        a.download = path + "-" + new Date().toISOString().slice(0, 10) + ".json"; document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
        writeAudit("data.export", { path: path }); toast("Exported " + path);
      } catch (e) { toast("Could not export " + path, true); }
    }

    document.addEventListener("click", function (e) {
      var t = e.target.closest("[data-xa]"); if (!t) return;
      var a = t.getAttribute("data-xa");
      if (a === "rv-del") rvDelete(t.getAttribute("data-pid"), t.getAttribute("data-rid"));
      else if (a === "exp") doExport(t.getAttribute("data-path"));
      else if (a === "cu-csv") csvDownload("customers-" + new Date().toISOString().slice(0, 10) + ".csv", [["Name", "Email", "Role", "Orders", "Total spent", "Last order"]].concat(CU.map(function (c) { return [c.name, c.email, c.role, c.orders, c.spent.toFixed(2), c.last ? new Date(c.last).toISOString().slice(0, 10) : ""]; })));
    });
    document.addEventListener("input", function (e) { if (e.target.id === "cuSearch") cuRender(); });
  })();

  /* ═════════ SUPER ADMIN: WALK-IN OPTIONS ═════════
     Walk-in Overview · Walk-in Orders · Walk-in Regulars (all POS sales) */
  (function () {
    if (PAGE !== "superadmin") return;
    var V = [["walkins", "Walk-in Overview", "Walk-in Overview"], ["walkin-orders", "Walk-in Orders", "Walk-in Orders"], ["walkin-regulars", "Walk-in Regulars", "Walk-in Regulars"]];
    var nav = $(".dash-nav"), main = $(".dash-main"); if (!nav || !main) return;
    V.forEach(function (x) {
      TITLES[x[0]] = x[1];
      var b = document.createElement("button"); b.type = "button"; b.setAttribute("data-view", x[0]); b.textContent = x[2]; nav.appendChild(b);
      var s = document.createElement("section"); s.className = "view"; s.id = "view-" + x[0]; s.hidden = true; main.appendChild(s);
    });
    var WI = { range: "today", q: "", pay: "all" }, ROWS = [];
    var DEF = "walk-in customer";
    var stat = function (v, l, c) { return '<div class="stat-card ' + (c || "") + '"><span class="stat-val">' + v + '</span><span class="stat-label">' + l + "</span></div>"; };
    var ok = function (o) { return ["cancelled", "refunded"].indexOf(o.status) === -1; };
    var nm = function (o) { return ((o.shipping && o.shipping.name) || "").trim() || "Walk-in customer"; };
    var named = function (o) { return nm(o).toLowerCase() !== DEF; };
    var td = function () { return "<tr>" + Array.prototype.map.call(arguments, function (c) { return "<td>" + c + "</td>"; }).join("") + "</tr>"; };
    var tbl = function (h, r, e) { return r.length ? '<div class="table-wrap"><table class="admin-table"><thead><tr>' + h.map(function (x) { return "<th>" + x + "</th>"; }).join("") + "</tr></thead><tbody>" + r.join("") + "</tbody></table></div>" : '<p class="muted admin-empty">' + e + "</p>"; };
    var sel = function (k, opts) { return '<select class="admin-select" data-wi="' + k + '">' + opts.map(function (o) { return '<option value="' + o[0] + '"' + (WI[k] === o[0] ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") + "</select>"; };
    var rangeSel = function () { return sel("range", [["today", "Today"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["all", "All time"]]); };
    function startOf() {
      if (WI.range === "all") return 0;
      var d = new Date(); d.setHours(0, 0, 0, 0);
      return WI.range === "today" ? d.getTime() : d.getTime() - (Number(WI.range) - 1) * 864e5;
    }
    async function fetchRows() {
      var val = (await db.ref("orders").once("value")).val() || {}, s = startOf();
      ROWS = Object.entries(val).filter(function (e) { return e[1].source === "POS" && (e[1].createdAt || 0) >= s; }).sort(function (a, b) { return (b[1].createdAt || 0) - (a[1].createdAt || 0); });
    }
    var fail = function (id) { var e = document.getElementById("view-" + id); if (e) e.innerHTML = '<p class="muted admin-empty">Could not load walk-in sales. Check Firebase rules.</p>'; };
    var group = function (rows, keyFn, valFn) { var m = {}; rows.forEach(function (e) { var k = keyFn(e[1]); m[k] = (m[k] || 0) + valFn(e[1]); }); return Object.keys(m).sort(function (a, b) { return m[b] - m[a]; }).map(function (k) { return [k, m[k]]; }); };
    var panel = function (t, pairs, money) { return '<div class="panel"><h3 class="section-title">' + t + "</h3>" + (pairs.length ? pairs.slice(0, 6).map(function (p) { return '<div class="pos-receipt-item"><span>' + esc(p[0]) + "</span><strong>" + (money === false ? p[1] : peso2(p[1])) + "</strong></div>"; }).join("") : '<p class="muted">—</p>') + "</div>"; };
    var peso2 = function (n) { return "₱" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    var dt = function (v) { return v ? new Date(Number(v)).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : "—"; };

    LOADERS.walkins = async function () {
      var el = $("#view-walkins");
      try {
        await fetchRows();
        var good = ROWS.filter(function (e) { return ok(e[1]); }), tot = function (o) { return Number(o.total) || 0; };
        var rev = good.reduce(function (s, e) { return s + tot(e[1]); }, 0);
        var disc = good.reduce(function (s, e) { return s + (Number(e[1].discount && e[1].discount.amount) || 0); }, 0);
        var discN = good.filter(function (e) { return Number(e[1].discount && e[1].discount.amount) > 0; }).length;
        var items = {}; good.forEach(function (e) { (e[1].items || []).forEach(function (i) { items[i.name || i.id] = (items[i.name || i.id] || 0) + (Number(i.qty) || 0); }); });
        var hrs = new Array(24).fill(0); good.forEach(function (e) { hrs[new Date(e[1].createdAt || 0).getHours()] += tot(e[1]); });
        var mx = Math.max.apply(null, hrs.concat([1])), peak = hrs.map(function (v, h) { return [h, v]; }).filter(function (x) { return x[1] > 0; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 3);
        el.innerHTML = '<div class="section-head"><p class="view-lead" style="margin:0">All sales rung up at the counter (Point of Sale).</p>' + rangeSel() + "</div>" +
          '<div class="stats-grid">' + stat(good.length, "Walk-in sales") + stat(peso(Math.round(rev)), "Walk-in revenue") + stat(peso(good.length ? Math.round(rev / good.length) : 0), "Avg. ticket") +
          stat(good.filter(named).length ? good.filter(function (e) { return named(e[1]); }).length : 0, "Named customers") + stat(discN + " · " + peso(Math.round(disc)), "Discounts given", "warn") +
          stat(ROWS.length - good.length, "Voided / refunded", "bad") + "</div>" +
          '<div class="grid-2" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px">' +
          panel("By cashier", group(good, function (o) { return o.cashier || "Unknown"; }, tot)) +
          panel("By payment method", group(good, function (o) { return o.payMethod || "Cash"; }, tot)) +
          panel("Top items (qty)", Object.keys(items).sort(function (a, b) { return items[b] - items[a]; }).map(function (k) { return [k, items[k]]; }), false) +
          '<div class="panel"><h3 class="section-title">Busiest hours</h3><div style="display:flex;align-items:flex-end;gap:2px;height:70px">' + hrs.map(function (v, h) { return '<div title="' + h + ":00 — " + peso2(v) + '" style="flex:1;background:var(--honey,#a9812f);opacity:.85;border-radius:2px 2px 0 0;height:' + Math.max(2, Math.round(v / mx * 100)) + '%"></div>'; }).join("") + '</div><div class="admin-sub">' + (peak.length ? "Peak: " + peak.map(function (x) { return x[0] + ":00"; }).join(", ") : "No sales") + "</div></div></div>";
      } catch (e) { fail("walkins"); }
    };

    LOADERS["walkin-orders"] = async function () {
      var el = $("#view-walkin-orders");
      try {
        await fetchRows();
        el.innerHTML = '<div class="section-head" style="gap:8px;flex-wrap:wrap"><input id="wiSearch" class="search" placeholder="Search customer, cashier, order #…" style="max-width:280px" value="' + esc(WI.q) + '"><div style="display:flex;gap:8px;flex-wrap:wrap">' + rangeSel() +
          sel("pay", [["all", "All payments"]].concat(Object.keys(ROWS.reduce(function (m, e) { m[e[1].payMethod || "Cash"] = 1; return m; }, {})).sort().map(function (p) { return [p, p]; }))) +
          '<button class="btn btn-ghost" data-wx="csv">Export CSV</button></div></div><div id="wiList"></div>';
        wiList();
      } catch (e) { fail("walkin-orders"); }
    };
    function wiFiltered() {
      var q = WI.q.toLowerCase();
      return ROWS.filter(function (e) { var o = e[1]; return (WI.pay === "all" || (o.payMethod || "Cash") === WI.pay) && (!q || (e[0] + nm(o) + (o.cashier || "") + (o.note || "")).toLowerCase().indexOf(q) !== -1); });
    }
    function wiList() {
      var l = $("#wiList"); if (!l) return;
      l.innerHTML = tbl(["Order", "Date", "Customer", "Cashier", "Items", "Discount", "Payment", "Total", "Status", ""], wiFiltered().slice(0, 300).map(function (e) {
        var o = e[1], d = Number(o.discount && o.discount.amount) || 0;
        return td(esc(e[0].slice(-6)), dt(o.createdAt), "<strong>" + esc(nm(o)) + "</strong>" + (o.note ? '<div class="admin-sub">' + esc(o.note) + "</div>" : ""), esc(o.cashier || "—"),
          (o.items || []).map(function (i) { return esc(i.name) + " ×" + esc(i.qty); }).join(", "), d ? "−" + peso2(d) : "—", esc(o.payMethod || "Cash"), peso2(o.total), esc(o.status || "fulfilled"),
          ok(o) ? '<button class="admin-link-btn" data-wx="refund" data-id="' + esc(e[0]) + '">Void / refund</button>' : "");
      }), "No walk-in sales for this filter.");
    }
    async function wiRefund(id) {
      var e = ROWS.find(function (r) { return r[0] === id; }); if (!e) return; var o = e[1];
      if (!confirm("Void this walk-in sale (" + peso2(o.total) + ") and return the items to stock?")) return;
      try {
        await db.ref("orders/" + id).update({ status: "refunded", refundStatus: "refunded", refund: { amount: Number(o.total) || 0, at: Date.now(), by: ME.email || ME.uid }, updatedAt: Date.now() });
        (o.items || []).forEach(function (it) { if (it.id) db.ref("mb_products/" + it.id + "/stock").transaction(function (c) { return (Number(c) || 0) + (Number(it.qty) || 0); }, undefined, false).catch(function () {}); });
        await writeAudit("order.refunded", { orderId: id, total: o.total, source: "walk-in" });
        mirrorToPhp(); toast("Sale voided, stock restored"); LOADERS["walkin-orders"]();
      } catch (err) { toast("Could not void sale", true); }
    }

    LOADERS["walkin-regulars"] = async function () {
      var el = $("#view-walkin-regulars");
      try {
        await fetchRows();
        var m = {}; ROWS.filter(function (e) { return ok(e[1]) && named(e[1]); }).forEach(function (e) {
          var o = e[1], k = nm(o).toLowerCase(), r = m[k] = m[k] || { name: nm(o), visits: 0, spent: 0, last: 0 };
          r.visits++; r.spent += Number(o.total) || 0; r.last = Math.max(r.last, o.createdAt || 0);
        });
        var list = Object.values(m).sort(function (a, b) { return b.visits - a.visits || b.spent - a.spent; });
        el.innerHTML = '<div class="section-head"><p class="view-lead" style="margin:0">Customers whose name was entered at the counter. Unnamed sales show as “Walk-in customer” and are not listed.</p>' + rangeSel() + "</div>" +
          '<div class="stats-grid">' + stat(list.length, "Named walk-ins") + stat(list.filter(function (r) { return r.visits > 1; }).length, "Came back") + "</div>" +
          tbl(["Customer", "Visits", "Total spent", "Last visit"], list.slice(0, 200).map(function (r) { return td("<strong>" + esc(r.name) + "</strong>", r.visits, peso2(r.spent), dt(r.last)); }), "No named walk-in customers in this period.");
      } catch (e) { fail("walkin-regulars"); }
    };

    document.addEventListener("change", function (e) {
      var k = e.target.getAttribute && e.target.getAttribute("data-wi"); if (!k) return;
      WI[k] = e.target.value; var v = (location.hash || "").slice(1); if (LOADERS[v]) LOADERS[v]();
    });
    document.addEventListener("input", function (e) { if (e.target.id === "wiSearch") { WI.q = e.target.value; wiList(); } });
    document.addEventListener("click", function (e) {
      var t = e.target.closest("[data-wx]"); if (!t) return;
      if (t.getAttribute("data-wx") === "refund") wiRefund(t.getAttribute("data-id"));
      else if (t.getAttribute("data-wx") === "csv") csvDownload("walkin-sales-" + new Date().toISOString().slice(0, 10) + ".csv", [["Order", "Date", "Customer", "Cashier", "Items", "Discount", "Payment", "Status", "Total"]].concat(wiFiltered().map(function (e) {
        var o = e[1]; return [e[0], dt(o.createdAt), nm(o), o.cashier || "", (o.items || []).map(function (i) { return i.name + " x" + i.qty; }).join("; "), Number(o.discount && o.discount.amount || 0).toFixed(2), o.payMethod || "Cash", o.status || "fulfilled", Number(o.total || 0).toFixed(2)];
      })));
    });
  })();

  /* ═════════ EVENT WIRING ═════════ */
  document.addEventListener("click", function (e) {
    var nav = e.target.closest("[data-view]");
    if (nav) { writeAudit("view.open", { view: nav.getAttribute("data-view") }); showView(nav.getAttribute("data-view")); return; }
    var el = e.target.closest("[data-act]");
    if (!el) return;
    var act = el.getAttribute("data-act"), id = el.getAttribute("data-id");
    if (el.tagName === "TR" && e.target.closest("[data-stop]")) return;       // don't toggle when using the status dropdown
    switch (act) {
      case "product-new": openEditor(null); break;
      case "product-edit": openEditor(id); break;
      case "product-delete": deleteProduct(id); break;
      case "product-save": saveProduct(); break;
      case "product-cancel": closeEditor(); break;
      case "order-toggle":
        var row = document.getElementById("detail-" + id);
        if (row) { row.hidden = !row.hidden; el.firstElementChild.textContent = row.hidden ? "▸" : "▾"; } break;
      case "order-save": saveOrderDelivery(id); break;
      case "order-print": printOrder(id); break;
      case "inv-minus": invAdjust(id, -1); break;
      case "inv-plus": invAdjust(id, 1); break;
      case "inv-save": invSave(id); break;
      case "inv-save-all": invSaveAll(); break;
      case "inv-refresh": loadInventory(); break;
      case "ingredient-add": addIngredient(); break;
      case "ingredient-save": saveIngredient(id); break;
      case "ingredient-delete": deleteIngredient(id); break;
      case "seller-approve": sellerAction(id, true); break;
      case "seller-reject": sellerAction(id, false); break;
      case "pos-add": posAdd(id); break;
      case "pos-plus": posQty(id, 1); break;
      case "pos-minus": posQty(id, -1); break;
      case "pos-remove": posCart = posCart.filter(function (x) { return x.id !== id; }); renderPosReceipt(); break;
      case "pos-charge": posCharge(); break;
      case "pos-receipt-print": printPosReceipt(); break;
      case "pos-receipt-close": closePosReceiptModal(); break;
      case "pos-clear": posCart = []; renderPosReceipt(); break;
      case "conv-open": openConv(id, el.getAttribute("data-email")); break;
      case "reply-send": sendReply(); break;
      case "call-answer": answerCall(id); break;
      case "call-reject": rejectCall(id); break;
      case "call-hangup": hangUp(); break;
      case "refresh": (LOADERS[(location.hash || "#overview").slice(1)] || LOADERS.overview)(); break;
      case "signout":
        MBCore.signOutEverywhere().then(function () { location.replace("index.html"); }); break;
    }
  });
  document.addEventListener("change", function (e) {
    var el = e.target.closest("[data-act]"); if (!el) return;
    var act = el.getAttribute("data-act");
    if (act === "order-status") updateOrderStatus(el.getAttribute("data-id"), el.value);
    if (act === "role") changeRole(el.getAttribute("data-uid"), el.value);
    if (act === "sales-filter") loadSales();
  });
  document.addEventListener("input", function (e) {
    var id = e.target.id;
    if (id === "posSearch") renderPosGrid();
    if (id === "userSearch") renderUsers();
    if (id === "salesSearch") loadSales();
    if (["pfPrice", "pfVatRate", "pfVatType", "pfVatInclusive"].indexOf(id) !== -1) updateVatPreview();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && e.target.id === "adminChatInput") { e.preventDefault(); sendReply(); }
  });

  /* ═════════ BOOT ═════════ */
  MBCore.guardPage({ allow: ALLOW, page: PAGE + ".html" }).then(function (res) {
    ME = res.user; PROFILE = res.profile; ROLE = res.role;

    var boot = $("#dashBoot"); if (boot) boot.hidden = true;
    var app = $("#dashApp"); if (app) app.hidden = false;
    setText("whoName", PROFILE.username || ME.displayName || (ME.email || "").split("@")[0]);
    setText("whoEmail", ME.email || "");

    // Live product list (POS, product list)
    db.ref("mb_products").on("value", function (snap) {
      var v = snap.val() || {};
      PRODUCTS = Object.entries(v).map(function (e) { return Object.assign({ id: e[0] }, e[1]); });
      var vp = $("#view-products"), ed = $("#productEditor");
      if (vp && !vp.hidden && !(ed && !ed.hidden)) renderProductList();
      if ($("#view-pos") && !$("#view-pos").hidden) renderPosGrid();
      if (PAGE === "staff" && $("#view-inventory") && !$("#view-inventory").hidden && !document.activeElement.hasAttribute("data-inv-qty")) loadStaffStock();
    }, function () { toast("Firebase connection failed. Check your RTDB configuration and rules.", true); });

    if (PAGE === "superadmin") loadSuperAdminCard();
    startCallListener();

    var start = (location.hash || "").replace("#", "");
    showView($("#view-" + start) ? start : "overview");
  });
})();
