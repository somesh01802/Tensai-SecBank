<?php
/**
 * Provision an administrator. Server-side CLI only — there is no HTTP route
 * that can grant the ADMIN role, and public registration always creates CUSTOMERs.
 *
 *   php bin/create-admin.php --email=ops.admin@yourbank.com --name="Ops Admin"
 *       Password: taken from the ADMIN_PASSWORD environment variable if set
 *       (min 12 chars), otherwise a strong random one is generated and printed ONCE.
 *   --promote   allow converting an EXISTING customer account into an admin
 *               (off by default: admins should be separate staff accounts).
 *
 * The password is stored only as a bcrypt hash; the action is written to audit_logs.
 */
require __DIR__ . '/../vendor/autoload.php';
if (is_file(__DIR__ . '/../.env')) \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

use Tensai\{Db, Audit};

$o = getopt('', ['email:', 'name:', 'promote']);
$email = strtolower(trim((string) ($o['email'] ?? '')));
$name = trim((string) ($o['name'] ?? 'Administrator'));
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) { fwrite(STDERR, "Usage: php bin/create-admin.php --email=<email> [--name=\"Full Name\"] [--promote]\n"); exit(2); }

$env = getenv('ADMIN_PASSWORD');
$generated = $env === false || $env === '';
$password = $generated ? rtrim(strtr(base64_encode(random_bytes(18)), '+/', '-_'), '=') : $env;
if (strlen($password) < 12) { fwrite(STDERR, "ADMIN_PASSWORD must be at least 12 characters.\n"); exit(2); }
$hash = password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]);

$existing = Db::one('SELECT id, role FROM users WHERE email = :e', [':e' => $email]);
if ($existing) {
    if ($existing['role'] === 'ADMIN') {
        Db::run('UPDATE users SET password_hash = :h, updated_at = now() WHERE id = :id', [':h' => $hash, ':id' => $existing['id']]);
        Audit::log(null, null, 'admin.password_reset', 'user', $existing['id'], ['email' => $email, 'via' => 'cli']);
        $id = $existing['id']; $action = 'password reset';
    } elseif (isset($o['promote'])) {
        Db::run("UPDATE users SET role = 'ADMIN', password_hash = :h, updated_at = now() WHERE id = :id", [':h' => $hash, ':id' => $existing['id']]);
        Audit::log(null, null, 'admin.provisioned', 'user', $existing['id'], ['email' => $email, 'via' => 'cli', 'promoted' => true]);
        $id = $existing['id']; $action = 'promoted to ADMIN';
    } else {
        fwrite(STDERR, "A customer account already uses $email. Use a separate staff email, or pass --promote to convert it.\n");
        exit(1);
    }
} else {
    $row = Db::one("INSERT INTO users (email, name, password_hash, role) VALUES (:e, :n, :h, 'ADMIN') RETURNING id",
        [':e' => $email, ':n' => $name, ':h' => $hash]);
    Audit::log(null, null, 'admin.provisioned', 'user', $row['id'], ['email' => $email, 'via' => 'cli']);
    $id = $row['id']; $action = 'created';
}

echo "[admin] $email $action (id $id)\n";
if ($generated) echo "[admin] generated password (shown once, store it in your password manager): $password\n";
