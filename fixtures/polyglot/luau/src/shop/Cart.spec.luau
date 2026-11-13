--!strict
local Cart = require("@shop/Cart")
local Item = require("@shop/Item")

return function()
	describe("Cart", function()
		it("adds up, with tax", function()
			local cart = Cart.new()
			cart:add(Item.new("pen", 100))
			expect(cart:total()).to.equal(120)
		end)
	end)
end
