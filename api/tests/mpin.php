<?php
// Shared by the API test suites: the MPIN every test user sets, sent on the routes that need step-up (VAPT-05).
const TEST_MPIN = '481526';
const STEP_UP = '#^/(transactions|beneficiaries|payees|autopay|recurring-bills|transfer/(quick|scheduled)|bills/[^/]+/pay|cards/[^/]+/(pay|reveal)|profile)$#';

function withMpin(string $method, string $path, ?array $body): ?array
{
    if ($method === 'GET' || !preg_match(STEP_UP, strtok($path, '?')) || array_key_exists('mpin', (array) $body)) return $body;
    return (array) $body + ['mpin' => TEST_MPIN];
}
