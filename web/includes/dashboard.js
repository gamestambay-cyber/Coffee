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

  /* ═════════ SALES HISTORY (staff) ═════════ */
  async function loadSales() {
    var el = $("#salesTable"); if (!el) return;
    try {
      var val = (await db.ref("orders").once("value")).val() || {};
      var q = (($("#salesSearch") || {}).value || "").toLowerCase();
      var f = (($("#salesFilter") || {}).value || "all");
      var rows = Object.entries(val).sort(function (a, b) { return (b[1].createdAt || 0) - (a[1].createdAt || 0); })
        .filter(function (e) {
          var o = e[1];
          return (f === "all" || String(o.source || "web").toUpperCase() === f.toUpperCase()) &&
            (!q || e[0].toLowerCase().indexOf(q) !== -1 || String(o.email || "").toLowerCase().indexOf(q) !== -1);
        }).slice(0, 200);
      el.innerHTML = rows.length ? '<div class="table-wrap"><table class="admin-table"><thead><tr><th>Order</th><th>Channel</th><th>Status</th><th>Payment</th><th>Total</th><th>Date</th></tr></thead><tbody>' +
        rows.map(function (e) {
          var o = e[1];
          return '<tr><td class="mono-muted">' + esc(e[0].slice(-10)) + "</td><td>" + esc(o.source || "web") + '</td><td><span class="status-badge status-' + esc(o.status || "processing") + '">' + esc(o.status || "processing") + "</span></td><td>" + esc(o.payMethod || "Cash") + "</td><td><strong>" + peso(o.total) + '</strong></td><td class="admin-sub">' + fmtDate(o.createdAt) + "</td></tr>";
        }).join("") + "</tbody></table></div>" : '<p class="muted admin-empty">No transactions found.</p>';
    } catch (e) { el.innerHTML = '<p class="muted admin-empty">Could not load sales.</p>'; }
  }

  /* ═════════ INGREDIENT & SUPPLY INVENTORY (Firebase RTDB) ═════════ */
  async function loadInventory() {
    var il=$("#inventoryList"); if(!il)return;
    try {
      var val=(await db.ref("ingredients").once("value")).val()||{};
      var items=Object.entries(val).map(function(e){return Object.assign({id:e[0]},e[1]);});
      setText("invTotalSku",items.length); setText("invInStock",items.filter(function(x){return Number(x.quantity)>0;}).length);
      setText("invLowStock",items.filter(function(x){return Number(x.quantity)>0&&Number(x.quantity)<=Number(x.reorderLevel||0);}).length);
      setText("invSoldOut",items.filter(function(x){return Number(x.quantity)<=0;}).length);
      il.innerHTML=items.length?'<div class="table-wrap"><table class="admin-table"><thead><tr><th>Ingredient / supply</th><th>Category</th><th>Quantity</th><th>Unit</th><th>Reorder at</th><th>Supplier</th><th>Actions</th></tr></thead><tbody>'+items.sort(function(a,b){return Number(a.quantity)-Number(b.quantity);}).map(function(x){return '<tr><td><strong>'+esc(x.name)+'</strong></td><td>'+esc(x.category||"ingredient")+'</td><td><input class="admin-input" style="max-width:100px" type="number" min="0" step="0.01" data-ing-qty="'+esc(x.id)+'" value="'+Number(x.quantity||0)+'"></td><td>'+esc(x.unit||"pcs")+'</td><td>'+Number(x.reorderLevel||0)+'</td><td>'+esc(x.supplier||"—")+'</td><td><button class="admin-link-btn" data-act="ingredient-save" data-id="'+esc(x.id)+'">Save qty</button> <button class="admin-link-btn danger" data-act="ingredient-delete" data-id="'+esc(x.id)+'">Delete</button></td></tr>';}).join('')+'</tbody></table></div>':'<p class="muted admin-empty">No ingredients or supplies yet. Add sugar, milk, cups, straws, and other stock above.</p>';
    } catch(e){il.innerHTML='<p class="muted admin-empty">Could not load ingredients: '+esc(e&&(e.code||e.message)||e)+'. Publish database.rules.json (needs the <code>ingredients</code> node) and make sure your users/&lt;uid&gt;/role is superadmin.</p>';}
  }
  async function addIngredient(){
    var name=( $("#ingName").value||"").trim(); if(!name){toast("Enter an ingredient or supply name",true);return;}
    var item={name:name,category:$("#ingCategory").value,quantity:Math.max(0,Number($("#ingQty").value)||0),unit:($("#ingUnit").value||"pcs").trim(),reorderLevel:Math.max(0,Number($("#ingReorder").value)||0),supplier:($("#ingSupplier").value||"").trim(),createdAt:Date.now(),updatedAt:Date.now(),createdBy:ME.uid};
    try{var r=db.ref("ingredients").push();await r.set(item);await writeAudit("ingredient.create",{id:r.key,name:name,quantity:item.quantity,unit:item.unit});["ingName","ingQty","ingUnit","ingReorder","ingSupplier"].forEach(function(id){$("#"+id).value="";});toast("Ingredient added to Firebase inventory");loadInventory();}
    catch(e){toast("Could not add ingredient: "+(e&&(e.code||e.message)||e),true);}
  }
  async function saveIngredient(id){var input=document.querySelector('[data-ing-qty="'+(window.CSS&&CSS.escape?CSS.escape(id):id)+'"]');if(!input)return;var qty=Math.max(0,Number(input.value)||0);try{await db.ref("ingredients/"+id).update({quantity:qty,updatedAt:Date.now(),updatedBy:ME.uid});await writeAudit("ingredient.update",{id:id,quantity:qty});toast("Ingredient stock saved");loadInventory();}catch(e){toast("Could not save ingredient stock: "+(e&&(e.code||e.message)||e),true);}}
  async function deleteIngredient(id){if(!confirm("Delete this ingredient/supply record?"))return;try{var snap=await db.ref("ingredients/"+id).once("value");await db.ref("ingredients/"+id).remove();await writeAudit("ingredient.delete",{id:id,name:(snap.val()||{}).name||""});toast("Ingredient deleted");loadInventory();}catch(e){toast("Could not delete ingredient: "+(e&&(e.code||e.message)||e),true);}}

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
      case "inv-refresh": loadInventory(); break;
      case "ingredient-add": addIngredient(); break;
      case "ingredient-save": saveIngredient(id); break;
      case "ingredient-delete": deleteIngredient(id); break;
      case "seller-approve": sellerAction(id, true); break;
      case "seller-reject": sellerAction(id, false); break;
      case "pos-add": posAdd(id); break;
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
    }, function () { toast("Firebase connection failed. Check your RTDB configuration and rules.", true); });

    if (PAGE === "superadmin") loadSuperAdminCard();
    startCallListener();

    var start = (location.hash || "").replace("#", "");
    showView($("#view-" + start) ? start : "overview");
  });
})();
