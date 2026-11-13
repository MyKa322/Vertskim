<?php

namespace Acme\Shop;

/** One product and its price in cents. */
final class Item implements Priced
{
    public function __construct(private string $name, private int $cents)
    {
    }

    public function price(): int
    {
        return $this->cents;
    }
}
