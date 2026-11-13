<?php

namespace Acme\Shop;

/** Anything with a price in cents. */
interface Priced
{
    public function price(): int;
}
