MAPLE'S BEAN — FIREBASE PRIMARY / PHP MIRROR

Firebase is the source of truth.

1. Login/authentication: Firebase Auth.
2. Roles: Firebase Realtime Database users/{uid}/role.
3. Products/inventory: Firebase mb_products/{productId}.
4. Orders/sales: Firebase orders/{orderId}.
5. Reviews: Firebase reviews/{productId}/{reviewId}.
6. Sellers: Firebase sellers/{uid}.
7. Carts: Firebase carts/{uid}.
8. PHP/MySQL is a mirror for reporting/back-office compatibility.

Sales & Inventory reads and modifies Firebase directly. After a change it calls
api/firebase-sync.php so PHP/MySQL gets the same data.

IMPORTANT PRODUCTION SECURITY:
- Configure Firebase Realtime Database rules so only authenticated users can
  read their account data and only superadmin/admin/staff can perform the
  appropriate management writes.
- Set a Firebase server auth token in config/config.php if PHP cannot read the
  database anonymously.
- For strongest security, replace the legacy REST token with Firebase Admin SDK
  ID-token verification on the PHP sync endpoint.


HYBRID MODE (V10)
- Firebase/Realtime Database is the primary source of truth while reachable.
- The browser warms a PHP session using the Firebase UID while online.
- If Firebase loses connectivity, Sales & Inventory and POS automatically use PHP/MySQL.
- Product data is cached in localStorage as a last-resort display fallback.
- PHP must be reachable from the browser (typically the same XAMPP/live PHP server).
- When Firebase returns, Firebase becomes primary again.

OPERATIONS UPGRADE
- Admin > Products no longer exposes stock quantity; stock is managed only under Admin > Inventory.
- Add/Edit Product includes opening stock, supplier, supplier SKU/contact, inventory location, reorder level, supplier lead time, delivery status/date, and PH VAT settings.
- Admin > Delivery is the buyer-order fulfillment workspace: buyer details, items, VAT, courier, tracking number, ETA, status and printable order details.
- Product VAT defaults to Philippines standard VAT at 12% with VAT-inclusive retail pricing. Zero-rated and VAT-exempt options are available where applicable.
- Firebase Realtime Database remains the browser's primary source of truth. PHP/MySQL is used as the backup path when Firebase operations fail.
- Run database/firebase-primary-migration.sql (or the upgrade section in database/maplesbean.sql) on existing MySQL installations before using the PHP backup path.
