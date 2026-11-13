local ledger = require("legacy.ledger")

-- An account, the way Lua was written before Luau: a global table, no types.
Account = {}
Account.__index = Account

function Account.open(owner)
  local self = setmetatable({}, Account)
  self.owner = owner
  self.balance = 0
  return self
end

function Account:deposit(amount)
  self.balance = self.balance + amount
  ledger.record(self.owner, amount)
end

return Account
