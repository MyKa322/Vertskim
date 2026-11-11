package com.acme.billing;

import com.acme.util.*;

/** An invoice that is charged every month. */
public class RecurringInvoice extends Invoice {
    private static final int MONTHS = 12;

    /** The amount due over a year. */
    public Money yearly() {
        Money sum = Money.zero();
        for (int i = 0; i < MONTHS; i++) {
            sum = sum.plus(super.total());
        }
        return sum;
    }

    public boolean isEmpty() {
        return this.count() == 0;
    }
}
