<?php
require_once __DIR__ . '/bootstrap.php';

$method = $_SERVER['REQUEST_METHOD'];
$pdo = db();
$paths = firebase_paths();
$resource = $_GET['resource'] ?? 'stats';

try {
    switch ($resource) {
        case 'stats':
            if ($method !== 'GET') {
                json_err('Method not allowed', 405);
            }
            require_admin();
            json_ok(getStats($pdo));
            break;

        case 'sellers':
            handleSellers($pdo, $paths, $method);
            break;

        case 'inventory':
            handleInventory($pdo, $paths, $method);
            break;

        case 'newsletter':
            handleNewsletter($pdo, $method);
            break;

        default:
            json_err('Unknown resource', 404);
    }
} catch (Throwable $e) {
    json_err($e->getMessage(), 500);
}

function getStats(PDO $pdo): array
{
    $orders = $pdo->query('SELECT total FROM orders')->fetchAll();
    $revenue = array_sum(array_map(fn($o) => (float) $o['total'], $orders));

    return [
        'revenue'  => $revenue,
        'orders'   => count($orders),
        'users'    => (int) $pdo->query('SELECT COUNT(*) FROM users')->fetchColumn(),
        'products' => (int) $pdo->query('SELECT COUNT(*) FROM products')->fetchColumn(),
        'sellers'  => (int) $pdo->query('SELECT COUNT(*) FROM sellers WHERE approved = 1')->fetchColumn(),
    ];
}

function handleSellers(PDO $pdo, array $paths, string $method): void
{
    switch ($method) {
        case 'GET':
            $user = current_user();
            if (($user['role'] ?? '') === 'admin') {
                $stmt = $pdo->query('SELECT s.*, u.email AS user_email FROM sellers s JOIN users u ON u.id = s.user_id ORDER BY s.applied_at DESC');
                $rows = $stmt->fetchAll();
                json_ok(array_map(fn($r) => [
                    'uid'       => 'mysql_' . $r['user_id'],
                    'username'  => $r['username'],
                    'email'     => $r['email'],
                    'approved'  => (bool) $r['approved'],
                    'appliedAt' => (int) $r['applied_at'],
                ], $rows));
            }

            if (!$user) {
                json_err('Authentication required', 401);
            }

            $stmt = $pdo->prepare('SELECT * FROM sellers WHERE user_id = ?');
            $stmt->execute([$user['id']]);
            $row = $stmt->fetch();
            if (!$row) {
                json_ok(null);
            }
            json_ok([
                'uid'       => 'mysql_' . $row['user_id'],
                'username'  => $row['username'],
                'email'     => $row['email'],
                'approved'  => (bool) $row['approved'],
                'appliedAt' => (int) $row['applied_at'],
            ]);
            break;

        case 'POST':
            $user = require_auth();
            $now = (int) (microtime(true) * 1000);
            $pdo->prepare('
                INSERT INTO sellers (user_id, username, email, approved, applied_at)
                VALUES (?, ?, ?, 0, ?)
                ON DUPLICATE KEY UPDATE applied_at = VALUES(applied_at)
            ')->execute([$user['id'], $user['username'], $user['email'], $now]);

            $fbUid = $user['uid'] ?? ('mysql_' . $user['id']);
            firebase()->set($paths['sellers'] . '/' . $fbUid, [
                'username'  => $user['username'],
                'email'     => $user['email'],
                'approved'  => false,
                'appliedAt' => $now,
            ]);

            json_ok(['applied' => true], 201);
            break;

        case 'PATCH':
            require_admin();
            $body = read_json_body();
            $uid = $body['uid'] ?? null;
            $action = $body['action'] ?? 'approve';

            $id = str_starts_with((string) $uid, 'mysql_') ? (int) substr($uid, 6) : null;
            if (!$id) {
                json_err('Invalid seller uid');
            }

            if ($action === 'approve') {
                $pdo->prepare('UPDATE sellers SET approved = 1 WHERE user_id = ?')->execute([$id]);
                $pdo->prepare('UPDATE users SET role = ? WHERE id = ?')->execute(['seller', $id]);
                firebase()->update($paths['sellers'] . '/' . $uid, ['approved' => true]);
                firebase()->update($paths['users'] . '/' . $uid, ['role' => 'seller']);
            } else {
                $pdo->prepare('DELETE FROM sellers WHERE user_id = ?')->execute([$id]);
                $pdo->prepare('UPDATE users SET role = ? WHERE id = ?')->execute(['customer', $id]);
                firebase()->remove($paths['sellers'] . '/' . $uid);
                firebase()->update($paths['users'] . '/' . $uid, ['role' => 'customer']);
            }

            json_ok(['updated' => true]);
            break;

        default:
            json_err('Method not allowed', 405);
    }
}

function handleInventory(PDO $pdo, array $paths, string $method): void
{
    require_admin();

    if ($method === 'GET') {
        $stmt = $pdo->query('SELECT * FROM products ORDER BY stock ASC');
        json_ok(array_map('productFromRow', $stmt->fetchAll()));
    }

    if ($method === 'PATCH') {
        $body = read_json_body();
        $updates = $body['updates'] ?? [];

        foreach ($updates as $id => $stock) {
            $pdo->prepare('UPDATE products SET stock = ? WHERE id = ?')->execute([(int) $stock, $id]);
            $stmt = $pdo->prepare('SELECT * FROM products WHERE id = ?');
            $stmt->execute([$id]);
            if ($row = $stmt->fetch()) {
                firebase()->set($paths['products'] . '/' . $id, productToFirebase($row));
            }
        }

        json_ok(['updated' => count($updates)]);
    }
}

function handleNewsletter(PDO $pdo, string $method): void
{
    if ($method !== 'POST') {
        json_err('Method not allowed', 405);
    }

    $body = read_json_body();
    $email = trim($body['email'] ?? '');
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        json_err('Valid email required');
    }

    $now = (int) (microtime(true) * 1000);
    try {
        $pdo->prepare('INSERT INTO newsletter (email, created_at) VALUES (?, ?)')->execute([$email, $now]);
    } catch (PDOException $e) {
        if ($e->getCode() === '23000') {
            json_ok(['subscribed' => true]);
        }
        throw $e;
    }

    json_ok(['subscribed' => true], 201);
}
