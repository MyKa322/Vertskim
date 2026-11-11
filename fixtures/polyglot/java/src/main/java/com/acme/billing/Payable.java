package com.acme.billing;

import com.acme.util.Money;

/** Something that can be paid. */
public interface Payable {
    /** The amount due. */
    Money total();
}
