--!strict
local RATE = 0.2

-- Whole cents only.
local function round(cents: number): number
	return math.floor(cents + 0.5)
end

--- Tax owed on an amount, in cents.
local function owed(cents: number): number
	return round(cents * RATE)
end

local function withTax(cents: number): number
	return cents + owed(cents)
end

return {
	owed = owed,
	withTax = withTax,
}
