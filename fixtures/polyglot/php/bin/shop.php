<?php

use Acme\Shop\Cart;
use Acme\Shop\Item;

$cart = Cart::open();
$cart->add(new Item('tea', 300));
echo format_total($cart->total());

function format_total(int $cents): string
{
    return sprintf('%d.%02d', intdiv($cents, 100), $cents % 100);
}
