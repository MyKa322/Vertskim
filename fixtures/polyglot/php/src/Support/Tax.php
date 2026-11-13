<?php

namespace Acme\Shop\Support;

/** Sales tax. */
class Tax
{
    public const RATE = 20;

    public function apply(int $cents): int
    {
        return intdiv($cents * (100 + self::RATE), 100);
    }
}
