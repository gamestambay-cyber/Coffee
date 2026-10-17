const $ = s => document.querySelector(s);
const state = {role:'customer', products:[], orders:[], users:[], metrics:{revenue:0,todayRevenue:0,orders:0,lowStock:0,outStock:0}};
let posCart = [];
let loading = false;

const roles = ['staff','admin','superadmin'];

function normalizeRole(v){
  const r=String(v||'customer').toLowerCase().replace(/[ -]/g,'_');
  return r==='super_admin'||r==='superadmin'?'superadmin':['admin','staff','seller','customer'].includes(r)?r:'customer';
}
function peso(v){return '₱'+Number(v||0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});}
function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function fmtDate(v){return v?new Date(Number(v)).toLocaleString('en-PH',{dateStyle:'medium',timeStyle:'short'}):'—';}
function toast(msg, good=true){
  const el=$('#toast'); if(!el)return;
  el.textContent=msg; el.className='toast show '+(good?'good':'bad');
  clearTimeout(window.__toast); window.__toast=setTimeout(()=>el.className='toast',2800);
}
function modal(html){$('#modalBody').innerHTML=html;$('#modal').classList.remove('hidden');}
function closeModal(){$('#modal').classList.add('hidden');}
window.closeModal=closeModal;

async function api(path='api/sales-inventory.php', options={}){
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),9000);
  try{
    const res=await fetch(path,{credentials:'include',cache:'no-store',...options,headers:{'Content-Type':'application/json',...(options.headers||{})},signal:controller.signal});
    const body=await res.json().catch(()=>({}));
    if(!res.ok||body.ok===false) throw new Error(body.error||'Request could not be completed.');
    return body.data??body;
  } finally {clearTimeout(timer);}
}

