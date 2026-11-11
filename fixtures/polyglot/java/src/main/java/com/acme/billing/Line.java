package com.acme.billing;

import com.acme.util.Money;

/** One entry on an invoice. */
class Line {
    private final Money amount;

    Line(Money amount) {
        this.amount = amount;
    }

    Money amount() {
        return amount;
    }
}
