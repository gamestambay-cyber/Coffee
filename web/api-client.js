/**
 * Maple's Bean — Auth & Data Client
 * Uses raw Firebase (Realtime DB + Auth) as the primary backend.
 * PHP/MySQL is a mirror/fallback when Firebase is offline (see script.js).
 */

const MB_API = (() => {
  // ─────────────────────────────────────────────────────────
  // To re-enable PHP/MySQL primary: change `usePhpAsPrimary`
  // to true and ensure your /api/*.php endpoints are reachable.
  // ─────────────────────────────────────────────────────────
  const usePhpAsPrimary = false;

  async function phpPing() {
    try {
      const base = window.location.pathname.replace(/\/[^/]*$/, "") + "/api";
      const res = await fetch(base + "/products.php", { credentials: "include" });
      return res.ok;
    } catch { return false; }
  }

  return {
    available: false,
    usePhpAsPrimary,

    async ping() {
      if (!usePhpAsPrimary) return false;
      return await phpPing();
    },

    getProducts:    () => { throw new Error("PHP disabled — using Firebase directly"); },
    getProduct:     () => { throw new Error("PHP disabled"); },
    createProduct:  () => { throw new Error("PHP disabled"); },
    updateProduct:  () => { throw new Error("PHP disabled"); },
    deleteProduct:  () => { throw new Error("PHP disabled"); },

    getSession:     () => { throw new Error("PHP disabled — using Firebase auth"); },
    register:       () => { throw new Error("PHP disabled — use Firebase auth"); },
    login:          () => { throw new Error("PHP disabled — use Firebase auth"); },
    logout:         () => { throw new Error("PHP disabled"); },
    firebaseSync:   () => { throw new Error("PHP disabled"); },
    updateProfile:  () => { throw new Error("PHP disabled"); },

    getOrders:      () => { throw new Error("PHP disabled"); },
    createOrder:    () => { throw new Error("PHP disabled"); },
    updateOrderStatus: () => { throw new Error("PHP disabled"); },

    getReviews:     () => { throw new Error("PHP disabled"); },
    createReview:   () => { throw new Error("PHP disabled"); },

    getUsers:       () => { throw new Error("PHP disabled"); },
    changeUserRole: () => { throw new Error("PHP disabled"); },
    deleteAccount:  () => { throw new Error("PHP disabled"); },

    getCart:        () => { throw new Error("PHP disabled"); },
    saveCart:       () => { throw new Error("PHP disabled"); },
    clearCart:      () => { throw new Error("PHP disabled"); },

    getStats:       () => { throw new Error("PHP disabled"); },
    getSellers:     () => { throw new Error("PHP disabled"); },
    applySeller:    () => { throw new Error("PHP disabled"); },
    updateSeller:   () => { throw new Error("PHP disabled"); },
    getInventory:   () => { throw new Error("PHP disabled"); },
    saveInventory:  () => { throw new Error("PHP disabled"); },
    subscribeNewsletter: () => { throw new Error("PHP disabled"); },
  };
})();

let phpApiReady = false;

async function initPhpApi() {
  phpApiReady = false; // Firebase-only mode
    void 0;
  return phpApiReady;
}

function usePhpPrimary() {
  return phpApiReady;
}

function syncUserFromSession() {
  // No-op: Firebase auth.onAuthStateChanged handles user state directly.
}