async function load(){
  if(loading)return; loading=true;
  try{
    const me=await fetch('api/auth.php?action=me',{credentials:'include',cache:'no-store'}).then(r=>r.json());
    const user=me?.data??me;
    state.role=normalizeRole(user?.role);
    if(!roles.includes(state.role)){showDenied('Staff or administrator access is required.');return;}
    $('#app').classList.remove('hidden'); $('#denied').classList.add('hidden');
    $('#shiftRole').textContent=state.role.toUpperCase();
    document.querySelectorAll('.admin-only').forEach(x=>x.classList.toggle('hidden',!['admin','superadmin'].includes(state.role)));
    const d=await api();
    Object.assign(state,d,{role:state.role});
    render();
  }catch(e){
    showDenied('Your session could not be verified. Sign in first, then open this workspace again.');
  }finally{loading=false;}
}
function showDenied(msg){
  $('#app').classList.add('hidden'); $('#denied').classList.remove('hidden');
  $('#deniedMsg').textContent=msg; $('#roleBadge').textContent='ACCESS RESTRICTED'; $('#roleBadge').className='status-chip denied';
}
function render(){
  const m=state.metrics||{};
  $('#roleBadge').textContent=state.role.toUpperCase(); $('#roleBadge').className='status-chip live';
  $('#revenue').textContent=peso(m.revenue); $('#todayRevenue').textContent=peso(m.todayRevenue);
  $('#products').textContent=state.products.length; $('#lowStock').textContent=m.lowStock||0; $('#outStock').textContent=(m.outStock||0)+' out of stock';
  $('#todayOrders').textContent=state.orders.filter(o=>o.createdAt>=new Date(new Date().setHours(0,0,0,0)).getTime()).length+' transactions';
  $('#lastSync').textContent=new Date().toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit'});
  renderInventory(); renderSales(); renderPOS(); renderCatalog(); renderTeam(); renderAlerts(); renderFeed(); updateReceipt();
}
function renderInventory(){
  const q=($('#inventorySearch').value||'').toLowerCase();
  const rows=state.products.filter(p=>String(p.name).toLowerCase().includes(q)).map(p=>`
  <tr><td><b>${esc(p.name)}</b><small>${esc(p.category||'general')}</small></td>
  <td>${peso(p.price)}</td><td class="${p.stock<=0?'out':p.stock<5?'low':''}">${p.stock}</td>
  <td><div class="stock-edit"><input type="number" min="0" value="${p.stock}" data-stock="${esc(p.id)}"><button class="mini-btn" onclick="saveStock('${esc(p.id)}')">Update</button></div></td></tr>`).join('');
  $('#inventoryTable').innerHTML=rows?`<table><thead><tr><th>Product</th><th>Price</th><th>On hand</th><th>Adjust</th></tr></thead><tbody>${rows}</tbody></table>`:'<div class="empty">No matching products.</div>';
}
function renderSales(){
  const q=($('#salesSearch').value||'').toLowerCase(), f=$('#salesFilter').value;
  const rows=state.orders.filter(o=>(f==='all'||String(o.source||'web').toUpperCase()===f.toUpperCase())&&(!q||String(o.id).toLowerCase().includes(q)||String(o.email||'').toLowerCase().includes(q))).slice(0,150).map(o=>`
  <tr><td><b>${esc(o.id)}</b><small>${esc(o.source||'web')}</small></td><td>${esc(o.status||'processing')}</td><td>${esc(o.payMethod||'Cash')}</td><td><b>${peso(o.total)}</b></td><td>${fmtDate(o.createdAt)}</td></tr>`).join('');
  $('#salesTable').innerHTML=rows?`<table><thead><tr><th>Order</th><th>Status</th><th>Payment</th><th>Total</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table>`:'<div class="empty">No transactions found.</div>';
}
function renderCatalog(){
  const el=$('#catalogTable'); if(!el)return;
  el.innerHTML=`<table><thead><tr><th>Product</th><th>Price</th><th>Stock</th><th>Category</th><th></th></tr></thead><tbody>`+
  state.products.map(p=>`<tr><td><b>${esc(p.name)}</b><small>${esc(p.id)}</small></td><td>${peso(p.price)}</td><td>${p.stock}</td><td>${esc(p.category)}</td><td><button class="mini-btn" onclick="editProduct('${esc(p.id)}')">Edit</button> <button class="mini-btn danger" onclick="deleteProduct('${esc(p.id)}')">Delete</button></td></tr>`).join('')+'</tbody></table>';
}
function renderTeam(){
  const el=$('#rolesTable'); if(!el||!['admin','superadmin'].includes(state.role))return;
  const allowed=state.role==='superadmin'?['customer','staff','seller','admin','superadmin']:['customer','staff','seller','admin'];
  el.innerHTML=`<table><thead><tr><th>Team member</th><th>Role</th><th>Joined</th></tr></thead><tbody>`+
  (state.users||[]).map(u=>`<tr><td><b>${esc(u.username)}</b><small>${esc(u.email)}</small></td><td><select onchange="changeRole('${esc(u.id)}',this.value)">${allowed.map(r=>`<option ${normalizeRole(u.role)===r?'selected':''}>${r}</option>`).join('')}</select></td><td>${fmtDate(u.created_at)}</td></tr>`).join('')+'</tbody></table>';
}
function renderAlerts(){
  const low=state.products.filter(p=>p.stock<5).sort((a,b)=>a.stock-b.stock).slice(0,7);
  $('#alertsList').innerHTML=low.length?low.map(p=>`<div class="list-row"><span>${esc(p.name)}</span><b class="${p.stock?'low':''}">${p.stock===0?'OUT':p.stock+' left'}</b></div>`).join(''):'<div class="empty small">Inventory is healthy.</div>';
}
function renderFeed(){
  $('#feedList').innerHTML=state.orders.slice(0,6).map(o=>`<div class="list-row"><span>${esc(o.id)}</span><b>${peso(o.total)}</b></div>`).join('')||'<div class="empty small">No sales yet.</div>';
}
function renderPOS(){
  const q=($('#posSearch').value||'').toLowerCase();
  $('#posGrid').innerHTML=state.products.filter(p=>p.stock>0&&p.name.toLowerCase().includes(q)).map(p=>`
  <button class="pos-card" onclick="addPOS('${esc(p.id)}')"><span>${esc(p.category||'')}</span><strong>${esc(p.name)}</strong><b>${peso(p.price)}</b><small>${p.stock} available</small></button>`).join('')||'<div class="empty">No products available.</div>';
}
function addPOS(id){
  const p=state.products.find(x=>x.id===id); if(!p)return;
  const existing=posCart.find(x=>x.id===id);
  if(existing) existing.qty=Math.min(existing.qty+1,p.stock); else posCart.push({id,qty:1});
  updateReceipt();
}
function updateReceipt(){
  let sub=0;
  $('#receiptItems').innerHTML=posCart.length?posCart.map(i=>{
    const p=state.products.find(x=>x.id===i.id); const line=(p?.price||0)*i.qty; sub+=line;
    return `<div class="receipt-line"><div><b>${esc(p?.name||i.id)}</b><small>${peso(p?.price)} each</small></div><div class="receipt-actions"><button onclick="changePOS('${i.id}',-1)">−</button><b>${i.qty}</b><button onclick="changePOS('${i.id}',1)">+</button><strong>${peso(line)}</strong></div></div>`;
  }).join(''):'<div class="empty">Select products to start.</div>';
  const discount=Math.max(0,Number($('#posDiscount')?.value||0)), tax=Math.max(0,Number($('#posTax')?.value||0)), total=Math.max(0,sub-discount+tax);
  $('#posSubtotal').textContent=peso(sub); $('#posTotal').textContent=peso(total); $('#receiptCount').textContent=posCart.reduce((n,i)=>n+i.qty,0)+' items';
}
function changePOS(id,d){
  const x=posCart.find(i=>i.id===id); if(!x)return;
  const p=state.products.find(i=>i.id===id);
  x.qty=Math.max(0,Math.min(x.qty+d,p?.stock||1));
  if(!x.qty)posCart=posCart.filter(i=>i.id!==id);
  updateReceipt();
}
async function completeSale(){
  if(!posCart.length){toast('Add an item first.',false);return;}
  const btn=$('#completeSale'); btn.disabled=true;
  try{
    const result=await api('api/sales-inventory.php',{method:'POST',body:JSON.stringify({action:'sale',items:posCart,discount:Number($('#posDiscount').value||0),tax:Number($('#posTax').value||0),customer:$('#customerName').value.trim(),payMethod:$('#payMethod').value})});
    toast('Sale '+result.orderId+' completed.');
    posCart=[]; $('#customerName').value=''; $('#posDiscount').value=0; $('#posTax').value=0;
    const d=await api(); Object.assign(state,d); render();
  }catch(e){toast(e.message,false)}finally{btn.disabled=false;}
}
async function saveStock(id){
  const input=document.querySelector(`[data-stock="${CSS.escape(id)}"]`); if(!input)return;
  try{await api('api/sales-inventory.php',{method:'PATCH',body:JSON.stringify({id,stock:Number(input.value||0)})});toast('Inventory updated.');const d=await api();Object.assign(state,d);render();}catch(e){toast(e.message,false);}
}
async function changeRole(id,role){
  if(!confirm('Change this team member to '+role+'?')){renderTeam();return;}
  try{await api('api/sales-inventory.php',{method:'PATCH',body:JSON.stringify({action:'role',uid:id,role})});toast('Role updated.');const d=await api();Object.assign(state,d);render();}catch(e){toast(e.message,false);renderTeam();}
}
function editProduct(id){
  const p=state.products.find(x=>x.id===id); if(!p)return;
  modal(`<span class="eyebrow">CATALOG EDIT</span><h2>Edit product</h2>
  <div class="form-grid"><label>Name<input id="fName" value="${esc(p.name)}"></label><label>Price<input id="fPrice" type="number" step=".01" value="${p.price}"></label><label>Stock<input id="fStock" type="number" value="${p.stock}"></label><label>Category<input id="fCategory" value="${esc(p.category)}"></label></div>
  <div class="modal-actions"><button class="ghost-btn" onclick="closeModal()">Cancel</button><button class="primary-btn" onclick="saveProduct('${esc(id)}')">Save changes</button></div>`);
}
async function saveProduct(id){
  try{await api('api/sales-inventory.php',{method:'PATCH',body:JSON.stringify({action:'product',id,name:$('#fName').value.trim(),price:Number($('#fPrice').value),stock:Number($('#fStock').value),category:$('#fCategory').value.trim()})});closeModal();toast('Product updated.');const d=await api();Object.assign(state,d);render();}catch(e){toast(e.message,false);}
}
function newProduct(){
  modal(`<span class="eyebrow">CATALOG</span><h2>New product</h2><div class="form-grid"><label>Name<input id="fName" placeholder="Product name"></label><label>Price<input id="fPrice" type="number" step=".01" value="0"></label><label>Stock<input id="fStock" type="number" value="0"></label><label>Category<input id="fCategory" value="general"></label></div><div class="modal-actions"><button class="ghost-btn" onclick="closeModal()">Cancel</button><button class="primary-btn" onclick="createProduct()">Create product</button></div>`);
}
async function createProduct(){
  try{await api('api/sales-inventory.php',{method:'POST',body:JSON.stringify({action:'product',name:$('#fName').value.trim(),price:Number($('#fPrice').value),stock:Number($('#fStock').value),category:$('#fCategory').value.trim()})});closeModal();toast('Product created.');const d=await api();Object.assign(state,d);render();}catch(e){toast(e.message,false);}
}
async function deleteProduct(id){
  if(!confirm('Delete this product from the catalog?'))return;
  try{await api('api/sales-inventory.php?id='+encodeURIComponent(id),{method:'DELETE'});toast('Product deleted.');const d=await api();Object.assign(state,d);render();}catch(e){toast(e.message,false);}
}
window.saveStock=saveStock;window.changeRole=changeRole;window.editProduct=editProduct;window.saveProduct=saveProduct;window.newProduct=newProduct;window.createProduct=createProduct;window.deleteProduct=deleteProduct;window.addPOS=addPOS;window.changePOS=changePOS;

$('#inventorySearch').addEventListener('input',renderInventory);
$('#posSearch').addEventListener('input',renderPOS);
$('#salesSearch').addEventListener('input',renderSales);
$('#salesFilter').addEventListener('change',renderSales);
$('#posDiscount').addEventListener('input',updateReceipt); $('#posTax').addEventListener('input',updateReceipt);
$('#completeSale').addEventListener('click',completeSale);
$('#clearSale').addEventListener('click',()=>{posCart=[];updateReceipt();});
$('#newProductBtn')?.addEventListener('click',newProduct);
$('#refreshBtn')?.addEventListener('click',load); $('#refreshBtn2')?.addEventListener('click',load); $('#retryBtn')?.addEventListener('click',load);
$('#logoutBtn')?.addEventListener('click',async()=>{try{await fetch('api/auth.php',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'logout'})});}finally{location.href='index.php';}});
setInterval(()=>{const now=new Date();$('#clock').textContent=now.toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit'});$('#todayLabel').textContent=now.toLocaleDateString('en-PH',{weekday:'long',month:'long',day:'numeric',year:'numeric'});},1000);
load();
