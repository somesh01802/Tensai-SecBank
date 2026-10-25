<?php
// Minimal Elasticsearch stand-in for tests/integration.php (run with `php -S`).
// Behaves as if the tensai-* indices ALREADY exist (like production), records
// every request to $MOCK_ES_LOG as one JSON line, and accepts bulk writes.
$log = getenv('MOCK_ES_LOG') ?: sys_get_temp_dir() . '/mock-es.log';
$method = $_SERVER['REQUEST_METHOD'];
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$body = file_get_contents('php://input');
file_put_contents($log, json_encode(['method' => $method, 'path' => $path, 'body' => $body]) . "\n", FILE_APPEND);
header('Content-Type: application/json');

if ($method === 'PUT' && preg_match('#^/[^/_][^/]*$#', $path)) {   // create index → already exists
    http_response_code(400);
    echo json_encode(['error' => ['type' => 'resource_already_exists_exception', 'reason' => 'index already exists']]);
} elseif ($method === 'PUT' && str_ends_with($path, '/_mapping')) {
    echo '{"acknowledged":true}';
} elseif ($path === '/_bulk') {
    echo '{"errors":false,"items":[]}';
} else {
    http_response_code(404);
    echo '{}';
}
