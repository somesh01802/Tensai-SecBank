<?php
namespace Tensai;

/** Next scheduled datetime after $from for a frequency (ONCE -> null). */
class Schedule
{
    public static function advance(string $from, string $freq): ?string
    {
        $t = strtotime($from);
        switch ($freq) {
            case 'DAILY':     return date('c', strtotime('+1 day', $t));
            case 'WEEKLY':    return date('c', strtotime('+7 days', $t));
            case 'MONTHLY':   return date('c', strtotime('+1 month', $t));
            case 'QUARTERLY': return date('c', strtotime('+3 months', $t));
            case 'YEARLY':    return date('c', strtotime('+1 year', $t));
            default:          return null; // ONCE
        }
    }
}
