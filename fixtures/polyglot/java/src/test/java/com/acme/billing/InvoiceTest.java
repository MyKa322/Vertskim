package com.acme.billing;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.acme.util.Money;
import org.junit.jupiter.api.Test;

class InvoiceTest {
    @Test
    void totalsItsLines() {
        Invoice invoice = new Invoice();
        invoice.add(Money.zero());
        assertEquals(1, invoice.count());
        invoice.total();
    }
}
