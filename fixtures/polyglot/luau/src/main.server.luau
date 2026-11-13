--!strict
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shop = require(ReplicatedStorage.Shop)
local Cart = require(ReplicatedStorage.Shop.Cart)
local Signal = require(ReplicatedStorage.Packages.Signal)
local Account = require("../legacy/account")

local opened = Signal.new()

local function checkout(cart: Cart.Cart): number
	return cart:total()
end

local function greet(player: Player)
  Account.open(player.Name)
	local cart = Cart.new()
	cart:add(Shop.Item.new("pen", 120, 2))
	print(player.Name, checkout(cart))
	opened:Fire(player)
end

Players.PlayerAdded:Connect(greet)
