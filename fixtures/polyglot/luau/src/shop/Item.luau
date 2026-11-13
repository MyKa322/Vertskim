--!strict
local Priced = require("./Priced")

--[=[
	@class Item
	One line of a cart: a thing and how many of it.
]=]
local Item = setmetatable({}, { __index = Priced })
Item.__index = Item

export type Item = typeof(setmetatable({} :: { name: string, cents: number, quantity: number }, Item))

function Item.new(name: string, cents: number, quantity: number?): Item
	local self = setmetatable(Priced.new(cents) :: any, Item)
	self.name = name
	self.quantity = quantity or 1
	return self
end

function Item:price(): number
	return self.cents * self.quantity
end

function Item:label(): string
	return `{self.name} x{self.quantity}: {self:describe()}`
end

return Item
