<?php
require_once __DIR__ . '/bootstrap.php';

$method = $_SERVER['REQUEST_METHOD'];
$pdo = db();
$paths = firebase_paths();

try {
    switch ($method) {
        case 'GET':
            $productId = $_GET['product_id'] ?? null;
            if (!$productId) {
                json_err('product_id required');
            }
            $stmt = $pdo->prepare('SELECT * FROM reviews WHERE product_id = ? ORDER BY created_at DESC LIMIT 20');
            $stmt->execute([$productId]);
            $reviews = array_map(function ($r) {
                return [
                    'id'        => (int) $r['id'],
                    'uid'       => $r['user_id'] ? 'mysql_' . $r['user_id'] : null,
                    'username'  => $r['username'],
                    'rating'    => (int) $r['rating'],
                    'text'      => $r['text'],
                    'createdAt' => (int) $r['created_at'],
                ];
            }, $stmt->fetchAll());
            json_ok($reviews);
            break;

        case 'POST':
            $user = require_auth();
            $body = read_json_body();
            $productId = $body['productId'] ?? null;
            $rating = (int) ($body['rating'] ?? 5);
            $text = trim($body['text'] ?? '');

            if (!$productId || !$text) {
                json_err('Product and review text required');
            }

            $now = (int) (microtime(true) * 1000);
            $username = $user['username'] ?? 'Anonymous';

            $stmt = $pdo->prepare('
                INSERT INTO reviews (product_id, user_id, username, rating, text, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            ');
            $stmt->execute([$productId, $user['id'], $username, $rating, $text, $now]);
            $reviewId = (int) $pdo->lastInsertId();

            $stmt = $pdo->prepare('SELECT AVG(rating) AS avg_r, COUNT(*) AS cnt FROM reviews WHERE product_id = ?');
            $stmt->execute([$productId]);
            $stats = $stmt->fetch();
            $avg = round((float) $stats['avg_r'], 1);
            $cnt = (int) $stats['cnt'];

            $pdo->prepare('UPDATE products SET avg_rating = ?, review_count = ? WHERE id = ?')
                ->execute([$avg, $cnt, $productId]);

            $stmt = $pdo->prepare('SELECT * FROM products WHERE id = ?');
            $stmt->execute([$productId]);
            if ($row = $stmt->fetch()) {
                firebase()->set($paths['products'] . '/' . $productId, productToFirebase($row));
            }

            firebase()->set($paths['reviews'] . '/' . $productId . '/' . $reviewId, [
                'uid'       => $user['uid'] ?? ('mysql_' . $user['id']),
                'username'  => $username,
                'rating'    => $rating,
                'text'      => $text,
                'createdAt' => $now,
            ]);

            json_ok(['id' => $reviewId, 'avgRating' => $avg, 'reviewCount' => $cnt], 201);
            break;

        default:
            json_err('Method not allowed', 405);
    }
} catch (Throwable $e) {
    json_err($e->getMessage(), 500);
}
