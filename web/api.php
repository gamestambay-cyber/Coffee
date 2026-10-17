<?php
// Maple's Bean — PHP API bridge
// Uses PDO/MySQL when configured. Firebase Admin SDK can be used by the
// frontend for authentication/realtime sync; PHP remains the trusted
// server-side sales/inventory endpoint.

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, OPTIONS');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit; }

$host = getenv('DB_HOST') ?: '127.0.0.1';
$db   = getenv('DB_NAME') ?: 'maplesbean';
$user = getenv('DB_USER') ?: 'root';
$pass = getenv('DB_PASS') ?: '';
$dsn  = "mysql:host=$host;dbname=$db;charset=utf8mb4";

function out($data, $code=200) {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    $pdo = new PDO($dsn, $user, $pass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC
    ]);
} catch (Throwable $e) {
    out(['ok'=>false,'error'=>'Database connection failed'], 500);
}

$action = $_GET['action'] ?? ($_POST['action'] ?? '');

try {
    if ($action === 'inventory') {
        $rows = $pdo->query("SELECT * FROM products ORDER BY name ASC")->fetchAll();
        out(['ok'=>true,'items'=>$rows]);
    }

    if ($action === 'sales') {
        $rows = $pdo->query("SELECT * FROM orders ORDER BY created_at DESC LIMIT 100")->fetchAll();
        out(['ok'=>true,'sales'=>$rows]);
    }

    if ($action === 'roles') {
        $rows = $pdo->query("SELECT id,email,name,role FROM users ORDER BY name ASC")->fetchAll();
        out(['ok'=>true,'users'=>$rows]);
    }

    if ($action === 'set_role' && $_SERVER['REQUEST_METHOD'] !== 'GET') {
        $payload = json_decode(file_get_contents('php://input'), true) ?: $_POST;
        $allowed = ['admin','staff','customer'];   // never 'superadmin': only one exists
        $role = $payload['role'] ?? '';
        $id = $payload['user_id'] ?? '';
        if (!$id || !in_array($role, $allowed, true)) out(['ok'=>false,'error'=>'Invalid role'],400);

        $stmt=$pdo->prepare("UPDATE users SET role=? WHERE id=?");
        $stmt->execute([$role,$id]);
        out(['ok'=>true]);
    }

    if ($action === 'adjust_stock' && $_SERVER['REQUEST_METHOD'] !== 'GET') {
        $payload=json_decode(file_get_contents('php://input'),true) ?: $_POST;
        $id=$payload['product_id'] ?? '';
        $delta=(int)($payload['delta'] ?? 0);
        $stmt=$pdo->prepare("UPDATE products SET stock=GREATEST(0,stock+?) WHERE id=?");
        $stmt->execute([$delta,$id]);
        out(['ok'=>true]);
    }

    out(['ok'=>false,'error'=>'Unknown action'],404);
} catch (Throwable $e) {
    out(['ok'=>false,'error'=>'Server error'],500);
}
?>
