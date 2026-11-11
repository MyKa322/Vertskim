package cart

// TaxRate is the sales tax, in percent.
const TaxRate = 20

// Pricer is anything with a price in cents.
type Pricer interface {
	Price() int
}

// Item is one line in a cart.
type Item struct {
	Name  string
	Cents int
}

// Price is the item's price before tax.
func (i Item) Price() int {
	return i.Cents
}
