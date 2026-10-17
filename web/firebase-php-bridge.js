// Maple's Bean — Firebase + PHP data bridge
// Firebase handles authentication/client realtime state.
// PHP handles trusted MySQL sales, inventory and role mutations.

const MapleBridge = (() => {
  const API = window.MAPLESBEAN_PHP_API || 'api.php';

  async function php(action, options = {}) {
    const url = `${API}?action=${encodeURIComponent(action)}`;
    const res = await fetch(url, {
      ...options,
      headers: {'Content-Type':'application/json', ...(options.headers||{})}
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(data.error || 'PHP API error');
    return data;
  }

  async function firebaseUser() {
    if (!window.firebase?.auth) return null;
    return new Promise(resolve => {
      const unsub = firebase.auth().onAuthStateChanged(u => {
        unsub();
        resolve(u || null);
      });
    });
  }

  async function inventory() { return php('inventory'); }
  async function sales() { return php('sales'); }
  async function users() { return php('roles'); }

  async function setRole(userId, role) {
    const u = await firebaseUser();
    if (!u) throw new Error('Please sign in first.');
    return php('set_role', {
      method:'POST',
      body:JSON.stringify({user_id:userId, role})
    });
  }

  async function adjustStock(productId, delta) {
    const u = await firebaseUser();
    if (!u) throw new Error('Please sign in first.');
    return php('adjust_stock', {
      method:'POST',
      body:JSON.stringify({product_id:productId, delta})
    });
  }

  return { php, firebaseUser, inventory, sales, users, setRole, adjustStock };
})();
