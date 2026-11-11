package cart

// Total is what the whole cart costs, tax included.
func Total(c *Cart) int {
	return applyTax(c.sum())
}

func (c *Cart) sum() int {
	total := 0
	for _, item := range c.items {
		total += item.Price()
	}
	return total
}

func applyTax(cents int) int {
	return cents + cents*TaxRate/100
}
