<?php
require_once __DIR__ . '/bootstrap.php';

$method = $_SERVER['REQUEST_METHOD'];
$pdo = db();
$paths = firebase_paths();
$action = $_GET['action'] ?? '';

try {
    switch ($method) {
        case 'GET':
            if ($action === 'me') {
                $user = current_user();
                json_ok($user ?: null);
            }
            json_err('Unknown action', 404);

        case 'POST':
            $body = read_json_body();
            $action = $body['action'] ?? $action;

            if ($action === 'register') {
                handleRegister($pdo, $paths, $body);
            }
            if ($action === 'login') {
                handleLogin($pdo, $body);
            }
            if ($action === 'logout') {
                session_destroy();
                json_ok(['loggedOut' => true]);
            }
            if ($action === 'firebase_sync') {
                handleFirebaseSync($pdo, $paths, $body);
            }
            json_err('Unknown action');

        case 'PUT':
        case 'PATCH':
            handleProfileUpdate($pdo, $paths, read_json_body());
            break;

        default:
            json_err('Method not allowed', 405);
    }
} catch (Throwable $e) {
    json_err($e->getMessage(), 500);
}

function handleRegister(PDO $pdo, array $paths, array $body): void
{
    $username = trim($body['username'] ?? '');
    $email    = trim($body['email'] ?? '');
    $phone    = trim($body['phone'] ?? '');
    $password = $body['password'] ?? '';
    $firebaseUid = $body['firebaseUid'] ?? null;

    if (!$username || !$email || !$password) {
        json_err('Username, email, and password are required');
    }
    if (strlen($password) < 6) {
        json_err('Password must be at least 6 characters');
    }

    $stmt = $pdo->prepare('SELECT id FROM users WHERE email = ?');
    $stmt->execute([$email]);
    if ($stmt->fetch()) {
        json_err('Email already registered');
    }

    $now = (int) (microtime(true) * 1000);
    $hash = password_hash($password, PASSWORD_DEFAULT);

    $stmt = $pdo->prepare('
        INSERT INTO users (firebase_uid, username, email, phone, password_hash, role, loyalty_points, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    ');
    $stmt->execute([$firebaseUid, $username, $email, $phone, $hash, 'customer', $now]);

    $id = (int) $pdo->lastInsertId();
    $stmt = $pdo->prepare('SELECT * FROM users WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    $public = userToPublic($row);

    $_SESSION['user'] = $public;

    syncUserToFirebase($paths, $row);

    json_ok($public, 201);
}

function handleLogin(PDO $pdo, array $body): void
{
    $email    = trim($body['email'] ?? '');
    $password = $body['password'] ?? '';

    if (!$email || !$password) {
        json_err('Email and password required');
    }

    $stmt = $pdo->prepare('SELECT * FROM users WHERE email = ?');
    $stmt->execute([$email]);
    $row = $stmt->fetch();

    if (!$row || !password_verify($password, $row['password_hash'] ?? '')) {
        json_err('Invalid email or password', 401);
    }

    $public = userToPublic($row);
    $_SESSION['user'] = $public;

    json_ok($public);
}

function handleProfileUpdate(PDO $pdo, array $paths, array $body): void
{
    $session = require_auth();
    $username = trim($body['username'] ?? '');
    $phone    = trim($body['phone'] ?? '');

    if (!$username) {
        json_err('Username required');
    }

    $pdo->prepare('UPDATE users SET username = ?, phone = ? WHERE id = ?')
        ->execute([$username, $phone, $session['id']]);

    if (!empty($body['password'])) {
        if (strlen($body['password']) < 6) {
            json_err('Password must be at least 6 characters');
        }
        $hash = password_hash($body['password'], PASSWORD_DEFAULT);
        $pdo->prepare('UPDATE users SET password_hash = ? WHERE id = ?')->execute([$hash, $session['id']]);
    }

    $stmt = $pdo->prepare('SELECT * FROM users WHERE id = ?');
    $stmt->execute([$session['id']]);
    $row = $stmt->fetch();
    $public = userToPublic($row);
    $_SESSION['user'] = $public;

    syncUserToFirebase($paths, $row);

    json_ok($public);
}

function handleFirebaseSync(PDO $pdo, array $paths, array $body): void
{
    $uid      = trim($body['firebaseUid'] ?? '');
    $email    = trim($body['email'] ?? '');
    $username = trim($body['username'] ?? '');
    $phone    = trim($body['phone'] ?? '');

    if (!$uid || !$email) {
        json_err('Firebase uid and email required');
    }

    $stmt = $pdo->prepare('SELECT * FROM users WHERE firebase_uid = ? OR email = ? LIMIT 1');
    $stmt->execute([$uid, $email]);
    $row = $stmt->fetch();

    $now = (int) (microtime(true) * 1000);

    if (!$row) {
        $pdo->prepare('
            INSERT INTO users (firebase_uid, username, email, phone, password_hash, role, loyalty_points, created_at)
            VALUES (?, ?, ?, ?, NULL, ?, 0, ?)
        ')->execute([$uid, $username ?: explode('@', $email)[0], $email, $phone, 'customer', $now]);

        $stmt = $pdo->prepare('SELECT * FROM users WHERE firebase_uid = ?');
        $stmt->execute([$uid]);
        $row = $stmt->fetch();
    } else {
        $pdo->prepare('UPDATE users SET firebase_uid = ?, username = COALESCE(NULLIF(?, ""), username), phone = COALESCE(NULLIF(?, ""), phone) WHERE id = ?')
            ->execute([$uid, $username, $phone, $row['id']]);
        $stmt = $pdo->prepare('SELECT * FROM users WHERE id = ?');
        $stmt->execute([$row['id']]);
        $row = $stmt->fetch();
    }

    $public = userToPublic($row);
    $_SESSION['user'] = $public;
    syncUserToFirebase($paths, $row);

    json_ok($public);
}

function syncUserToFirebase(array $paths, array $row): void
{
    $uid = $row['firebase_uid'] ?: ('mysql_' . $row['id']);
    firebase()->set($paths['users'] . '/' . $uid, [
        'username'      => $row['username'],
        'email'         => $row['email'],
        'phone'         => $row['phone'] ?? '',
        'role'          => $row['role'],
        'loyaltyPoints' => (int) ($row['loyalty_points'] ?? 0),
        'createdAt'     => (int) $row['created_at'],
    ]);
}
