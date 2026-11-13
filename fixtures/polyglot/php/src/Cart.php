<?php

declare(strict_types=1);

namespace Acme\Shop;

use Acme\Shop\Support\Tax;
use Psr\Log\LoggerInterface;

/** A basket of items. */
class Cart
{
    /** @var Item[] */
    private array $items = [];

    private Tax $tax;

    public function __construct(private ?LoggerInterface $log = null)
    {
        $this->tax = new Tax();
    }

    /** Puts an item in the basket. */
    public function add(Item $item): self
    {
        $this->items[] = $item;
        $this->audit();
        return $this;
    }

    /** What the basket costs, tax included. */
    public function total(): int
    {
        $sum = 0;
        foreach ($this->items as $item) {
            $sum += $item->price();
        }
        return $this->tax->apply($sum);
    }

    public static function open(): static
    {
        return new static();
    }

    private function audit(): void
    {
    }
}
