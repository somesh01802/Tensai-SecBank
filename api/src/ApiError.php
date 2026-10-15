<?php
namespace Tensai;

/** Typed API error controllers throw; the error handler renders it as { message, ...extra }. */
class ApiError extends \RuntimeException
{
    public int $status;
    public ?array $extra;
    public function __construct(string $message, int $status = 400, ?array $extra = null)
    {
        parent::__construct($message);
        $this->status = $status;
        $this->extra = $extra;
    }
}
