<?php
namespace Tensai;

/** Demo bill-provider adapter (isolated stand-in; no external calls). */
class BillProvider
{
    private const RANGES = [
        'PHONE' => [200, 1000], 'CREDIT_CARD' => [500, 25000], 'EMI' => [1000, 20000],
        'STREAMING' => [149, 799], 'ELECTRICITY' => [200, 6000], 'INTERNET' => [499, 1999],
        'FUEL' => [500, 6000], 'WATER' => [150, 1500], 'GAS' => [400, 1500], 'OTHER' => [100, 5000],
    ];

    public static function fetchAmount(string $billerName, string $category): array
    {
        [$lo, $hi] = self::RANGES[$category] ?? self::RANGES['OTHER'];
        $key = "$category:$billerName";
        $h = 0;
        for ($i = 0, $len = strlen($key); $i < $len; $i++) $h = (($h * 31) + ord($key[$i])) & 0x7fffffff;
        $amt = $lo + ($h % ($hi - $lo));
        return ['source' => 'demo-provider', 'amount' => round($amt, 2), 'currency' => 'USD', 'fetchedAt' => date('c')];
    }
}
