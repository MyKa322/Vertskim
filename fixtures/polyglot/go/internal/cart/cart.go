// Package cart holds the items a customer is about to buy.
package cart

// Cart is an ordered list of items.
type Cart struct {
	Audit
	items []Item
}

// Audit counts changes, for carts that embed it.
type Audit struct {
	changes int
}

func (a *Audit) record() {
	a.changes++
}

// New returns an empty cart.
func New() *Cart {
	return &Cart{}
}

// Add puts one more item in the cart.
func (c *Cart) Add(item Item) {
	c.items = append(c.items, item)
	c.record()
}
