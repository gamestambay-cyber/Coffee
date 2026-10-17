<?php
require_once __DIR__ . '/bootstrap.php';

$method = $_SERVER['REQUEST_METHOD'];
$pdo = db();
$paths = firebase_paths();

try {
    switch ($method) {
        case 'GET':
            $user = require_auth();
            $stmt = $pdo->prepare('SELECT * FROM carts WHERE user_id = ?');
            $stmt->execute([$user['id']]);
            $row = $stmt->fetch();
            if (!$row) {
                json_ok(null);
            }
            json_ok([
                'items'     => json_decode($row['items'], true) ?: [],
                'updatedAt' => (int) $row['updated_at'],
                'email'     => $row['email'],
            ]);
            break;

        case 'POST':
        case 'PUT':
            $user = require_auth();
            $body = read_json_body();
            $items = $body['items'] ?? [];
            $now = (int) (microtime(true) * 1000);

            $pdo->prepare('
                INSERT INTO carts (user_id, items, email, updated_at)
                VALUES (?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE items = VALUES(items), email = VALUES(email), updated_at = VALUES(updated_at)
            ')->execute([$user['id'], json_encode($items), $user['email'] ?? '', $now]);

            $fbUid = $user['uid'] ?? ('mysql_' . $user['id']);
            firebase()->set($paths['carts'] . '/' . $fbUid, [
                'items'     => $items,
                'updatedAt' => $now,
                'email'     => $user['email'] ?? '',
            ]);

            json_ok(['saved' => true]);
            break;

        case 'DELETE':
            $user = require_auth();
            $pdo->prepare('DELETE FROM carts WHERE user_id = ?')->execute([$user['id']]);
            $fbUid = $user['uid'] ?? ('mysql_' . $user['id']);
            firebase()->remove($paths['carts'] . '/' . $fbUid);
            json_ok(['deleted' => true]);
            break;

        default:
            json_err('Method not allowed', 405);
    }
} catch (Throwable $e) {
    json_err($e->getMessage(), 500);
}
