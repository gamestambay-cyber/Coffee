MAPLE'S BEAN — FIREBASE + PHP

Architecture:
- Firebase: authentication and client-side realtime state.
- PHP/PDO: trusted server-side MySQL access for sales, inventory and role changes.
- MySQL remains the authoritative business database for inventory/sales.
- Firebase UID is linked to users.firebase_uid.

Setup:
1. Put api.php on the same PHP server as the website.
2. Set DB_HOST, DB_NAME, DB_USER and DB_PASS in the PHP environment.
3. Run database_firebase_php.sql against the existing MySQL database.
4. Load firebase-php-bridge.js after Firebase is initialized.
5. Set window.MAPLESBEAN_PHP_API if api.php is hosted elsewhere.
6. Keep Firebase Admin credentials server-side only if you add Firebase Admin SDK verification.
7. Do not trust role values sent by the browser; PHP should verify the authenticated Firebase UID
   and role before production mutations. The supplied bridge provides the endpoint structure.
