<?php
require_once __DIR__ . '/bootstrap.php';

$method = $_SERVER['REQUEST_METHOD'];
$pdo = db();
$paths = firebase_paths();

try {
    switch ($method) {
        case 'GET':
            handleGet($pdo);
            break;
        case 'POST':
            handlePost($pdo, $paths);
            break;
        case 'PATCH':
            handlePatch($pdo, $paths);
            break;
        default:
            json_err('Method not allowed', 405);
    }
} catch (Throwable $e) {
    json_err($e->getMessage(), 500);
}

function handleGet(PDO $pdo): void
{
    $user = current_user();
    $id = $_GET['id'] ?? null;

    if ($id) {
        $stmt = $pdo->prepare('SELECT * FROM orders WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        if (!$row) {
            json_err('Order not found', 404);
        }
        if (!$user || (($user['role'] ?? '') !== 'admin' && (int) $row['user_id'] !== (int) $user['id'])) {
            json_err('Forbidden', 403);
        }
        json_ok(formatOrder($row));
    }

    if (in_array(($user['role'] ?? ''), ['staff','admin','superadmin'], true)) {
        $stmt = $pdo->query('SELECT * FROM orders ORDER BY created_at DESC');
    } elseif ($user) {
        $stmt = $pdo->prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC');
        $stmt->execute([$user['id']]);
    } else {
        json_err('Authentication required', 401);
    }

    $orders = array_map('formatOrder', $stmt->fetchAll());
    json_ok($orders);
}

function handlePost(PDO $pdo, array $paths): void
{
    $user = require_auth();
    $body = read_json_body();

    $items = $body['items'] ?? [];
    if (!$items) {
        json_err('Cart is empty');
    }

    $sub = (float) ($body['sub'] ?? 0);
    $total = (float) ($body['total'] ?? 0);
    $payMethod = $body['payMethod'] ?? 'Cash on Delivery';
    $shipping = $body['shipping'] ?? [];
    $vat = $body['vat'] ?? [];
    $delivery = $body['delivery'] ?? [];
    $source = $body['source'] ?? 'web';
    $now = (int) (microtime(true) * 1000);
    $orderId = generateOrderId();

    $stmt = $pdo->prepare('
        INSERT INTO orders (id,user_id,firebase_uid,email,items,subtotal,total,pay_method,shipping,vat,delivery,status,source,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ');
    $stmt->execute([
        $orderId,
        $user['id'],
        $user['uid'] ?? null,
        $user['email'] ?? ($shipping['email'] ?? ''),
        json_encode($items),
        $sub,
        $total,
        $payMethod,
        json_encode($shipping),
        json_encode($vat),
        json_encode($delivery),
        $source === 'POS' ? 'fulfilled' : 'processing',
        $source,
        $now,
    ]);

    foreach ($items as $item) {
        $pid = $item['id'] ?? null;
        $qty = (int) ($item['qty'] ?? 1);
        if (!$pid) {
            continue;
        }
        $pdo->prepare('UPDATE products SET stock = GREATEST(0, stock - ?) WHERE id = ?')->execute([$qty, $pid]);

        $stmt = $pdo->prepare('SELECT * FROM products WHERE id = ?');
        $stmt->execute([$pid]);
        if ($row = $stmt->fetch()) {
            firebase()->set($paths['products'] . '/' . $pid, productToFirebase($row));
        }
    }

    $points = (int) floor($total / 100);
    if ($points > 0) {
        $pdo->prepare('UPDATE users SET loyalty_points = loyalty_points + ? WHERE id = ?')->execute([$points, $user['id']]);
        $stmt = $pdo->prepare('SELECT * FROM users WHERE id = ?');
        $stmt->execute([$user['id']]);
        if ($row = $stmt->fetch()) {
            syncUserFirebase($paths, $row);
            $_SESSION['user'] = userToPublic($row);
        }
    }

    $pdo->prepare('DELETE FROM carts WHERE user_id = ?')->execute([$user['id']]);
    if (!empty($user['uid'])) {
        firebase()->remove($paths['carts'] . '/' . $user['uid']);
    }

    $stmt = $pdo->prepare('SELECT * FROM orders WHERE id = ?');
    $stmt->execute([$orderId]);
    $order = $stmt->fetch();

    firebase()->set($paths['orders'] . '/' . $orderId, orderToFirebase($order));

    json_ok(['order' => formatOrder($order), 'loyaltyPointsEarned' => $points], 201);
}

function handlePatch(PDO $pdo, array $paths): void
{
    require_admin();
    $body = read_json_body();
    $id = $_GET['id'] ?? ($body['id'] ?? null);
    $status = $body['status'] ?? null;
    $delivery = $body['delivery'] ?? null;

    if (!$id) json_err('Order id required');
    if (!$status && $delivery === null) json_err('Order status or delivery data required');

    if ($status) $pdo->prepare('UPDATE orders SET status = ? WHERE id = ?')->execute([$status, $id]);
    if ($delivery !== null) $pdo->prepare('UPDATE orders SET delivery = ? WHERE id = ?')->execute([json_encode($delivery), $id]);

    $stmt = $pdo->prepare('SELECT * FROM orders WHERE id = ?');
    $stmt->execute([$id]);
    $order = $stmt->fetch();

    $fbUpdate = [];
    if ($status) $fbUpdate['status'] = $status;
    if ($delivery !== null) $fbUpdate['delivery'] = $delivery;
    if ($fbUpdate) firebase()->update($paths['orders'] . '/' . $id, $fbUpdate);

    json_ok(formatOrder($order));
}

function formatOrder(array $row): array
{
    return [
        'id'        => $row['id'],
        'items'     => json_decode($row['items'], true) ?: [],
        'total'     => (float) $row['total'],
        'sub'       => (float) $row['subtotal'],
        'payMethod' => $row['pay_method'],
        'shipping'  => json_decode($row['shipping'] ?? '{}', true) ?: [],
        'vat'       => json_decode($row['vat'] ?? '{}', true) ?: [],
        'delivery'  => json_decode($row['delivery'] ?? '{}', true) ?: [],
        'status'    => $row['status'],
        'source'    => $row['source'],
        'user'      => $row['firebase_uid'] ?: ('mysql_' . ($row['user_id'] ?? 'guest')),
        'email'     => $row['email'],
        'createdAt' => (int) $row['created_at'],
    ];
}

function syncUserFirebase(array $paths, array $row): void
{
    $uid = $row['firebase_uid'] ?: ('mysql_' . $row['id']);
    firebase()->update($paths['users'] . '/' . $uid, [
        'loyaltyPoints' => (int) ($row['loyalty_points'] ?? 0),
    ]);
}
