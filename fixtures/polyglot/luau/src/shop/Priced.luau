--!strict

--- Anything that has a price.
local Priced = {}
Priced.__index = Priced

export type Priced = typeof(setmetatable({} :: { cents: number }, Priced))

function Priced.new(cents: number): Priced
	return setmetatable({ cents = cents }, Priced)
end

function Priced:price(): number
	return self.cents
end

function Priced:describe(): string
	return `{self:price()} cents`
end

return Priced
