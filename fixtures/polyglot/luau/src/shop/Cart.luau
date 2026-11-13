--!strict
local Item = require("./Item")
local Tax = require(script.Parent.Support.Tax)

--- A shopping cart: items, and what they cost together.
local Cart = {}
Cart.__index = Cart

export type Cart = typeof(setmetatable({} :: { items: { Item.Item }, last: Item.Item? }, Cart))

function Cart.new(): Cart
	return setmetatable({ items = {} }, Cart)
end

function Cart:add(item: Item.Item): Cart
	table.insert(self.items, item)
	self.last = item
	self:_audit(item:label())
	return self
end

function Cart:subtotal(): number
	local sum = 0
	for _, item in self.items do
		sum += item:price()
	end
	return sum
end

function Cart:total(): number
	return Tax.withTax(self:subtotal())
end

function Cart:lastLabel(): string
	return if self.last then self.last:label() else ""
end

function Cart:_audit(line: string)
	print(line)
end

return Cart
