package com.acme.billing;

import com.acme.util.Money;
import java.util.ArrayList;
import java.util.List;

/** A bill made of lines. */
public class Invoice implements Payable {
    private final List<Line> lines = new ArrayList<>();

    /** Adds a line for the given amount. */
    public void add(Money amount) {
        lines.add(new Line(amount));
    }

    @Override
    public Money total() {
        Money sum = Money.zero();
        for (Line line : lines) {
            sum = sum.plus(line.amount());
        }
        return sum;
    }

    protected int count() {
        return lines.size();
    }
}
