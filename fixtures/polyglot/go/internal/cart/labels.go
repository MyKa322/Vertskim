package cart

// Labeled is anything with a price and a name to print.
type Labeled interface {
	Pricer
	Label() string
}

// Tagger has a method of the same name, but one that takes a prefix.
type Tagger interface {
	Label(prefix string) string
}

// Label is the item's name as printed on a receipt.
func (i Item) Label() string {
	return i.Name
}
