<?php

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../includes/FirebaseBackup.php';

$appConfig = require __DIR__ . '/../config/config.php';

session_name($appConfig['app']['session_name']);
if (session_status() === PHP_SESSION_NONE) {
    session_start();
}

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: ' . ($_SERVER['HTTP_ORIGIN'] ?? '*'));
header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Access-Control-Allow-Credentials: true');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function json_ok($data = null, int $code = 200): void
{
    http_response_code($code);
    echo json_encode(['ok' => true, 'data' => $data], JSON_UNESCAPED_UNICODE);
    exit;
}

function json_err(string $message, int $code = 400): void
{
    http_response_code($code);
    echo json_encode(['ok' => false, 'error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

function read_json_body(): array
{
    $raw = file_get_contents('php://input');
    if (!$raw) {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function current_user(): ?array
{
    return $_SESSION['user'] ?? null;
}

function require_auth(?string $role = null): array
{
    $user = current_user();
    if (!$user) {
        json_err('Authentication required', 401);
    }
    if ($role !== null && ($user['role'] ?? 'customer') !== $role && !in_array(($user['role'] ?? ''), ['admin','superadmin'], true)) {
        json_err('Forbidden', 403);
    }
    return $user;
}

function require_admin(): array
{
    $user = require_auth();
    if (!in_array(($user['role'] ?? ''), ['admin','superadmin'], true)) {
        json_err('Admin access required', 403);
    }
    return $user;
}

function firebase_paths(): array
{
    static $paths = null;
    if ($paths === null) {
        $cfg = require __DIR__ . '/../config/config.php';
        $paths = $cfg['firebase']['paths'];
    }
    return $paths;
}

function require_management(): array
{
    $user = require_auth();
    if (!in_array(($user['role'] ?? ''), ['staff','admin','superadmin'], true)) {
        json_err('Sales and inventory access required', 403);
    }
    return $user;
}
