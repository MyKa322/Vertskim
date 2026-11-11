package com.acme.util;

/** An amount in cents. */
public final class Money {
    private final long cents;

    private Money(long cents) {
        this.cents = cents;
    }

    /** No money at all. */
    public static Money zero() {
        return new Money(0);
    }

    public Money plus(Money other) {
        return new Money(cents + other.cents);
    }

    public enum Currency {
        EUR,
        USD
    }
}
